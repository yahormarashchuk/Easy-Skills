import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Run, TaskState, Task, Stage, Evidence, PullRequest } from '../contracts.js';
import { VERSION, Plan } from '../contracts.js';
import { Store, ResourceBusy } from '../persistence/store.js';
import { CliClient, ClientError, classify, type Client } from '../adapters/index.js';
import { Git } from '../git/index.js';
import { Gh, type GitHub } from '../github/index.js';
import { execute } from '../process.js';
import { alive, ensureDir, hash, message, now, redact, rulesHash } from '../util.js';
import { assembleContext, type ContextManifest } from './context.js';
import { recordFailure, confirmedProgress } from './failures.js';
import { requireCompatibility } from './compatibility.js';
import { CheckFailure, failureBundle } from './check-failure.js';
import { requireAgreement } from './onboarding.js';

class Blocked extends Error {}
export interface EngineOptions {client?: Client; github?: GitHub; signal?: AbortSignal}
export class Engine {
  readonly client: Client;
  constructor(readonly store: Store, readonly options: EngineOptions = {}) {this.client = options.client || new CliClient();}
  approve(id: string, expectedHash: string): Run {
    const run = this.store.get(id);
    if (run.status !== 'draft') throw new Error('Only a draft can be approved');
    Plan.parse(run.plan);
    if (run.planHash !== expectedHash || hash(run.plan) !== expectedHash) throw new Error('Approval must match the exact reviewed plan hash');
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
    if (run.plan.runnerVersion !== VERSION || run.plan.skillsVersion !== VERSION) throw new Blocked('Pinned runner or skill version differs; use the pinned package');
    if (run.approvedHash !== run.planHash || hash(run.plan) !== run.planHash) throw new Blocked('Plan lacks a matching approval');
    if (rulesHash(run.root) !== run.plan.rulesHash) throw new Blocked('Project rules changed; a revised plan needs approval');
    if (!run.plan.rulesAgreement) throw new Blocked('Legacy plan lacks a rules agreement; complete onboarding and review a replacement plan');
    requireAgreement(run.root, run.plan.rulesAgreement);
  }
  async run(id: string): Promise<Run> {
    if (this.store.get(id).status === 'ready') return this.reconcileFinalMerge(id);
    const owner = this.store.acquire('run:' + id);
    const run = this.store.get(id);
    const git = new Git(run.root, operation => this.store.withLock('repository:' + run.commonDir, operation));
    const github = this.options.github || new Gh(run.plan.project.repository, run.root);
    try {
      if (['draft', 'stopped', 'merged', 'ready'].includes(run.status)) throw new Error('Run cannot execute from status ' + run.status);
      this.checkpoint(run);
      if (alive(run.childPid)) throw new Blocked(`Recorded child PID ${run.childPid} is still alive; reconcile it before resuming`);
      run.childPid = undefined; run.childStartedAt = undefined;
      const next = run.tasks.find(t => !t.integrated)?.cursor || run.finalPhase;
      if (next !== 'INTEGRATE' && next !== 'SYNC') await requireCompatibility(this.store, this.client, run.plan.assignments[next], run.root);
      const identity = await git.identity();
      if (identity.commonDir !== run.commonDir) throw new Blocked('Repository identity changed');
      const origin = await git.run(['config', '--get', 'remote.origin.url']);
      const repo = run.plan.project.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`github\\.com[:/]${repo}(?:\\.git)?/?$`, 'i').test(origin))
        throw new Blocked('origin does not match the approved GitHub repository');
      run.status = 'running'; run.reason = undefined; run.retryAt = undefined;
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
      if (run.status === 'draft' || run.status === 'merged' || run.status === 'ready') throw error;
      const detail = redact(message(error));
      run.reason = detail;
      if (error instanceof ResourceBusy || (error instanceof ClientError && (error.kind === 'quota' || error.kind === 'network'))) {
        run.status = 'waiting_quota';
        const key = `${run.id}:backoff`;
        const attempt = (this.store.operation<number>(key) || 0) + 1;
        this.store.recordOperation(key, run.id, 'backoff', attempt);
        run.retryAt = (error instanceof ClientError ? error.retryAt : undefined) || new Date(Date.now() + Math.min(60_000 * 2 ** Math.min(attempt - 1, 8), 4 * 60 * 60_000)).toISOString();
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
  private async agent(run: Run, stage: Stage, cwd: string, taskState?: TaskState, task?: Task, extra = '', skill?: string) {
    this.checkpoint(run);
    await requireCompatibility(this.store, this.client, run.plan.assignments[stage], cwd);
    if (stage === 'REVIEW') {
      const base = task ? run.branch : `origin/${run.plan.project.mainBranch}`;
      const diff = await new Git(cwd).run(['diff', '--no-ext-diff', '--no-textconv', base, 'HEAD'], cwd);
      extra += '\nRunner-collected diff for independent review:\n' + diff;
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
    const assembled = assembleContext(run, stage, task, extra, skill, sessions[stage] && previous?.session === sessions[stage] ? previous.manifest : undefined);
    this.store.event(run.id, 'context.assembled', {stage, task: task?.id, manifest: assembled.manifest});
    const log = join(ensureDir(join(this.store.home, 'logs', run.id)), `${task?.id || 'feature'}-${stage}-${Date.now()}.log`);
    const result = await this.client.run(run.plan.assignments[stage], assembled.prompt, {
      cwd, log, session: sessions[stage], stage, projectRoot: run.root, mode: stage === 'BUILD' ? 'write' : 'read', signal: this.options.signal,
      capabilities: stage === 'VERIFY' ? {diagnostics: run.plan.project.checks.filter(c => run.plan.verification?.diagnostics.includes(c.id))
        .map(c => [c.command, ...c.args].map(arg => arg.includes(' ') ? JSON.stringify(arg) : arg).join(' ')), browserTools: run.plan.verification?.browserTools || []} : undefined,
      onSpawn: pid => {run.childPid = pid; run.childStartedAt = now(); this.store.save(run, 'client.started', {pid, stage, task: task?.id});},
      onSession: session => {if (sessions[stage] !== session) {sessions[stage] = session; this.store.save(run, 'client.session', {session, stage, task: task?.id});}},
    }).finally(() => {
      // Keep a live PID after unexpected IO/state errors: recovery must not create a second executor.
      if (!alive(run.childPid)) {run.childPid = undefined; run.childStartedAt = undefined; this.store.save(run, 'client.exited');}
    });
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
            `Easy Skills requires a decision: ${run.pendingDecision.question}\n\nRequest: ${run.pendingDecision.id}\nPlan: ${run.planHash}\nRevision: ${run.pendingDecision.head}\n\nReply with the entire comment:\n/easy-skills answer ${run.id} ${run.planHash} ${run.pendingDecision.id} "YOUR ANSWER"`);
        }
        throw new Blocked(result.summary);
      }
      throw new Error(result.summary + '\n' + result.findings.join('\n'));
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
    await git.clean(cwd);
    const head = await git.head(cwd), evidence: Evidence[] = [];
    for (const check of run.plan.project.checks) {
      this.checkpoint(run);
      const lock = check.resource ? this.store.acquire('environment:' + check.resource) : undefined;
      try {
        run.activeResource = check.resource;
        const log = join(ensureDir(join(this.store.home, 'logs', run.id)), `check-${check.id}-${Date.now()}.log`);
        const result = await execute(check, {cwd, timeoutMs: check.timeoutMs, log, signal: this.options.signal,
          onSpawn: pid => {run.childPid = pid; run.childStartedAt = now(); this.store.save(run, 'check.started', {check: check.id, pid, baseline});}})
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
    recordFailure(this.store, run, `task:${state.id}:${state.cursor}`, error, head);
    state.cursor = 'BUILD'; state.reviewHead = undefined; state.evidence = [];
    this.store.save(run, 'task.repair', {task: state.id, count: run.failures.count, reason: redact(message(error))});
    if (run.failures.count >= 3) throw new Blocked('Three identical unsuccessful repair cycles without progress: ' + message(error));
  }
  private async task(run: Run, state: TaskState, task: Task, git: Git, github: GitHub) {
    if (!state.worktree) {
      state.branch = `issue/${run.plan.featureId}-${task.id}`;
      state.worktree = await this.ownedWorktree(run, git, state.branch, run.branch, task.id);
      this.store.save(run, 'task.worktree.created', {task: task.id});
    }
    const cwd = state.worktree;
    while (!state.integrated) {
      this.checkpoint(run);
      try {
        switch (state.cursor) {
          case 'BUILD': {
            if (state.pr) {
              const pr = await github.viewPr(state.pr.number);
              if (pr.state === 'MERGED') {state.cursor = 'INTEGRATE'; this.store.save(run, 'task.merge.recovered'); break;}
              await github.setIssue(state.issue!, true, 'Implementation is being repaired; previous readiness is invalid.');
            }
            await this.agent(run, 'BUILD', cwd, state, task,
              run.failures.count ? `Previous repair failed: ${run.reason}. Cleaned failure bundle: ${JSON.stringify({...this.store.operation<object>(`${run.id}:failure-bundle`), previousUnsuccessfulAttempts: run.failures.count})}. Repair the failing acceptance criteria.` : 'Implement the approved task. Keep Git commits under runner control.');
            state.head = await git.commit(cwd, task.title);
            await git.clean(cwd);
            state.cursor = 'VERIFY'; state.evidence = []; state.reviewHead = undefined;
            this.store.save(run, 'task.built', {task: task.id, head: state.head}); break;
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
        if (error instanceof Blocked || error instanceof ClientError || error instanceof ResourceBusy) throw error;
        if (['SHIP', 'INTEGRATE'].includes(state.cursor)) {
          const kind = classify(message(error));
          if (kind === 'network' || kind === 'quota') throw new ClientError(kind, message(error));
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
    const prior = this.store.operation<{state: string; base: string; operationId?: string}>(key);
    if (prior?.state === 'enqueued') throw new ClientError('network', 'Merge queued; waiting for actual GitHub merge');
    const intent = {state: 'executing', base, head, planHash: run.planHash, operationId: prior?.operationId};
    this.store.recordOperation(key, run.id, 'merge.intent', intent);
    const result = await github.merge(pr.number, head, {base, policy: run.plan.project.mergePolicy, operationId: prior?.operationId});
    this.store.recordOperation(key, run.id, 'merge.' + result.state, {...intent, ...result});
    if (result.state !== 'merged') throw new ClientError('network', 'Merge ' + result.state + '; waiting for actual GitHub merge');
  }
  async sync(run: Run, cwd: string, target: string, git: Git, state?: TaskState, task?: Task) {
    this.checkpoint(run);
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
      await git.commit(cwd, `Sync ${target}`);
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
      if (run.finalPhase === 'SYNC') {
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
        if (error instanceof Blocked || error instanceof ClientError || error instanceof ResourceBusy || !['VERIFY', 'REVIEW'].includes(run.finalPhase)) throw error;
        const head = await git.head(cwd);
        recordFailure(this.store, run, `feature:${run.finalPhase}`, error, head);
        run.reason = redact(message(error));
        this.store.save(run, 'feature.repair', {count: run.failures.count, reason: run.reason});
        if (run.failures.count >= 3) throw new Blocked('Three identical unsuccessful whole-feature repairs without progress: ' + run.reason);
        await this.agent(run, 'BUILD', cwd, undefined, undefined, `Repair whole-feature acceptance or review failure: ${run.reason}. Cleaned failure bundle: ${JSON.stringify({...this.store.operation<object>(`${run.id}:failure-bundle`), previousUnsuccessfulAttempts: run.failures.count})}. Preserve all integrated tasks.`);
        await git.commit(cwd, 'Repair whole-feature validation');
        run.finalPhase = 'SYNC'; run.finalReviewHead = undefined; run.finalEvidence = [];
        this.store.save(run, 'feature.repaired');
      }
    }
  }
  async syncManual(id: string): Promise<Run> {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id);
    try {
      if (!run.worktree || alive(run.childPid)) throw new Error('No safe integration worktree available');
      this.checkpoint(run);
      this.store.recordOperation(`${id}:manual-sync`, id, 'manual.sync', {pending: true});
      run.finalReviewHead = undefined; run.finalEvidence = []; run.finalPhase = 'SYNC';
      this.store.save(run, 'manual.sync.started');
      const git = new Git(run.root, operation => this.store.withLock('repository:' + run.commonDir, operation)); await git.fetch();
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
  async confirmFinalMerge(id: string, expectedHead: string): Promise<Run> {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id);
    try {
      this.checkpoint(run);
      if (run.status !== 'ready' || !run.finalPr || !run.worktree) throw new Error('Feature is not ready');
      const git = new Git(run.root, operation => this.store.withLock('repository:' + run.commonDir, operation)), github = this.options.github || new Gh(run.plan.project.repository, run.root);
      await git.clean(run.worktree); await git.fetch();
      const pr = await github.viewPr(run.finalPr.number);
      if (pr.baseRefName !== run.plan.project.mainBranch || pr.headRefName !== run.branch) throw new Error('PR target or source changed');
      if (pr.state === 'MERGED' && pr.mergedAt && pr.headRefOid === expectedHead && run.finalReviewHead === expectedHead) {
        run.finalPr = pr; run.status = 'merged';
        await github.setIssue(run.parentIssue!, false, `Feature merged: ${pr.url}`);
        this.store.save(run, 'feature.merge.reconciled'); return run;
      }
      if (pr.headRefOid !== expectedHead || run.finalReviewHead !== expectedHead || await git.head(run.worktree) !== expectedHead ||
        !this.sufficient(run, run.finalEvidence, expectedHead) ||
        run.syncedBase !== await git.run(['rev-parse', `origin/${run.plan.project.mainBranch}`])) throw new Error('Revision or base changed; sync and validate again');
      if (pr.state !== 'MERGED') await this.merge(run, github, pr, expectedHead, run.syncedBase!);
      const confirmed = await github.viewPr(pr.number);
      if (confirmed.state !== 'MERGED' || !confirmed.mergedAt) throw new Error('Final merge was not confirmed');
      run.finalPr = confirmed; run.status = 'merged';
      await github.setIssue(run.parentIssue!, false, `Feature merged: ${confirmed.url}`);
      this.store.save(run, 'feature.merged'); return run;
    } finally {this.store.release('run:' + id, owner);}
  }
  async reconcileFinalMerge(id: string): Promise<Run> {
    const run = this.store.get(id);
    if (run.status !== 'ready' || !run.finalPr) return run;
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
        this.checkpoint(run);
        const git = new Git(run.root, operation => this.store.withLock('repository:' + run.commonDir, operation));
        await git.fetch();
        const base = await git.run(['rev-parse', `origin/${run.plan.project.mainBranch}`]);
        if (base !== run.syncedBase || pr.headRefOid !== run.finalReviewHead) {
          run.status = 'approved'; run.finalPhase = 'SYNC'; run.finalReviewHead = undefined; run.finalEvidence = [];
          run.reason = 'Readiness revoked: target or source changed; sync, checks, review and a new merge confirmation are required';
          this.store.save(run, 'feature.readiness.revoked', {base, head: pr.headRefOid});
          this.store.enqueue(`${id}:revoked:${base}:${pr.headRefOid}`, {project: run.plan.project.name, feature: run.plan.title, state: run.status, reason: run.reason, url: pr.url});
        }
      }
    } finally {this.store.release('run:' + id, owner);}
    if (mergedHead) return this.confirmFinalMerge(id, mergedHead);
    const intent = this.store.operation<{state: string}>(`${id}:merge:${run.finalPr.number}:${run.finalReviewHead}`);
    if (run.status === 'ready' && intent && intent.state !== 'enqueued') {
      try {return await this.confirmFinalMerge(id, run.finalReviewHead!);}
      catch (error) {if (!(error instanceof ClientError && error.kind === 'network')) throw error;}
    }
    return run;
  }
}
