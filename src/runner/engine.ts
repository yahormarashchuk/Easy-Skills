import { join } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Run, TaskState, Task, Stage, StageResult, Evidence, PullRequest } from '../contracts.js';
import { VERSION, Plan } from '../contracts.js';
import { Store, ResourceBusy } from '../persistence/store.js';
import { CliClient, ClientError, classify, type Client } from '../adapters/index.js';
import { Git } from '../git/index.js';
import { Gh, MergeTerminalError, type GitHub } from '../github/index.js';
import { execute } from '../process.js';
import { alive, ensureDir, hash, message, now, redact, rulesHash } from '../util.js';
import { assembleContext, type ContextManifest } from './context.js';
import { recordFailure, confirmedProgress } from './failures.js';
import { requireCompatibility } from './compatibility.js';
import { CheckFailure, failureBundle } from './check-failure.js';
import { requireAgreement } from './onboarding.js';
import { assertProtected } from './protected-inputs.js';
import { CodeFailure, startRepair, pendingRepair, completeRepair, repairKey, type Repair } from './repairs.js';
import { ownerAlive, processIdentity } from '../process-identity.js';
import { ignoredOutputs } from './setup-outputs.js';

class Blocked extends Error {}
export interface EngineOptions {client?: Client; github?: GitHub; signal?: AbortSignal; testRemote?: string}
export class Engine {
  readonly client: Client;
  constructor(readonly store: Store, readonly options: EngineOptions = {}) {this.client = options.client || new CliClient();}
  private git(run: Run) {return new Git(run.root, operation => this.store.withLock('repository:' + run.commonDir, operation),
    {repository: run.plan.project.repository, testRemote: this.options.testRemote});}
  private async guard(run: Run, cwd: string) {
    const state = run.tasks.find(t => t.worktree === cwd), branch = state?.branch || run.branch;
    const git = this.git(run);
    const intent = this.store.operation<{path: string; branch: string}>(`${run.id}:worktree:${state?.id || 'integration'}`);
    if (!intent || realpathSync.native(intent.path) !== realpathSync.native(cwd) || intent.branch !== branch) throw new Blocked('Worktree owner or path differs from persisted intent');
    await git.assertOwned(cwd, branch, join(this.store.home, 'worktrees', run.id));
    if (rulesHash(cwd) !== run.plan.rulesHash) throw new Blocked('Worktree instructions or client configuration changed; preserve changes and review a replacement plan');
    if (!run.plan.protectedInputs) throw new Blocked('Legacy plan lacks approved protected verification inputs');
    try {assertProtected(cwd, run.plan.project, run.plan.protectedInputs);} catch (error) {throw new Blocked(message(error));}
  }
  approve(id: string, expectedHash: string): Run {
    const run = this.store.get(id);
    if (run.status !== 'draft') throw new Error('Only a draft can be approved');
    Plan.parse(run.plan);
    if (run.plan.schemaVersion !== 2 || run.plan.runnerVersion !== VERSION) throw new Error('Legacy plan requires a replacement approval under contract v2');
    if (run.plan.assignments.VERIFY.provider === 'codex' && run.plan.verification?.browserTools.length)
      throw new Error('This Codex adapter cannot enforce named MCP grants; choose supported capabilities in a new plan without changing providers automatically');
    if (run.planHash !== expectedHash || hash(run.plan) !== expectedHash) throw new Error('Approval must match the exact reviewed plan hash');
    assertProtected(run.root, run.plan.project, run.plan.protectedInputs!);
    if (rulesHash(run.root) !== run.plan.rulesHash) throw new Error('Project rules changed; prepare a new plan');
    if (!run.plan.rulesAgreement) throw new Error('Plan lacks an explicit rules agreement; complete onboarding and review a replacement plan');
    requireAgreement(run.root, run.plan.rulesAgreement);
    run.approvedHash = expectedHash; run.status = 'approved';
    this.store.save(run, 'plan.approved', {hash: expectedHash}); return run;
  }
  requestControl(id: string, action: 'pause' | 'stop') {
    this.store.get(id);
    this.store.recordOperation(`${id}:control`, id, 'control', {action});
    this.store.event(id, 'control.requested', {action});
  }
  private checkpoint(run: Run): void {
    if (this.options.signal?.aborted) throw new Blocked('Runner interrupted at a safe checkpoint');
    const control = this.store.operation<{action?: 'pause' | 'stop'}>(`${run.id}:control`);
    if (control?.action) {
      run.status = control.action === 'pause' ? 'paused' : 'stopped';
      this.store.recordOperation(`${run.id}:control`, run.id, 'control', {});
      throw new Blocked(control.action + ' requested; stopped at a safe checkpoint');
    }
    if (run.plan.runnerVersion !== VERSION || run.plan.skillsVersion !== VERSION || run.plan.schemaVersion !== 2) throw new Blocked('Legacy execution policy requires a newly reviewed contract v2 plan; preserve the old run');
    if (run.approvedHash !== run.planHash || hash(run.plan) !== run.planHash) throw new Blocked('Plan lacks a matching approval');
    if (rulesHash(run.root) !== run.plan.rulesHash) throw new Blocked('Project rules changed; a revised plan needs approval');
    if (!run.plan.rulesAgreement) throw new Blocked('Legacy plan lacks a rules agreement; complete onboarding and review a replacement plan');
    requireAgreement(run.root, run.plan.rulesAgreement);
  }
  async run(id: string): Promise<Run> {
    const observed = this.store.get(id);
    const finalIntent = observed.finalPr && observed.finalReviewHead ? this.store.operation<{state: string}>(`${id}:merge:${observed.finalPr.number}:${observed.finalReviewHead}`) : undefined;
    if (observed.status === 'ready' || (observed.status === 'needs_decision' && finalIntent && ['pending', 'enqueued', 'executing', 'uncertain', 'merged'].includes(finalIntent.state))) return this.reconcileFinalMerge(id);
    const owner = this.store.acquire('run:' + id);
    const run = this.store.get(id);
    const git = this.git(run);
    const github = this.options.github || new Gh(run.plan.project.repository, run.root);
    try {
      if (['draft', 'stopped', 'merged', 'ready', 'abandoned'].includes(run.status)) throw new Error('Run cannot execute from status ' + run.status);
      this.checkpoint(run);
      if (ownerAlive(run.childPid, run.childIdentity)) throw new Blocked(`Recorded child PID ${run.childPid} is still alive; reconcile it before resuming`);
      run.childPid = undefined; run.childStartedAt = undefined;
      const next = run.tasks.find(t => !t.integrated)?.cursor || run.finalPhase;
      if (next !== 'INTEGRATE' && next !== 'SYNC') await requireCompatibility(this.store, this.client, run.plan.assignments[next === 'REPAIR' ? 'BUILD' : next], run.root);
      if (!run.tasks.some(t => t.head || Object.keys(t.sessions).length)) {
        const seen = new Set<string>();
        for (const stage of ['BUILD', 'VERIFY', 'REVIEW', 'SHIP'] as const) {
          const assignment = run.plan.assignments[stage], key = hash(assignment);
          if (!seen.has(key)) {await requireCompatibility(this.store, this.client, assignment, run.root); seen.add(key);}
        }
      }
      const identity = await git.identity();
      if (identity.commonDir !== run.commonDir) throw new Blocked('Repository identity changed');
      await git.validateRemotes();
      run.status = 'running'; run.reason = undefined; run.retryAt = undefined; run.stopReason = undefined;
      this.store.save(run, 'run.started');
      await this.prepare(run, git, github);
      if (this.store.operation<{pending: boolean}>(`${id}:manual-sync`)?.pending) {
        await this.sync(run, run.worktree!, `origin/${run.plan.project.mainBranch}`, git);
        run.finalPhase = 'VERIFY'; run.finalReviewHead = undefined; run.finalEvidence = [];
        this.store.recordOperation(`${id}:manual-sync`, id, 'manual.sync', {pending: false});
        this.store.save(run, 'manual.sync.recovered');
      }
      while (run.tasks.some(t => !t.integrated)) {
        this.checkpoint(run);
        const task = run.plan.tasks.find(t => !run.tasks.find(s => s.id === t.id)!.integrated &&
          t.dependsOn.every(dep => run.tasks.find(s => s.id === dep)!.integrated));
        if (!task) throw new Blocked('No task has satisfied integration dependencies');
        const state = run.tasks.find(t => t.id === task.id)!;
        await this.task(run, state, task, git, github);
      }
      await this.finish(run, git, github);
    } catch (error) {
      if (run.status === 'draft' || run.status === 'merged' || run.status === 'ready' || run.status === 'abandoned') throw error;
      const detail = redact(message(error));
      run.reason = detail;
      run.stopReason = error instanceof ResourceBusy ? 'resource_busy' : error instanceof ClientError ? error.kind : error instanceof Blocked ? 'decision' : 'protocol';
      if (error instanceof ResourceBusy || (error instanceof ClientError && ['quota', 'network', 'waiting_ci', 'waiting_merge'].includes(error.kind))) {
        run.status = error instanceof ResourceBusy ? 'waiting_resource' : error.kind === 'quota' ? 'waiting_quota' : 'waiting_external';
        const key = `${run.id}:backoff`;
        const attempt = (this.store.operation<number>(key) || 0) + 1;
        this.store.recordOperation(key, run.id, 'backoff', attempt);
        run.retryAt = (error instanceof ClientError ? error.retryAt : undefined) || new Date(Date.now() + (error instanceof ResourceBusy ? 2000 : Math.min(60_000 * 2 ** Math.min(attempt - 1, 8), 4 * 60 * 60_000))).toISOString();
      } else if (!['paused', 'stopped'].includes(run.status)) run.status = 'needs_decision';
      this.store.save(run, 'run.suspended', {reason: detail, status: run.status});
      this.store.enqueue(`${run.id}:${hash({status: run.status, reason: detail, head: run.tasks.map(t => t.head)})}`,
        {runId: run.id, project: run.plan.project.name, feature: run.plan.title, state: run.status, reason: detail.slice(0, 700),
          url: run.finalPr?.url || (run.parentIssue ? `https://github.com/${run.plan.project.repository}/issues/${run.parentIssue}` : undefined)});
    } finally {this.store.release('run:' + id, owner);}
    return run;
  }
  private async ownedWorktree(run: Run, git: Git, branch: string, base: string, name: string): Promise<string> {
    const path = join(ensureDir(join(this.store.home, 'worktrees', run.id)), name);
    const key = `${run.id}:worktree:${name}`;
    const intent = this.store.operation<{path: string; branch: string}>(key);
    if (!intent) {
      if (await git.branchExists(branch) || existsSync(path)) throw new Blocked('Branch or path already exists and is not owned by this run');
      this.store.recordOperation(key, run.id, 'worktree.intent', {path, branch});
    }
    return git.worktree(branch, base, path, !!intent);
  }
  private async prepare(run: Run, git: Git, github: GitHub) {
    await git.fetch();
    if (!run.worktree) {
      run.worktree = await this.ownedWorktree(run, git, run.branch, `origin/${run.plan.project.mainBranch}`, 'integration');
      this.store.save(run, 'integration.created');
    }
    await this.guard(run, run.worktree);
    await this.setup(run, git, run.worktree);
    if (!this.store.operation(`${run.id}:baseline`)) {
      // Older alpha runs may already contain implementation: never label that state a baseline.
      if (run.tasks.some(t => t.head || Object.keys(t.sessions).length)) {
        this.store.recordOperation(`${run.id}:baseline`, run.id, 'baseline.legacy', {status: 'unavailable_legacy', reason: 'Implementation predates baseline capture'});
        throw new Blocked('Legacy run has no original baseline; preserve it and review a replacement plan from the original base');
      }
      const head = await git.head(run.worktree);
      const results = await this.checks(run, git, run.worktree, true);
      this.store.recordOperation(`${run.id}:baseline`, run.id, 'baseline.captured', {head, commands: run.plan.project.checks, results,
        status: results.every(r => r.code === 0) ? 'passed' : results.some(r => r.code === -1 || r.code === 127) ? 'unavailable' : 'pre_existing_failure'});
    }
    const baseline = this.store.operation<{status: string}>(`${run.id}:baseline`)!;
    if (baseline.status !== 'passed') throw new Blocked(`Baseline ${baseline.status}; resolve or explicitly replan the existing problem before feature implementation`);
    if (!run.plan.permissions.publishIssues) throw new Blocked('Publishing Issues and PRs is not authorized by this plan');
    if (!run.parentIssue) {
      run.parentIssue = await github.issue(`${run.id}:feature`, run.plan.title, run.plan.spec);
      this.store.save(run, 'github.parent.created');
    }
    const published = await git.remoteHead(run.branch);
    if (published) {
      const behind = await execute({command: 'git', args: ['merge-base', '--is-ancestor', 'HEAD', published]}, {cwd: run.worktree});
      if (behind.code === 0) {await git.clean(run.worktree); await git.run(['merge', '--ff-only', published], run.worktree);}
      else if (behind.code !== 1) throw new Blocked('Cannot reconcile the published integration branch');
    }
    await git.push(run.branch, run.worktree);
    for (const task of run.plan.tasks) {
      const state = run.tasks.find(t => t.id === task.id)!;
      if (!state.issue) {
        state.issue = await github.issue(`${run.id}:task:${task.id}`, task.title,
          `${task.description}\n\nAcceptance:\n${task.acceptance.map(a => '- ' + a).join('\n')}\n\nDependencies: ${task.dependsOn.join(', ') || 'none'}\n\nParent: #${run.parentIssue}\nApproved plan: ${run.planHash}`);
        this.store.save(run, 'github.task.created', {task: task.id, issue: state.issue});
      }
    }
  }
  private async setup(run: Run, git: Git, cwd: string) {
    const key = `${run.id}:setup:${hash(cwd)}`, fingerprint = hash({commands: run.plan.project.setup || [], inputs: run.plan.protectedInputs});
    const prior = this.store.operation<{fingerprint: string; status: string}>(key);
    if (prior?.status === 'passed' && prior.fingerprint === fingerprint) return;
    if (prior && !['passed', 'approved_retry'].includes(prior.status)) throw new Blocked('Setup was interrupted or failed; inspect its log and explicitly reset setup before retrying');
    const beforeOutputs = await ignoredOutputs(git, cwd);
    this.store.recordOperation(key, run.id, 'setup.started', {fingerprint, status: 'running'});
    for (const command of run.plan.project.setup || []) {
      const lock = command.resource ? this.store.acquire('environment:' + command.resource) : undefined;
      try {
        run.activeResource = command.resource;
        const result = await execute(command, {cwd, role: 'project', timeoutMs: command.timeoutMs, signal: this.options.signal,
          onSpawn: pid => {run.childPid = pid; run.childStartedAt = now(); run.childIdentity = processIdentity(pid); this.store.save(run, 'setup.child.started', {pid, command: command.id});},
          log: join(ensureDir(join(this.store.home, 'logs', run.id)), `setup-${command.id}-${Date.now()}.log`)});
        await this.guard(run, cwd);
        if (result.code) {this.store.recordOperation(key, run.id, 'setup.failed', {fingerprint, status: 'failed', command: command.id, code: result.code}); throw new Blocked('Approved setup failed: ' + command.id);}
      } finally {
        if (!ownerAlive(run.childPid, run.childIdentity)) {
          run.childPid = undefined; run.childIdentity = undefined; run.childStartedAt = undefined; run.activeResource = undefined;
          this.store.save(run, 'setup.child.exited');
          if (lock && command.resource) this.store.release('environment:' + command.resource, lock);
        }
      }
    }
    await git.clean(cwd);
    const ownedOutputs = (await ignoredOutputs(git, cwd)).filter(output => !beforeOutputs.some(before => before.path === output.path));
    this.store.recordOperation(key, run.id, 'setup.passed', {fingerprint, status: 'passed', head: await git.head(cwd), ownedOutputs});
  }
  private async build(run: Run, git: Git, cwd: string, state: TaskState | undefined, task: Task | undefined, attempt: string, prompt: string): Promise<string> {
    const key = `${run.id}:build:${attempt}`;
    let intent = this.store.operation<{before: string; tree: string}>(key);
    if (!intent) {
      const before = await git.head(cwd);
      await this.agent(run, 'BUILD', cwd, state, task, prompt);
      await this.guard(run, cwd);
      await git.run(['add', '--all'], cwd);
      intent = {before, tree: await git.run(['write-tree'], cwd)};
      this.store.recordOperation(key, run.id, 'build.commit.intent', intent);
    }
    await this.guard(run, cwd);
    if (await git.run(['write-tree'], cwd) !== intent.tree) throw new Blocked('Build tree differs from the persisted commit intent; preserve it for inspection');
    const head = await git.head(cwd);
    if (head !== intent.before) {
      if (await git.run(['rev-parse', 'HEAD^{tree}'], cwd) !== intent.tree || await git.run(['rev-parse', 'HEAD^'], cwd) !== intent.before)
        throw new Blocked('Build commit does not match the persisted recovery intent');
      await git.clean(cwd); return head;
    }
    const committed = await git.commit(cwd, task?.title || 'Repair whole-feature validation');
    await this.guard(run, cwd); await git.clean(cwd);
    return committed;
  }
  private async agent(run: Run, stage: Stage, cwd: string, taskState?: TaskState, task?: Task, extra = '', skill?: string, collectReview = true): Promise<StageResult> {
    this.checkpoint(run);
    await this.guard(run, cwd);
    await requireCompatibility(this.store, this.client, run.plan.assignments[stage], cwd);
    if (stage === 'REVIEW' && collectReview) {
      const baseRef = task ? run.branch : `origin/${run.plan.project.mainBranch}`;
      const base = await new Git(cwd).run(['rev-parse', baseRef], cwd);
      const files = (await new Git(cwd).run(['diff', '--name-only', '-z', base, 'HEAD'], cwd)).split('\0').filter(Boolean);
      const covered: {path: string; diffHash: string}[] = [], head = await new Git(cwd).head(cwd);
      const key = `${run.id}:review-coverage:${task?.id || 'feature'}:${head}`;
      const previousCoverage = this.store.operation<{base: string; covered: {path: string; diffHash: string}[]}>(key);
      let result: StageResult = {outcome: 'passed', summary: 'No changed paths', findings: []};
      for (const path of files) {
        let diff: string;
        try {diff = await new Git(cwd).run(['diff', '--no-ext-diff', '--no-textconv', base, 'HEAD', '--', path], cwd);}
        catch {throw new ClientError('review_input', 'Cannot capture complete file diff; split the task or request an explicit review decision');}
        if (diff.length > 200_000 || /^Binary files /m.test(diff)) throw new ClientError('review_input', 'File diff requires a separate review decision: ' + path);
        if (previousCoverage?.base !== base || !previousCoverage.covered.some(c => c.path === path && c.diffHash === hash(diff)))
          result = await this.agent(run, stage, cwd, taskState, task, extra + `\nReview complete file ${JSON.stringify(path)} against ${base}:\n${diff}`, skill, false);
        await new Git(cwd).clean(cwd);
        if (await new Git(cwd).head(cwd) !== head) throw new Blocked('REVIEW changed the revision; coverage was not accepted');
        covered.push({path, diffHash: hash(diff)});
        this.store.recordOperation(key, run.id, 'review.coverage', {head, base, required: files, covered});
      }
      if (!files.length) result = await this.agent(run, stage, cwd, taskState, task, extra + '\nRunner observed no changed paths.', skill, false);
      return result;
    }
    const question = run.pendingDecision;
    if (question && question.stage === stage && question.taskId === task?.id) {
      if (!question.answer) throw new Blocked('Awaiting answer to decision request ' + question.id);
      if (question.planHash !== run.planHash || question.head !== await new Git(cwd).head(cwd)) throw new Blocked('Decision answer is stale after plan or revision change');
      extra += `\nHuman response to request ${question.id}: ${JSON.stringify({question: question.question, answer: question.answer})}. Treat as clarification within the approved scope, never permission to expand rules, models, checks, publication or merge rights.`;
    }
    const sessions = taskState ? taskState.sessions : run.finalSessions;
    const contextKey = `${run.id}:context:${task?.id || 'feature'}:${stage}`;
    const previous = this.store.operation<{session: string; manifest: ContextManifest}>(contextKey);
    if (stage === 'VERIFY') extra += '\nAvailable approved diagnostic commands: ' + JSON.stringify(run.plan.project.checks.filter(c => run.plan.verification?.diagnostics.includes(c.id)).map(c => ({command: c.command, args: c.args}))) + '\nAvailable browser tools: ' + JSON.stringify(run.plan.verification?.browserTools || []);
    const assembled = assembleContext({...run, root: cwd}, stage, task, extra, skill);
    this.store.event(run.id, 'context.assembled', {stage, task: task?.id, manifest: assembled.manifest});
    const log = join(ensureDir(join(this.store.home, 'logs', run.id)), `${task?.id || 'feature'}-${stage}-${Date.now()}.log`);
    const result = await this.client.run(run.plan.assignments[stage], assembled.prompt, {
      cwd, log, session: sessions[stage], stage, projectRoot: run.root, mode: stage === 'BUILD' ? 'write' : 'read', signal: this.options.signal,
      capabilities: stage === 'VERIFY' ? {diagnostics: run.plan.project.checks.filter(c => run.plan.verification?.diagnostics.includes(c.id))
        .map(c => [c.command, ...c.args].map(arg => arg.includes(' ') ? JSON.stringify(arg) : arg).join(' ')), browserTools: run.plan.verification?.browserTools || []} : undefined,
      onSpawn: pid => {run.childPid = pid; run.childStartedAt = now(); run.childIdentity = processIdentity(pid); this.store.save(run, 'client.started', {pid, stage, task: task?.id});},
      onSession: session => {if (sessions[stage] !== session) {
        sessions[stage] = session;
        if (stage === 'BUILD') {
          const scope = task ? `task:${task.id}` : 'feature', key = repairKey(run, scope), history = this.store.operation<Repair[]>(key);
          if (history) this.store.recordOperation(key, run.id, 'repair.session', history.map(repair => repair.state === 'pending' ? {...repair, session} : repair));
        }
        this.store.save(run, 'client.session', {session, stage, task: task?.id});
      }},
    }).finally(() => {
      // Keep a live PID after unexpected IO/state errors: recovery must not create a second executor.
      if (!alive(run.childPid)) {run.childPid = undefined; run.childStartedAt = undefined; this.store.save(run, 'client.exited');}
    });
    await this.guard(run, cwd);
    if (sessions[stage]) this.store.recordOperation(contextKey, run.id, 'context.sent', {session: sessions[stage], manifest: assembled.manifest});
    this.store.event(run.id, 'stage.result', {stage, task: task?.id, result});
    if (result.outcome !== 'passed') {
      if (result.outcome === 'blocked') {
        run.pendingDecision = {id: randomUUID(), planHash: run.planHash, head: await new Git(cwd).head(cwd), stage, taskId: task?.id,
          question: result.question || result.summary};
        this.store.save(run, 'decision.requested', {request: run.pendingDecision.id, stage, task: task?.id});
        if (run.parentIssue) {
          const github = this.options.github || new Gh(run.plan.project.repository, run.root);
          await github.commentOnce(run.parentIssue, 'decision:' + run.pendingDecision.id,
            redact(`Easy Skills requires a decision: ${run.pendingDecision.question}\n\nRequest: ${run.pendingDecision.id}\nPlan: ${run.planHash}\nRevision: ${run.pendingDecision.head}\n\nReply with the entire comment:\n/easy-skills answer ${run.id} ${run.planHash} ${run.pendingDecision.id} "YOUR ANSWER"`));
        }
        throw new Blocked(result.summary);
      }
      throw new CodeFailure(result.summary + '\n' + result.findings.join('\n'));
    }
    if (question?.id === run.pendingDecision?.id && question?.answer) {
      run.pendingDecision = undefined; this.store.save(run, 'decision.completed', {request: question.id});
    }
    this.store.recordOperation(`${run.id}:backoff`, run.id, 'backoff', 0);
    this.store.recordOperation(`${run.id}:last-result`, run.id, 'stage.summary', {stage, task: task?.id, summary: result.summary});
    return result;
  }
  private async checks(run: Run, git: Git, cwd: string, baseline = false): Promise<Evidence[]> {
    this.checkpoint(run);
    await this.guard(run, cwd);
    await git.clean(cwd);
    const head = await git.head(cwd), evidence: Evidence[] = [];
    for (const check of run.plan.project.checks) {
      this.checkpoint(run);
      const lock = check.resource ? this.store.acquire('environment:' + check.resource) : undefined;
      try {
        run.activeResource = check.resource;
        const log = join(ensureDir(join(this.store.home, 'logs', run.id)), `check-${check.id}-${Date.now()}.log`);
        const result = await execute(check, {cwd, role: 'project', timeoutMs: check.timeoutMs, log, signal: this.options.signal,
          onSpawn: pid => {run.childPid = pid; run.childStartedAt = now(); run.childIdentity = processIdentity(pid); this.store.save(run, 'check.started', {check: check.id, pid, baseline});}})
          .catch(error => ({code: -1, stdout: '', stderr: message(error), timedOut: false}));
        run.childPid = undefined; run.childStartedAt = undefined;
        run.activeResource = undefined;
        const entry: Evidence = {checkId: check.id, head, code: result.code, finishedAt: now(), log};
        evidence.push(entry); this.store.event(run.id, 'check.finished', entry);
        if (result.code !== 0 && !baseline) {
          const bundle = failureBundle(check, result, run, this.store.home);
          this.store.recordOperation(`${run.id}:failure-bundle`, run.id, 'check.failure', bundle);
          if (bundle.classification === 'unavailable') throw new Blocked('Required check unavailable: ' + check.id + '; configure its prerequisite, then resume');
          throw new CheckFailure(bundle);
        }
        await this.guard(run, cwd);
        if (await git.head(cwd) !== head) throw new Blocked('A check changed the revision being verified');
        await git.clean(cwd);
      } finally {
        if (!alive(run.childPid)) run.activeResource = undefined;
        if (lock && check.resource && !alive(run.childPid)) this.store.release('environment:' + check.resource, lock);
      }
    }
    return evidence;
  }
  private sufficient(run: Run, evidence: Evidence[], head: string) {
    return run.plan.project.checks.every(c => evidence.some(e => e.checkId === c.id && e.head === head && e.code === 0));
  }
  private async failure(run: Run, state: TaskState, error: unknown, git: Git) {
    const head = await git.head(state.worktree!);
    this.store.transaction(() => {
      recordFailure(this.store, run, `task:${state.id}:${state.cursor}`, error, head);
      startRepair(this.store, run, `task:${state.id}`, state.cursor, head, error as CheckFailure | CodeFailure);
      state.cursor = 'REPAIR'; state.reviewHead = undefined; state.evidence = [];
      this.store.save(run, 'task.repair', {task: state.id, count: run.failures.count, reason: redact(message(error))});
    });
    if (run.failures.count >= 3) throw new Blocked('Three identical unsuccessful repair cycles without progress: ' + message(error));
  }
  private async task(run: Run, state: TaskState, task: Task, git: Git, github: GitHub) {
    if (!state.worktree) {
      state.branch = `issue/${run.plan.featureId}-${run.id.slice(0, 8)}-${task.id}`;
      state.worktree = await this.ownedWorktree(run, git, state.branch, run.branch, task.id);
      this.store.save(run, 'task.worktree.created', {task: task.id});
    }
    const cwd = state.worktree;
    await this.guard(run, cwd); await this.setup(run, git, cwd);
    while (!state.integrated) {
      this.checkpoint(run);
      try {
        switch (state.cursor) {
          case 'BUILD': case 'REPAIR': {
            if (state.pr) {
              const pr = await github.viewPr(state.pr.number);
              if (pr.state === 'MERGED') {state.cursor = 'INTEGRATE'; this.store.save(run, 'task.merge.recovered'); break;}
              await github.setIssue(state.issue!, true, 'Implementation is being repaired; previous readiness is invalid.');
            }
            const repair = pendingRepair(this.store, run, `task:${state.id}`);
            state.head = await this.build(run, git, cwd, state, task, repair?.id || `initial-${state.id}`,
              repair ? `Repair ${repair.id}: ${JSON.stringify(repair)}. Preserve all approved inputs.` : 'Implement the approved task. Keep Git commits under runner control.');
            await git.clean(cwd);
            this.store.transaction(() => {
              if (repair) completeRepair(this.store, run, repair.scope, repair.id);
              state.cursor = 'VERIFY'; state.evidence = []; state.reviewHead = undefined;
              this.store.save(run, 'task.built', {task: task.id, head: state.head});
            }); break;
          }
          case 'VERIFY': {
            state.evidence = await this.checks(run, git, cwd);
            await this.agent(run, 'VERIFY', cwd, state, task, `Independent check evidence: ${JSON.stringify(state.evidence.map(({log, ...entry}) => entry))}. Inspect acceptance coverage and missing checks.`);
            if (await git.head(cwd) !== state.head) throw new Blocked('VERIFY changed the commit');
            await git.clean(cwd); state.cursor = 'REVIEW';
            confirmedProgress(this.store, run, `task:${state.id}:VERIFY`, state.head!);
            this.store.save(run, 'task.verified', {task: task.id}); break;
          }
          case 'REVIEW': {
            if (!this.sufficient(run, state.evidence, await git.head(cwd))) {state.cursor = 'VERIFY'; break;}
            await this.agent(run, 'REVIEW', cwd, state, task, `Review diff against ${run.branch}; check requirement compliance, correctness, regressions, and evidence. Do not edit files.`);
            await git.clean(cwd);
            state.reviewHead = await git.head(cwd);
            if (state.reviewHead !== state.head) throw new Blocked('REVIEW changed the commit');
            confirmedProgress(this.store, run, `task:${state.id}:REVIEW`, state.reviewHead);
            state.cursor = 'SHIP'; this.store.save(run, 'task.reviewed', {task: task.id, head: state.reviewHead}); break;
          }
          case 'SHIP': {
            const head = await git.head(cwd);
            if (state.reviewHead !== head || !this.sufficient(run, state.evidence, head)) {state.cursor = 'VERIFY'; break;}
            await this.agent(run, 'SHIP', cwd, state, task, 'Inspect delivery readiness. The runner publishes and closes the Issue.');
            await git.clean(cwd); if (await git.head(cwd) !== head) throw new Blocked('SHIP changed the reviewed commit');
            await git.push(state.branch!, cwd);
            state.pr = await github.pr(`${run.id}:pr:${task.id}`, task.title,
              `${task.description}\n\nImplements #${state.issue}.\n\nChecks at ${head}:\n${state.evidence.map(e => '- ' + e.checkId + ': passed').join('\n')}\n\nReview: passed at ${state.reviewHead}`, state.branch!, run.branch);
            if (state.pr.headRefOid !== head) throw new Blocked('PR head differs from the checked commit');
            await github.setIssue(state.issue!, false, `Implemented and verified at ${head}. PR: ${state.pr.url}. Dependencies remain pending until integration merge.`);
            state.cursor = 'INTEGRATE'; this.store.save(run, 'task.pr.ready', {task: task.id, pr: state.pr}); break;
          }
          case 'INTEGRATE': {
            if (!run.plan.permissions.mergeIntermediate) throw new Blocked('Intermediate merge requires permission in the approved plan');
            let pr = await github.viewPr(state.pr!.number);
            if (pr.baseRefName !== run.branch || pr.headRefName !== state.branch) throw new Blocked('PR target or source changed');
            if (pr.state !== 'MERGED') {
              if (pr.state === 'CLOSED') {await github.setIssue(state.issue!, true, 'PR rejected; task requires a new decision.'); throw new Blocked('Intermediate PR was closed without merge');}
              const head = await git.head(cwd);
              if (pr.headRefOid !== head || state.reviewHead !== head || !this.sufficient(run, state.evidence, head))
                throw new Blocked('PR changed after validation');
              const pending = this.store.operation<{state: string; base: string}>(`${run.id}:merge:${pr.number}:${head}`);
              // Observe an authorized in-flight request before changing either branch.
              if (pending) {
                if (pending.state === 'merged') throw new ClientError('waiting_merge', 'Merge request completed; waiting for the actual PR outcome');
                await this.merge(run, github, pr, head, pending.base);
                break;
              }
              await this.syncTask(run, state, task, git, github);
              if (state.cursor !== 'INTEGRATE') break;
              await this.merge(run, github, pr, head, await git.run(['rev-parse', `origin/${run.branch}`]));
              pr = await github.viewPr(pr.number);
            }
            if (pr.state !== 'MERGED' || !pr.mergedAt) throw new Blocked('Intermediate merge is not confirmed');
            if (pr.headRefOid !== state.reviewHead || !this.sufficient(run, state.evidence, pr.headRefOid)) throw new Blocked('Merged PR head differs from the reviewed and verified revision; dependency remains pending');
            await git.fetch(); await git.clean(run.worktree!);
            await git.run(['merge', '--ff-only', `origin/${run.branch}`], run.worktree!);
            state.pr = pr; state.integrated = true;
            run.failures = {fingerprint: '', head: '', count: 0};
            this.store.save(run, 'task.integrated', {task: task.id, pr: pr.number}); break;
          }
        }
      } catch (error) {
        if (!(error instanceof CheckFailure || error instanceof CodeFailure)) throw error;
        if (['SHIP', 'INTEGRATE', 'REPAIR'].includes(state.cursor)) {
          throw new Blocked(message(error));
        }
        run.reason = redact(message(error));
        await this.failure(run, state, error, git);
      }
    }
  }
  private async syncTask(run: Run, state: TaskState, task: Task, git: Git, github: GitHub) {
    await git.fetch();
    const mainTarget = `origin/${run.plan.project.mainBranch}`;
    const mainHead = await git.run(['rev-parse', mainTarget]);
    const mainIncluded = await execute({command: 'git', args: ['merge-base', '--is-ancestor', mainHead, 'HEAD']}, {cwd: run.worktree!});
    if (mainIncluded.code === 1) {
      await this.sync(run, run.worktree!, mainTarget, git);
      await git.push(run.branch, run.worktree!);
      run.finalReviewHead = undefined; run.finalEvidence = []; run.finalPhase = 'SYNC';
      this.store.save(run, 'integration.base.updated');
    } else if (mainIncluded.code !== 0) throw new Blocked('Cannot establish main-branch compatibility');
    const base = await git.run(['rev-parse', `origin/${run.branch}`]);
    const included = await execute({command: 'git', args: ['merge-base', '--is-ancestor', base, 'HEAD']}, {cwd: state.worktree!});
    if (included.code === 0) return;
    if (included.code !== 1) throw new Blocked('Cannot establish task-branch compatibility');
    await github.setIssue(state.issue!, true, 'Integration branch changed; compatibility and review must be checked again.');
    await this.sync(run, state.worktree!, `origin/${run.branch}`, git, state, task);
    state.head = await git.head(state.worktree!); state.cursor = 'VERIFY'; state.reviewHead = undefined; state.evidence = [];
    this.store.save(run, 'task.sync.invalidated', {task: state.id});
  }
  private async merge(run: Run, github: GitHub, pr: PullRequest, head: string, base: string) {
    if (!run.plan.project.mergePolicy) throw new Blocked('No agreed GitHub merge policy; migrate by reviewing a new plan with project.mergePolicy');
    const key = `${run.id}:merge:${pr.number}:${head}`;
    const prior = this.store.operation<{state: string; base: string; head: string; planHash: string; operationId?: string; nextPollAt?: number}>(key);
    if (prior && (prior.base !== base || prior.head !== head || prior.planHash !== run.planHash)) throw new Blocked('Merge authorization binding changed; a new decision is required');
    if (prior?.nextPollAt && prior.nextPollAt > Date.now()) throw new ClientError('waiting_merge', 'Waiting for scheduled merge observation', new Date(prior.nextPollAt).toISOString());
    if (prior?.state === 'enqueued') {
      if (!github.queueEntry) throw new Blocked('This transport cannot verify actual merge queue membership');
      const queued = await github.queueEntry(pr.number);
      this.store.recordOperation(key, run.id, 'merge.queue.observed', {...prior, state: queued ? 'enqueued' : 'failed', nextPollAt: Date.now() + 60_000});
      if (!queued) throw new Blocked('PR left the merge queue without a confirmed merge; a new authorization is required');
      throw new ClientError('waiting_merge', 'Merge queued; waiting for actual GitHub merge', new Date(Date.now() + 60_000).toISOString());
    }
    if (prior && prior.state !== 'authorized' && (!prior.operationId || ['failed', 'expired', 'cancelled'].includes(prior.state))) throw new Blocked('Previous merge submission is ambiguous or terminal; reconcile it and authorize a fresh request explicitly');
    const intent = {state: 'executing', base, head, planHash: run.planHash, operationId: prior?.operationId};
    this.store.recordOperation(key, run.id, 'merge.intent', intent);
    let result;
    try {result = await github.merge(pr.number, head, {base, policy: run.plan.project.mergePolicy, operationId: prior?.operationId});}
    catch (error) {
      if (error instanceof ClientError && error.kind === 'waiting_ci')
        this.store.recordOperation(key, run.id, 'merge.waiting-ci', {...intent, state: 'authorized', nextPollAt: Date.now() + 60_000});
      else if (error instanceof MergeTerminalError)
        this.store.recordOperation(key, run.id, 'merge.' + error.state, {...intent, state: error.state, reason: redact(message(error))});
      else if (!(error instanceof ClientError && ['quota', 'network'].includes(error.kind)))
        this.store.recordOperation(key, run.id, 'merge.uncertain', {...intent, state: 'uncertain', reason: redact(message(error))});
      throw error;
    }
    this.store.recordOperation(key, run.id, 'merge.' + result.state, {...intent, ...result, nextPollAt: Date.now() + 60_000});
    this.store.event(run.id, 'merge.observed', {pr: pr.number, ...result});
    if (result.state !== 'merged') throw new ClientError('waiting_merge', 'Merge ' + result.state + '; waiting for actual GitHub merge', new Date(Date.now() + 60_000).toISOString());
  }
  async sync(run: Run, cwd: string, target: string, git: Git, state?: TaskState, task?: Task) {
    this.checkpoint(run);
    await this.guard(run, cwd);
    const key = `${run.id}:sync:${hash(cwd)}`;
    const mergePath = await git.run(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], cwd);
    let before: string, targetHead: string, conflicts: string[];
    if (existsSync(mergePath)) {
      const intent = this.store.operation<{before: string; targetHead: string; target: string; completed?: boolean}>(key);
      if (!intent || intent.completed || intent.target !== target || await git.head(cwd) !== intent.before ||
        await git.run(['rev-parse', 'MERGE_HEAD'], cwd) !== intent.targetHead)
        throw new Blocked('Existing merge does not match this run\'s recorded synchronization');
      before = intent.before; targetHead = intent.targetHead;
      conflicts = (await git.run(['diff', '--name-only', '--diff-filter=U'], cwd)).split(/\r?\n/).filter(Boolean);
    } else {
      await git.clean(cwd);
      before = await git.head(cwd); targetHead = await git.run(['rev-parse', target]);
      const backup = `refs/easy-skills/${run.id}/${Date.now()}`;
      await git.run(['update-ref', backup, before]);
      this.store.recordOperation(key, run.id, 'sync.intent', {before, targetHead, target, backup});
      this.store.event(run.id, 'sync.checkpoint', {before, targetHead, backup, cwd});
      conflicts = (await git.merge(cwd, target)).conflicts;
    }
    if (conflicts.length) {
      await this.agent(run, 'BUILD', cwd, state, task,
        `Resolve merge conflicts preserving both contracts and behavior. Before ${before}; target ${targetHead}; files ${conflicts.join(', ')}. If ambiguous, return blocked and preserve the merge.`, 'easy-sync');
      if (await git.run(['diff', '--name-only', '--diff-filter=U'], cwd)) throw new Blocked('Merge still has unresolved entries');
    }
    if (existsSync(mergePath)) {
      await this.guard(run, cwd);
      await git.commit(cwd, `Sync ${target}`);
      await this.guard(run, cwd);
      await git.clean(cwd);
    }
    this.store.recordOperation(key, run.id, 'sync.completed', {before, targetHead, target, completed: true});
    this.store.event(run.id, 'sync.merged', {before, targetHead, head: await git.head(cwd)});
  }
  private async finish(run: Run, git: Git, github: GitHub) {
    const cwd = run.worktree!;
    while (run.status === 'running') {
      this.checkpoint(run);
      try {
      if (run.finalPhase === 'REPAIR') {
        const repair = pendingRepair(this.store, run, 'feature');
        if (!repair) throw new Blocked('Persisted repair cursor has no matching intent');
        await this.build(run, git, cwd, undefined, undefined, repair.id, `Repair whole-feature failure ${JSON.stringify(repair)}. Preserve all integrated tasks.`);
        this.store.transaction(() => {
          completeRepair(this.store, run, repair.scope, repair.id);
          run.finalPhase = 'SYNC'; run.finalReviewHead = undefined; run.finalEvidence = [];
          this.store.save(run, 'feature.repaired');
        });
      } else if (run.finalPhase === 'SYNC') {
        await git.fetch();
        const target = `origin/${run.plan.project.mainBranch}`;
        await this.sync(run, cwd, target, git);
        run.syncedBase = await git.run(['rev-parse', target]);
        run.finalEvidence = []; run.finalReviewHead = undefined; run.finalPhase = 'VERIFY';
        this.store.save(run, 'feature.synced');
      } else if (run.finalPhase === 'VERIFY') {
        run.finalEvidence = await this.checks(run, git, cwd);
        const head = await git.head(cwd);
        await this.agent(run, 'VERIFY', cwd, undefined, undefined, `Whole-feature acceptance and end-to-end validation. Check evidence: ${JSON.stringify(run.finalEvidence.map(({log, ...entry}) => entry))}`);
        await git.clean(cwd); if (await git.head(cwd) !== head) throw new Blocked('Final VERIFY changed the commit');
        confirmedProgress(this.store, run, 'feature:VERIFY', head);
        run.finalPhase = 'REVIEW'; this.store.save(run, 'feature.verified');
      } else if (run.finalPhase === 'REVIEW') {
        const head = await git.head(cwd);
        if (!this.sufficient(run, run.finalEvidence, head)) {run.finalPhase = 'VERIFY'; continue;}
        await this.agent(run, 'REVIEW', cwd, undefined, undefined, `Review the whole feature against ${run.plan.project.mainBranch}, including interactions, end-to-end acceptance, and regressions.`);
        await git.clean(cwd); if (await git.head(cwd) !== head) throw new Blocked('Final REVIEW changed the commit');
        confirmedProgress(this.store, run, 'feature:REVIEW', head);
        run.finalReviewHead = head; run.finalPhase = 'SHIP'; this.store.save(run, 'feature.reviewed');
      } else {
        await git.fetch();
        if (run.syncedBase !== await git.run(['rev-parse', `origin/${run.plan.project.mainBranch}`])) {
          run.finalPhase = 'SYNC'; this.store.save(run, 'feature.base.changed'); continue;
        }
        const head = await git.head(cwd);
        if (head !== run.finalReviewHead || !this.sufficient(run, run.finalEvidence, head)) {run.finalPhase = 'VERIFY'; continue;}
        await this.agent(run, 'SHIP', cwd, undefined, undefined, 'Verify final PR readiness. Do not merge the main branch.');
        await git.clean(cwd); if (await git.head(cwd) !== head) throw new Blocked('Final SHIP changed the commit');
        await git.push(run.branch, cwd);
        run.finalPr = await github.pr(`${run.id}:final`, run.plan.title,
          `${run.plan.spec}\n\nParent #${run.parentIssue}; stays open until final merge.\n\nVerified revision: ${head}\n\n${run.finalEvidence.map(e => '- ' + e.checkId + ': passed').join('\n')}\n\nFinal review: ${run.finalReviewHead}\nPlan: ${run.planHash}`, run.branch, run.plan.project.mainBranch);
        if (run.finalPr.headRefOid !== head) throw new Blocked('Final PR head changed');
        run.status = 'ready'; this.store.save(run, 'feature.ready', {pr: run.finalPr});
        this.store.enqueue(`${run.id}:ready:${head}`, {runId: run.id, project: run.plan.project.name, feature: run.plan.title,
          state: 'ready', reason: 'Ready for final verification and a separate merge decision', url: run.finalPr.url});
      }
      } catch (error) {
        if (!(error instanceof CheckFailure || error instanceof CodeFailure) || !['VERIFY', 'REVIEW'].includes(run.finalPhase)) throw error;
        const head = await git.head(cwd);
        this.store.transaction(() => {
          recordFailure(this.store, run, `feature:${run.finalPhase}`, error, head);
          startRepair(this.store, run, 'feature', run.finalPhase, head, error);
          run.reason = redact(message(error)); run.finalPhase = 'REPAIR';
          this.store.save(run, 'feature.repair', {count: run.failures.count, reason: run.reason});
        });
        if (run.failures.count >= 3) throw new Blocked('Three identical unsuccessful whole-feature repairs without progress: ' + run.reason);
      }
    }
  }
  async syncManual(id: string): Promise<Run> {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id);
    try {
      if (!run.worktree || alive(run.childPid)) throw new Error('No safe integration worktree available');
      this.checkpoint(run);
      for (const pr of [run.finalPr, ...run.tasks.filter(t => !t.integrated).map(t => t.pr)].filter((pr): pr is PullRequest => !!pr)) {
        const intent = this.store.operation<{state: string}>(`${id}:merge:${pr.number}:${pr.headRefOid}`);
        if (intent && !['failed', 'expired', 'cancelled'].includes(intent.state)) throw new Error('Reconcile the outstanding merge before manual synchronization');
      }
      this.store.recordOperation(`${id}:manual-sync`, id, 'manual.sync', {pending: true});
      run.finalReviewHead = undefined; run.finalEvidence = []; run.finalPhase = 'SYNC';
      this.store.save(run, 'manual.sync.started');
      const git = this.git(run); await git.fetch();
      await this.sync(run, run.worktree, `origin/${run.plan.project.mainBranch}`, git);
      run.finalPhase = 'VERIFY'; run.finalReviewHead = undefined; run.finalEvidence = []; run.status = 'approved';
      this.store.recordOperation(`${id}:manual-sync`, id, 'manual.sync', {pending: false});
      this.store.save(run, 'manual.sync');
      return run;
    } catch (error) {
      run.status = 'needs_decision'; run.reason = redact(message(error));
      this.store.save(run, 'manual.sync.blocked', {reason: run.reason});
      this.store.enqueue(`${id}:sync:${hash(run.reason)}`, {runId: id, project: run.plan.project.name, feature: run.plan.title,
        state: run.status, reason: run.reason.slice(0, 700), url: run.finalPr?.url});
      throw error;
    } finally {this.store.release('run:' + id, owner);}
  }
  async recaptureBaseline(id: string, base: string, approvedHash?: string) {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id), git = this.git(run);
    try {
      this.checkpoint(run);
      if (!run.worktree || ownerAlive(run.childPid, run.childIdentity) || run.tasks.some(t => t.head || Object.keys(t.sessions).length))
        throw new Error('Baseline recapture requires a clean managed worktree before implementation; otherwise create a replacement plan');
      await this.guard(run, run.worktree); await git.clean(run.worktree);
      if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Select an exact base commit');
      const before = await git.head(run.worktree), selected = await git.run(['rev-parse', `${base}^{commit}`]);
      const proposal = {runId: id, planHash: run.planHash, before, selected, previous: this.store.operation(`${id}:baseline`)};
      const digest = hash(proposal);
      if (!approvedHash) return {...proposal, hash: digest};
      if (approvedHash !== digest) throw new Error('Baseline recapture proposal changed');
      const ancestor = await execute({command: 'git', args: ['merge-base', '--is-ancestor', before, selected]}, {cwd: run.worktree});
      if (ancestor.code !== 0) throw new Error('Selected baseline is not a safe fast-forward; use a replacement plan');
      this.store.recordOperation(`${id}:baseline-history:${digest}`, id, 'baseline.recapture.intent', proposal);
      await git.run(['merge', '--ff-only', selected], run.worktree);
      await this.guard(run, run.worktree); await this.setup(run, git, run.worktree);
      const results = await this.checks(run, git, run.worktree, true);
      this.store.recordOperation(`${id}:baseline`, id, 'baseline.recaptured', {head: selected, commands: run.plan.project.checks, results, status: results.every(r => r.code === 0) ? 'passed' : 'pre_existing_failure'});
      return {...proposal, hash: digest, results};
    } finally {this.store.release('run:' + id, owner);}
  }
  async resetSetup(id: string, name: string, approvedHash?: string) {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id), git = this.git(run);
    try {
      this.checkpoint(run);
      if (ownerAlive(run.childPid, run.childIdentity)) throw new Error('A child is still active');
      const cwd = name === 'integration' ? run.worktree : run.tasks.find(t => t.id === name)?.worktree;
      if (!cwd) throw new Error('Managed worktree not found');
      await this.guard(run, cwd); await git.clean(cwd);
      const key = `${run.id}:setup:${hash(cwd)}`, previous = this.store.operation<{fingerprint: string; status: string}>(key);
      if (!previous || previous.status === 'passed') throw new Error('No interrupted or failed setup to reset');
      const proposal = {runId: id, planHash: run.planHash, cwd, head: await git.head(cwd), previous, commands: run.plan.project.setup,
        consequence: 'Rerun the approved setup against retained partial outputs; inspect the log and ensure repeating these commands is safe'};
      const digest = hash(proposal);
      if (!approvedHash) return {...proposal, hash: digest};
      if (approvedHash !== digest) throw new Error('Setup retry proposal changed');
      this.store.recordOperation(`${key}:history:${digest}`, id, 'setup.retry.approved', proposal);
      this.store.recordOperation(key, id, 'setup.retry', {...previous, status: 'approved_retry'});
      return {...proposal, hash: digest, approved: true};
    } finally {this.store.release('run:' + id, owner);}
  }
  async abandon(id: string) {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id), github = this.options.github || new Gh(run.plan.project.repository, run.root);
    try {
      if (this.store.locked('worker:' + id) || ownerAlive(run.childPid, run.childIdentity)) throw new Error('Stop the active executor before abandonment');
      if (run.status === 'merged') throw new Error('Merged runs remain merged');
      for (const saved of [run.finalPr, ...run.tasks.map(t => t.pr)].filter((pr): pr is PullRequest => !!pr)) {
        const actual = await github.viewPr(saved.number);
        const key = `${id}:merge:${saved.number}:${saved.headRefOid}`, intent = this.store.operation<{state: string}>(key);
        this.store.recordOperation(`${id}:abandon-observation:${saved.number}`, id, 'abandon.observed', {pr: actual, intent});
        if (intent && !['failed', 'expired', 'cancelled'].includes(intent.state) && actual.state === 'OPEN')
          throw new Error('A merge operation may still execute; reconcile or cancel it externally before abandoning');
      }
      run.status = 'abandoned'; run.reason = 'Explicitly abandoned; documents, worktrees, approvals, sessions and external history retained';
      this.store.save(run, 'run.abandoned'); return run;
    } finally {this.store.release('run:' + id, owner);}
  }
  async authorizeMergeRetry(id: string, number: number, head: string, approvedHash?: string) {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id), github = this.options.github || new Gh(run.plan.project.repository, run.root);
    try {
      this.checkpoint(run);
      const task = run.tasks.find(t => t.pr?.number === number);
      const saved = task?.pr || (run.finalPr?.number === number ? run.finalPr : undefined);
      if (!saved || saved.headRefOid !== head || (task?.reviewHead || run.finalReviewHead) !== head) throw new Error('Merge retry must match the saved reviewed PR');
      const key = `${id}:merge:${number}:${head}`, prior = this.store.operation<{state: string; base: string}>(key);
      if (!prior || !['failed', 'expired', 'cancelled'].includes(prior.state)) throw new Error('Reconcile an ambiguous or active submission before authorizing a fresh merge');
      const pr = await github.viewPr(number);
      if (pr.state !== 'OPEN' || pr.headRefOid !== head || pr.headRefName !== saved.headRefName || pr.baseRefName !== saved.baseRefName)
        throw new Error('PR changed; sync and revalidate instead of retrying');
      if (!github.queueEntry || await github.queueEntry(number)) throw new Error('Cannot prove that the PR is outside the merge queue');
      const git = this.git(run), cwd = task?.worktree || run.worktree;
      if (!cwd || !this.sufficient(run, task?.evidence || run.finalEvidence, head)) throw new Error('Merge retry has no matching deterministic evidence');
      await this.guard(run, cwd); await git.clean(cwd); await git.fetch();
      if (await git.head(cwd) !== head || await git.run(['rev-parse', `origin/${pr.baseRefName}`]) !== prior.base)
        throw new Error('Merge head or base changed; sync and revalidate');
      const proposal = {runId: id, planHash: run.planHash, head, target: pr.baseRefName, pr: number, previous: prior};
      const digest = hash(proposal);
      if (!approvedHash) return {...proposal, hash: digest};
      if (approvedHash !== digest) throw new Error('Merge retry proposal changed');
      this.store.transaction(() => {
        this.store.recordOperation(`${key}:history:${digest}`, id, 'merge.retry.approved', proposal);
        this.store.recordOperation(key, id, 'merge.retry.authorized', {state: 'authorized', base: prior.base, head, planHash: run.planHash});
        if (!task) {run.status = 'ready'; this.store.save(run, 'merge.retry.authorized');}
      });
      return {...proposal, hash: digest, approved: true, next: 'Resume monitoring to submit the newly authorized merge'};
    } finally {this.store.release('run:' + id, owner);}
  }
  async confirmFinalMerge(id: string, expectedHead: string): Promise<Run> {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id);
    try {
      if (!run.finalPr || !run.worktree) throw new Error('Feature is not ready');
      const git = this.git(run), github = this.options.github || new Gh(run.plan.project.repository, run.root);
      const pr = await github.viewPr(run.finalPr.number);
      if (pr.baseRefName !== run.plan.project.mainBranch || pr.headRefName !== run.branch) throw new Error('PR target or source changed');
      if (pr.state === 'MERGED' && pr.mergedAt && pr.headRefOid === expectedHead && run.finalReviewHead === expectedHead) {
        if (run.approvedHash !== run.planHash || hash(run.plan) !== run.planHash || !this.sufficient(run, run.finalEvidence, expectedHead))
          throw new Error('Historical merge does not match persisted approval and verification evidence');
        run.finalPr = pr; run.status = 'merged';
        await github.setIssue(run.parentIssue!, false, `Feature merged: ${pr.url}`);
        this.store.save(run, 'feature.merge.reconciled'); return run;
      }
      if (run.status !== 'ready') throw new Error('Feature is not ready');
      this.checkpoint(run); await this.guard(run, run.worktree);
      await git.clean(run.worktree); await git.fetch();
      if (pr.headRefOid !== expectedHead || run.finalReviewHead !== expectedHead || await git.head(run.worktree) !== expectedHead ||
        !this.sufficient(run, run.finalEvidence, expectedHead) ||
        run.syncedBase !== await git.run(['rev-parse', `origin/${run.plan.project.mainBranch}`])) throw new Error('Revision or base changed; sync and validate again');
      if (pr.state !== 'MERGED') await this.merge(run, github, pr, expectedHead, run.syncedBase!);
      const confirmed = await github.viewPr(pr.number);
      if (confirmed.state !== 'MERGED' || !confirmed.mergedAt || confirmed.headRefOid !== expectedHead || confirmed.baseRefName !== run.plan.project.mainBranch || confirmed.headRefName !== run.branch) throw new Error('Final merge was not confirmed at the authorized head and target');
      run.finalPr = confirmed; run.status = 'merged';
      await github.setIssue(run.parentIssue!, false, `Feature merged: ${confirmed.url}`);
      this.store.save(run, 'feature.merged'); return run;
    } finally {this.store.release('run:' + id, owner);}
  }
  async reconcileFinalMerge(id: string): Promise<Run> {
    const run = this.store.get(id);
    const intent = run.finalPr && run.finalReviewHead ? this.store.operation<{state: string; operationId?: string; nextPollAt?: number}>(`${id}:merge:${run.finalPr.number}:${run.finalReviewHead}`) : undefined;
    const active = !!intent && ['pending', 'enqueued', 'executing', 'authorized', 'uncertain', 'merged'].includes(intent.state);
    if (!run.finalPr || (run.status !== 'ready' && !(run.status === 'needs_decision' && run.finalReviewHead))) return run;
    let owner: string;
    try {owner = this.store.acquire('run:' + id);} catch (error) {if (error instanceof ResourceBusy) return run; throw error;}
    const github = this.options.github || new Gh(run.plan.project.repository, run.root);
    let mergedHead: string | undefined;
    try {
      if (alive(run.childPid)) return run;
      if (this.store.operation<{action?: string}>(`${id}:control`)?.action) return run;
      const pr = await github.viewPr(run.finalPr.number);
      if (pr.state === 'MERGED') mergedHead = pr.headRefOid;
      else {
        if (run.status === 'needs_decision') {
          if (active && (!intent?.nextPollAt || intent.nextPollAt <= Date.now())) {
            const key = `${id}:merge:${pr.number}:${run.finalReviewHead}`;
            let state = intent!.state;
            try {
              if (state === 'enqueued' && github.queueEntry) state = await github.queueEntry(pr.number) ? 'enqueued' : 'failed';
              else if (intent?.operationId && github.observeMerge) state = (await github.observeMerge(pr.number, run.finalReviewHead!, intent.operationId)).state;
            } catch (error) {if (error instanceof MergeTerminalError) state = error.state; else throw error;}
            this.store.recordOperation(key, id, 'merge.suspended.observed', {...intent, state, nextPollAt: Date.now() + 60_000});
          }
          return run;
        }
        this.checkpoint(run);
        const git = this.git(run);
        await git.fetch();
        const base = await git.run(['rev-parse', `origin/${run.plan.project.mainBranch}`]);
        if (active && (base !== run.syncedBase || pr.headRefOid !== run.finalReviewHead)) {
          run.status = 'needs_decision'; run.stopReason = 'waiting_merge';
          run.reason = 'A merge is in flight and head/base changed; preserve its approved evidence and reconcile the outstanding operation before any new sync or submission';
          this.store.save(run, 'merge.inflight.binding.changed', {base, head: pr.headRefOid});
        } else if (base !== run.syncedBase || pr.headRefOid !== run.finalReviewHead) {
          run.status = 'approved'; run.finalPhase = 'SYNC'; run.finalReviewHead = undefined; run.finalEvidence = [];
          run.reason = 'Readiness revoked: target or source changed; sync, checks, review and a new merge confirmation are required';
          this.store.save(run, 'feature.readiness.revoked', {base, head: pr.headRefOid});
          this.store.enqueue(`${id}:revoked:${base}:${pr.headRefOid}`, {project: run.plan.project.name, feature: run.plan.title, state: run.status, reason: run.reason, url: pr.url});
        }
      }
    } finally {this.store.release('run:' + id, owner);}
    if (mergedHead) return this.confirmFinalMerge(id, mergedHead);
    if (run.status === 'ready' && intent && ['pending', 'enqueued', 'executing', 'authorized'].includes(intent.state) && (!intent.nextPollAt || intent.nextPollAt <= Date.now())) {
      try {return await this.confirmFinalMerge(id, run.finalReviewHead!);}
      catch (error) {
        if (error instanceof ClientError && ['network', 'waiting_merge', 'waiting_ci'].includes(error.kind)) return this.store.get(id);
        const lock = this.store.acquire('run:' + id);
        try {const current = this.store.get(id); current.status = 'needs_decision'; current.reason = redact(message(error)); this.store.save(current, 'merge.monitor.blocked'); return current;}
        finally {this.store.release('run:' + id, lock);}
      }
    }
    return run;
  }
}
