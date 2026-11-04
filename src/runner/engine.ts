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
import { alive, ensureDir, hash, inScope, message, now, redact, rulesHash, rejectSymlinkPath } from '../util.js';
import { assembleContext, type ContextManifest } from './context.js';
import { recordFailure, confirmedProgress } from './failures.js';
import { requireCompatibility } from './compatibility.js';
import { CheckFailure, failureBundle, cleanExcerpt } from './check-failure.js';
import { requireAgreement } from './onboarding.js';
import { assertProtected, protectedManifest } from './protected-inputs.js';
import { knowledgeSnapshot } from './discovery.js';
import { loadProject } from '../cli/project.js';
import { CodeFailure, startRepair, pendingRepair, completeRepair, repairKey, type Repair } from './repairs.js';
import { ownerAlive, processIdentity } from '../process-identity.js';
import { ignoredOutputs } from './setup-outputs.js';
import { publishRepairIssue, repairIssues, issueLabels, closeRepairIssues, allRepairs, milestone, milestoneKey, sliceRepairIssues } from './issue-history.js';
import { pullRequestBody, pullRequestTitle } from './pull-request.js';
import { DELEGATE_TIMEOUT_MS, MAX_DELEGATE_DECISIONS, acceptDelegateReply, delegatePrompt, narrowedPlan, narrowingViolation, type DelegateReply, type Narrowable } from './delegate.js';

class Blocked extends Error {}
/** Generated files whose full diff is too large to review line by line. */
const GENERATED_FILE = /(?:\.Designer\.cs|ModelSnapshot\.cs|\.g\.cs|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|packages\.lock\.json))$/i;
export interface EngineOptions {client?: Client; github?: GitHub; signal?: AbortSignal; testRemote?: string; delegateDecisions?: boolean}
/** Delegated decisions are on unless EASY_SKILLS_DELEGATE_DECISIONS=0, so BUILD to SHIP need no owner for questions the plan already settles. */
export const delegateDecisionsEnabled = () => process.env.EASY_SKILLS_DELEGATE_DECISIONS !== '0';
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
    const overlay = run.plan.workflow?.context || {};
    if (run.plan.workflow) {
      // Virtual knowledge may override old tracked context, never edits made by a stage.
      if (await git.run(['diff', '--name-only', run.plan.workflow.baseHead, '--', '.easy-skills'], cwd) ||
        await git.run(['ls-files', '--others', '--exclude-standard', '--', '.easy-skills'], cwd))
        throw new Blocked('Task changed managed project knowledge; preserve changes and review a replacement plan');
      const merging = existsSync(await git.run(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], cwd));
      if (!merging) {
        // A slice worktree may change only its own paths beyond the feature branch it started from; the feature branch
        // itself may hold the union of every slice's paths beyond main.
        const task = state && run.plan.tasks.find(t => t.id === state.id);
        const base = await git.run(['merge-base', task ? `refs/heads/${run.branch}` : `origin/${run.plan.project.mainBranch}`, 'HEAD'], cwd);
        const paths = task ? task.scope!.paths : run.plan.tasks.flatMap(t => t.scope!.paths);
        const changed = (await git.run(['diff', '--name-only', '-z', base, '--'], cwd)).split('\0').filter(Boolean);
        changed.push(...(await git.run(['ls-files', '--others', '--exclude-standard', '-z'], cwd)).split('\0').filter(Boolean));
        const outside = changed.filter(p => !inScope(p, paths));
        if (outside.length) throw new Blocked('Changes exceed the approved task paths: ' + outside.join(', '));
      }
    }
    if (rulesHash(cwd, overlay) !== run.plan.rulesHash) throw new Blocked('Worktree instructions or client configuration changed; preserve changes and review a replacement plan');
    if (!run.plan.protectedInputs) throw new Blocked('Legacy plan lacks approved protected verification inputs');
    try {assertProtected(cwd, run.plan.project, run.plan.protectedInputs, overlay);} catch (error) {throw new Blocked(message(error));}
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
    if (run.plan.workflow) for (const [path, content] of Object.entries(run.plan.workflow.context)) {
      rejectSymlinkPath(run.root, join(run.root, path));
      if (readFileSync(join(run.root, path), 'utf8') !== content) throw new Error('Project knowledge changed since the task proposal');
    }
    run.approvedHash = expectedHash; run.status = 'approved';
    this.store.save(run, 'plan.approved', {hash: expectedHash}); return run;
  }
  /** Replace a ready direct task only after review of a new immutable plan and exact head. */
  async revise(id: string, input: unknown, expectedHash: string, previousHash: string, head: string): Promise<Run> {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id);
    try {
      const plan = Plan.parse(input);
      if (run.status !== 'ready' || !run.plan.workflow || !plan.workflow || ownerAlive(run.childPid, run.childIdentity))
        throw new Error('Feedback requires a ready direct task with no live client');
      if (run.planHash !== previousHash || hash(plan) !== expectedHash || run.finalReviewHead !== head)
        throw new Error('Feedback proposal is stale; review the current plan and revision');
      for (const field of ['featureId', 'project', 'workflow', 'permissions'] as const)
        if (hash(plan[field]) !== hash(run.plan[field])) throw new Error('Feedback cannot change task identity or external permissions: ' + field);
      // Merged slices, their Issues and PRs are history: feedback adds slices and never rewrites one.
      const sliced = plan.workflow.mode === 'slices';
      if (sliced && run.plan.tasks.some(task => hash(plan.tasks.find(t => t.id === task.id) ?? null) !== hash(task)))
        throw new Error('Feedback on a sliced feature keeps every earlier slice unchanged and adds new slices');
      const intent = this.store.operation<{state: string}>(`${id}:merge:${run.finalPr!.number}:${head}`);
      if (intent && !['failed', 'expired', 'cancelled'].includes(intent.state)) throw new Error('Reconcile the outstanding merge before revising');
      const git = this.git(run), github = this.options.github || new Gh(run.plan.project.repository, run.root);
      await this.guard(run, run.worktree!); await git.clean(run.worktree!);
      const pr = await github.viewPr(run.finalPr!.number);
      if (pr.state !== 'OPEN' || pr.headRefOid !== head || await git.head(run.worktree!) !== head || pr.headRefName !== run.branch || pr.baseRefName !== run.plan.project.mainBranch)
        throw new Error('PR or local revision changed; reconcile before revising');
      const previous = structuredClone({plan: run.plan, planHash: run.planHash, approvedHash: run.approvedHash, head,
        evidence: run.finalEvidence, reviewHead: run.finalReviewHead, sessions: run.finalSessions});
      // Validate using the same approval path; rollback leaves the original ready record intact.
      this.store.transaction(() => {
        this.store.recordOperation(`${id}:approval:${run.planHash}`, id, 'approval.history', previous);
        for (const stage of Object.keys(run.finalSessions) as Stage[])
          if (hash(plan.assignments[stage]) !== hash(run.plan.assignments[stage])) delete run.finalSessions[stage];
        run.plan = plan; run.planHash = expectedHash; run.approvedHash = undefined; run.status = 'draft';
        run.finalReviewHead = undefined; run.finalEvidence = []; run.finalPhase = 'SYNC';
        run.tasks = plan.tasks.map(t => (sliced && run.tasks.find(s => s.id === t.id)) || {id: t.id, cursor: 'BUILD', integrated: false, evidence: [], sessions: {}});
        run.pendingDecision = undefined;
        this.store.save(run, 'feedback.proposed');
        this.approve(id, expectedHash);
      });
      return this.store.get(id);
    } finally {this.store.release('run:' + id, owner);}
  }
  /**
   * A task stopped for a decision can need checks that its approved plan lacks; neither an answer nor feedback may add them.
   * After the owner approves a new project configuration, this binds the task to it, keeping its branch, commits and any
   * pending repair. Approved checks can be added but never removed or changed.
   */
  /**
   * The owner removes acceptance criteria of one task that its approved checks and the runner's recorded evidence cannot verify,
   * where the delegate may not (its limits are stricter). Like adoptConfiguration it is reviewed by hash: without the hash it only
   * shows the proposal. Nothing but the named criteria changes; branch, worktrees, sessions, repairs and Issue/PR links stay.
   */
  async narrowAcceptance(id: string, taskId: string, remove: number[], reason: string, approvedHash?: string) {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id);
    try {
      if (!['needs_decision', 'paused'].includes(run.status) || ownerAlive(run.childPid, run.childIdentity))
        throw new Error('Only a task stopped for a decision or paused, with no live client, can be narrowed');
      const target = run.plan.tasks.find(t => t.id === taskId);
      if (!target) throw new Error('No such task in the approved plan: ' + taskId);
      const indexes = [...remove].sort((a, b) => a - b);
      if (!reason.trim()) throw new Error('A reason is required');
      if (!indexes.length || new Set(indexes).size !== indexes.length || indexes.some(index => !Number.isInteger(index) || index < 0 || index >= target.acceptance.length))
        throw new Error('Name existing, distinct criteria by their 0-based numbers');
      if (indexes.length >= target.acceptance.length) throw new Error('At least one criterion must remain');
      const plan = narrowedPlan(run.plan, taskId, indexes), violation = narrowingViolation(run.plan, plan, taskId, indexes);
      if (violation) throw new Error(violation);
      const proposal = {runId: id, taskId, removed: indexes.map(index => target.acceptance[index]!), remaining: plan.tasks.find(t => t.id === taskId)!.acceptance,
        reason: redact(reason), previousPlanHash: run.planHash, planHash: hash(plan)};
      const digest = hash(proposal);
      if (!approvedHash) return {...proposal, hash: digest, status: run.status};
      if (approvedHash !== digest) throw new Error('The proposal changed; review it again');
      const previous = {plan: run.plan, planHash: run.planHash, approvedHash: run.approvedHash};
      this.store.transaction(() => {
        this.store.recordOperation(`${id}:approval:${run.planHash}`, id, 'approval.history', previous);
        run.plan = plan; run.planHash = proposal.planHash; run.approvedHash = proposal.planHash;
        run.pendingDecision = undefined; run.failures = {fingerprint: '', head: '', count: 0};
        run.status = 'approved';
        this.store.save(run, 'plan.narrowed', {owner: true, task: taskId, previous: previous.planHash, planHash: run.planHash, removed: proposal.removed.map(text => redact(text)),
          rationale: proposal.reason, removedCount: indexes.length, remaining: proposal.remaining.length});
        this.store.recordOperation(`${id}:resume-request`, id, 'narrow.resume', {resume: true});
      });
      const issue = run.tasks.find(t => t.id === taskId)?.issue || run.parentIssue;
      if (issue) {
        try {
          const github = this.options.github || new Gh(run.plan.project.repository, run.root);
          await github.commentOnce(issue, 'narrow:' + run.planHash, redact(`Plan change approved by the owner's delegate (hash-reviewed).\n\nRemoved acceptance criteria:\n${proposal.removed.map(text => '- ' + text).join('\n')}\n\nWhy: ${proposal.reason}\n\nScope paths, checks, permissions and every other criterion are unchanged. New plan: ${run.planHash}`));
        } catch { /* the record in the run history stands */ }
      }
      return {...proposal, hash: digest, status: run.status};
    } finally {this.store.release('run:' + id, owner);}
  }
  async adoptConfiguration(id: string, approvedHash?: string, extraRepairs = 0, issueHistory = false) {
    const owner = this.store.acquire('run:' + id), run = this.store.get(id);
    try {
      if (!['needs_decision', 'paused'].includes(run.status) || ownerAlive(run.childPid, run.childIdentity))
        throw new Error('Only a task stopped for a decision or paused, with no live client, can adopt a new project configuration');
      if (!run.plan.workflow || !run.worktree) throw new Error('Only a direct task with an integration worktree can adopt a new project configuration');
      const project = loadProject(run.root), previous = run.plan.project;
      for (const field of ['name', 'repository', 'mainBranch', 'remote', 'githubTransport'] as const)
        if (project[field] !== previous[field]) throw new Error('A new configuration cannot change task identity: ' + field);
      const removed = previous.checks.filter(check => !project.checks.some(c => hash(c) === hash(check)));
      if (removed.length) throw new Error('A new configuration cannot remove or change approved checks: ' + removed.map(c => c.id).join(', '));
      if (!Number.isInteger(extraRepairs) || extraRepairs < 0 || extraRepairs > 5) throw new Error('Extra repair attempts must be a whole number from 1 to 5');
      // A sliced feature stops inside its current slice, whose repairs carry their own limit.
      const slice = run.plan.workflow.mode === 'slices' ? run.tasks.find(t => !t.integrated) : undefined, scope = slice ? `task:${slice.id}` : 'feature';
      const repairs = this.store.operation<Repair[]>(repairKey(run, scope)) || [], completed = repairs.filter(r => r.state === 'completed').length;
      // Raising the limit is an owner decision inside the new plan; it counts attempts already made and never lowers the limit.
      const limit = extraRepairs ? Math.max(run.plan.repairPolicy?.maxCompletedAttempts ?? 0, completed + extraRepairs) : run.plan.repairPolicy?.maxCompletedAttempts;
      const plan = Plan.parse({...run.plan, project, protectedInputs: protectedManifest(run.root, project), rulesHash: rulesHash(run.root),
        // Tasks approved before Issue history existed publish it only after the owner grants it here.
        rulesAgreement: requireAgreement(run.root), workflow: {...run.plan.workflow, context: knowledgeSnapshot(run.root), ...(issueHistory ? {issueHistory: true} : {})},
        ...(limit === undefined ? {} : {repairPolicy: {maxCompletedAttempts: limit}})});
      if (hash(plan) === run.planHash) throw new Error('The task already uses the approved project configuration');
      const proposal = {runId: id, previousPlanHash: run.planHash, planHash: hash(plan), rulesAgreement: plan.rulesAgreement,
        addedChecks: project.checks.filter(check => !previous.checks.some(c => hash(c) === hash(check))),
        setupChanged: hash(project.setup || []) !== hash(previous.setup || []), phase: run.finalPhase,
        repairLimit: {from: run.plan.repairPolicy?.maxCompletedAttempts, to: plan.repairPolicy?.maxCompletedAttempts, completed},
        issueHistory: {from: !!run.plan.workflow.issueHistory, to: !!plan.workflow!.issueHistory, repairs: repairs.length}};
      const digest = hash(proposal);
      if (!approvedHash) return {...proposal, hash: digest, status: run.status};
      if (approvedHash !== digest) throw new Error('The configuration proposal changed; review it again');
      const changedInputs = Object.keys({...run.plan.protectedInputs, ...plan.protectedInputs})
        .filter(path => run.plan.protectedInputs?.[path] !== plan.protectedInputs?.[path]);
      this.store.transaction(() => {
        this.store.recordOperation(`${id}:approval:${run.planHash}`, id, 'approval.history', {plan: run.plan, planHash: run.planHash, approvedHash: run.approvedHash});
        // Setup already passed with the same commands; only the adopted configuration files and inputs newly named by the
        // added checks differ, so it stays valid and a pending repair keeps its uncommitted work.
        if (!proposal.setupChanged && changedInputs.every(path => path.startsWith('.easy-skills/') || !(path in (run.plan.protectedInputs || {})))) {
          const before = hash({commands: previous.setup || [], inputs: run.plan.protectedInputs});
          for (const cwd of [run.worktree!, ...run.tasks.map(t => t.worktree).filter((p): p is string => !!p)]) {
            const key = `${id}:setup:${hash(cwd)}`, setup = this.store.operation<{fingerprint: string; status: string}>(key);
            if (setup?.status === 'passed' && setup.fingerprint === before)
              this.store.recordOperation(key, id, 'setup.adopted', {...setup, fingerprint: hash({commands: project.setup || [], inputs: plan.protectedInputs})});
          }
        }
        // The owner approved a new plan: completed repairs no longer count against its limit, unless the owner raised the limit itself.
        if (repairs.length && !extraRepairs) {
          this.store.recordOperation(`${repairKey(run, scope)}:superseded:${run.planHash}`, id, 'repair.superseded', repairs);
          this.store.recordOperation(repairKey(run, scope), id, 'repair.adopted', repairs.filter(r => r.state === 'pending').map(r =>
            ({...r, reason: r.reason + '\nThe owner approved a revised project configuration adding checks: ' + proposal.addedChecks.map(c => c.id).join(', ') + '. The runner records their results.'})));
        }
        run.plan = plan; run.planHash = proposal.planHash; run.approvedHash = proposal.planHash;
        run.pendingDecision = undefined; run.failures = {fingerprint: '', head: '', count: 0};
        run.finalEvidence = []; run.finalReviewHead = undefined;
        if (run.finalPhase !== 'REPAIR') run.finalPhase = 'SYNC';
        run.status = 'approved';
        this.store.save(run, 'plan.configuration.adopted', {previous: proposal.previousPlanHash, planHash: proposal.planHash, added: proposal.addedChecks.map(c => c.id)});
        this.store.recordOperation(`${id}:resume-request`, id, 'configuration.resume', {resume: true});
      });
      return {...proposal, hash: digest, status: run.status};
    } finally {this.store.release('run:' + id, owner);}
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
      if (run.plan.workflow?.mode === 'direct') await this.directBuild(run, git);
      // Advanced tasks and slices: each in dependency order through its own worktree, PR and merge into the feature branch.
      while (run.plan.workflow?.mode !== 'direct' && run.tasks.some(t => !t.integrated)) {
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
    if (!git.author && !await git.hasAuthor()) {
      if (!github.author) throw new Blocked('Git has no author identity (user.name and user.email) for task commits');
      git.author = await github.author();
    }
    if (!run.worktree) {
      run.worktree = await this.ownedWorktree(run, git, run.branch, run.plan.workflow?.baseHead || `origin/${run.plan.project.mainBranch}`, 'integration');
      // Approved scope may name inputs that exist only as uncommitted files in the source checkout.
      const carried = await git.carryUncommitted(run.root, run.worktree, [...new Set(run.plan.tasks.flatMap(task => task.scope?.paths || []))]);
      if (carried.length) await git.commit(run.worktree, 'Add uncommitted task inputs from the source checkout');
      this.store.save(run, 'integration.created', carried.length ? {carried} : {});
    }
    await git.carryIgnoredControls(run.root, run.worktree);
    await this.guard(run, run.worktree);
    const sliced = run.plan.workflow?.mode === 'slices';
    // A sliced feature is published as a whole right after approval: its milestone, the parent and one Issue per slice.
    if (sliced && !milestone(this.store, run)) {
      const number = await github.milestone(run.plan.title, `${run.plan.featureId}: ${run.plan.tasks.length} slices merged into ${run.branch}, then one PR to ${run.plan.project.mainBranch}.\nRun: ${run.id}`);
      this.store.recordOperation(milestoneKey(run), run.id, 'github.milestone.created', number);
    }
    const metadata = sliced ? {labels: issueLabels(run, false), assignSelf: true, milestone: milestone(this.store, run)} : {labels: issueLabels(run, false), assignSelf: true};
    if (run.plan.workflow?.issueHistory && !run.parentIssue) {
      run.parentIssue = await github.issue(`${run.id}:feature`, run.plan.title,
        `## Trigger / current behavior\n\n${run.plan.spec}\n\n## Acceptance criteria\n\n${run.plan.tasks.flatMap(t => t.acceptance).map(a => '- ' + a).join('\n')}\n\n## Development history\n\nRun: ${run.id}\nApproved plan: ${run.planHash}\n${sliced ? 'Slice Issues, their PRs into ' + run.branch + ', bug Issues' : 'Repair Issues'} and the verified delivery PR will be linked here.`,
        metadata);
      this.store.save(run, 'github.parent.created');
    }
    const ordered: Task[] = [];
    while (ordered.length < run.plan.tasks.length) ordered.push(...run.plan.tasks.filter(t => !ordered.includes(t) && t.dependsOn.every(dep => ordered.some(o => o.id === dep))));
    if (sliced) for (const task of ordered) {
      const state = run.tasks.find(t => t.id === task.id)!;
      if (state.issue) continue;
      state.issue = await github.issue(`${run.id}:task:${task.id}`, task.title,
        `## Slice\n\n${task.description}\n\n## Acceptance criteria\n\n${task.acceptance.map(a => '- ' + a).join('\n')}\n\n## Scope\n\n${task.scope!.paths.map(p => '- `' + p + '`').join('\n')}\n\n` +
        `Dependencies: ${task.dependsOn.map(dep => `${dep} (#${run.tasks.find(t => t.id === dep)?.issue})`).join(', ') || 'none'}\nParent: #${run.parentIssue}\nApproved plan: ${run.planHash}\n\n` +
        `The runner merges this slice's verified and reviewed PR into \`${run.branch}\` and closes this Issue after that merge.`, metadata);
      this.store.save(run, 'github.task.created', {task: task.id, issue: state.issue});
    }
    // A task granted Issue history after repairs already happened publishes those repairs too, so GitHub shows every round.
    if (run.plan.workflow?.issueHistory) for (const repair of allRepairs(this.store, run))
      if (repair.state === 'completed') await publishRepairIssue(this.store, run, github, repair);
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
    if (run.plan.workflow?.mode === 'direct') return;
    if (sliced && (!run.plan.workflow!.permissions.pushBranch || !run.plan.workflow!.permissions.createPullRequest))
      throw new Blocked('The approved feature does not authorize branch push and PR creation');
    if (!sliced && !run.plan.permissions.publishIssues) throw new Blocked('Publishing Issues and PRs is not authorized by this plan');
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
      if (!state.issue && !sliced) {
        state.issue = await github.issue(`${run.id}:task:${task.id}`, task.title,
          `${task.description}\n\nAcceptance:\n${task.acceptance.map(a => '- ' + a).join('\n')}\n\nDependencies: ${task.dependsOn.join(', ') || 'none'}\n\nParent: #${run.parentIssue}\nApproved plan: ${run.planHash}`);
        this.store.save(run, 'github.task.created', {task: task.id, issue: state.issue});
      }
    }
  }
  private async directBuild(run: Run, git: Git) {
    const task = run.tasks[0]!;
    if (task.integrated) return;
    await this.build(run, git, run.worktree!, undefined, undefined, `direct-${run.planHash}`,
      'Implement the single approved task and regression tests. Keep Git commits under runner control.');
    task.head = await git.head(run.worktree!); task.integrated = true;
    run.finalPhase = 'SYNC'; run.finalReviewHead = undefined; run.finalEvidence = [];
    this.store.save(run, 'direct.built', {head: task.head});
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
  /**
   * A stage that returns blocked with a question is answered by a read-only delegate on the PLAN model when the answer stays
   * inside the approved plan; anything that would widen scope, rules, rights or touch real systems, and any question already
   * answered once, still goes to the owner. Every delegated answer is recorded and, for a task with an Issue, commented on it.
   */
  private async delegate(run: Run, cwd: string, stage: Stage, task: Task | undefined, decision: NonNullable<Run['pendingDecision']>, result: StageResult): Promise<(DelegateReply & {narrowed?: string}) | undefined> {
    if (!this.options.delegateDecisions || !run.plan.workflow) return undefined;
    const key = `${run.id}:delegate-decisions`, state = this.store.operation<{asked: string[]; questions: string[]; amendments?: number}>(key) || {asked: [], questions: []};
    if (state.asked.length >= MAX_DELEGATE_DECISIONS || state.asked.includes(hash(decision.question))) return undefined;
    // Only the criteria of the task the stage works on can be narrowed: a slice's own, or the single task of a direct run.
    const target = task || (run.plan.workflow.mode === 'direct' ? run.plan.tasks[0] : undefined);
    const narrowable: Narrowable | undefined = target && {taskId: target.id, acceptance: target.acceptance, amendments: state.amendments || 0};
    let reply, answered = false;
    // A delegate call that hangs (a real one sat for 22 minutes with no output) must not hold the run: it gets a time limit and one retry, then the question goes to the owner.
    for (let attempt = 0; attempt < 2 && !answered; attempt++) {
      try {
        const raw = await this.client.run(run.plan.assignments.PLAN, delegatePrompt(run.plan, stage, task, decision.question, result.summary, result.findings, state.questions, narrowable), {
          cwd, stage: 'PLAN', projectRoot: run.root, mode: 'read', signal: this.options.signal, timeoutMs: DELEGATE_TIMEOUT_MS});
        reply = raw.outcome === 'passed' ? acceptDelegateReply(raw.summary, state.asked, decision.question, narrowable) : undefined; answered = true;
      } catch (error) {
        if (this.options.signal?.aborted) throw error;
        this.store.event(run.id, 'delegate.failed', {request: decision.id, stage, attempt: attempt + 1, reason: redact(message(error)).slice(0, 200)});
      }
    }
    if (!answered) return undefined;
    const asked = {asked: [...state.asked, hash(decision.question)], questions: [...state.questions, redact(decision.question).slice(0, 300)], amendments: state.amendments || 0};
    if (reply?.resolution === 'narrow') return this.narrow(run, stage, target!, decision, reply, key, asked);
    this.store.recordOperation(key, run.id, 'delegate.asked', asked);
    if (!reply) {this.store.event(run.id, 'decision.escalated', {request: decision.id, stage, task: task?.id}); return undefined;}
    this.store.event(run.id, 'decision.delegated', {request: decision.id, stage, task: task?.id, category: reply.category, question: redact(decision.question), answer: redact(reply.answer), rationale: redact(reply.rationale)});
    const issue = run.tasks.find(t => t.id === task?.id)?.issue || run.parentIssue;
    if (issue) {
      try {
        const github = this.options.github || new Gh(run.plan.project.repository, run.root);
        await github.commentOnce(issue, 'delegate:' + decision.id, redact(`Autonomous decision (no owner was asked) during ${stage}.\n\nQuestion: ${decision.question}\n\nAnswer: ${reply.answer}\n\nWhy it stays inside the approved plan: ${reply.rationale}`));
      } catch { /* the record in the run history stands */ }
    }
    return reply;
  }
  /**
   * Applies a delegate's amendment that removes unverifiable acceptance criteria, the way adoptConfiguration binds a task to a
   * new plan, but without an owner: the previous plan goes to the approval history, the amended one (identical except those
   * criteria, proven by narrowingViolation) is approved under its own hash, and the run keeps its branch, worktrees, sessions,
   * cursors, repairs and links. The stage the agent stopped in then continues with the amended plan.
   */
  private async narrow(run: Run, stage: Stage, target: Task, decision: NonNullable<Run['pendingDecision']>, reply: DelegateReply, key: string, asked: {asked: string[]; questions: string[]; amendments: number}) {
    const remove = [...reply.removeAcceptance].sort((a, b) => a - b), removed = remove.map(index => target.acceptance[index]!);
    const plan = narrowedPlan(run.plan, target.id, remove), violation = narrowingViolation(run.plan, plan, target.id, remove);
    if (violation) {
      this.store.recordOperation(key, run.id, 'delegate.asked', asked);
      this.store.event(run.id, 'decision.escalated', {request: decision.id, stage, task: target.id, reason: violation});
      return undefined;
    }
    const previous = {plan: run.plan, planHash: run.planHash, approvedHash: run.approvedHash};
    this.store.transaction(() => {
      this.store.recordOperation(key, run.id, 'delegate.asked', {...asked, amendments: asked.amendments + 1});
      this.store.recordOperation(`${run.id}:approval:${run.planHash}`, run.id, 'approval.history', previous);
      run.plan = plan; run.planHash = hash(plan); run.approvedHash = run.planHash;
      run.pendingDecision = undefined; run.failures = {fingerprint: '', head: '', count: 0};
      this.store.save(run, 'plan.narrowed', {request: decision.id, stage, task: target.id, previous: previous.planHash, planHash: run.planHash,
        removed: removed.map(text => redact(text)), rationale: redact(reply.rationale), removedCount: remove.length,
        remaining: plan.tasks.find(t => t.id === target.id)!.acceptance.length, amendments: asked.amendments + 1});
    });
    const issue = run.tasks.find(t => t.id === target.id)?.issue || run.parentIssue;
    if (issue) {
      try {
        const github = this.options.github || new Gh(run.plan.project.repository, run.root);
        await github.commentOnce(issue, 'narrow:' + decision.id, redact(`Autonomous plan change (no owner was asked) during ${stage}.\n\nRemoved acceptance criteria:\n${removed.map(text => '- ' + text).join('\n')}\n\nWhy: ${reply.rationale}\n\nThis change only removed requirements that cannot be verified with the approved project checks; scope paths, checks, permissions and every other criterion are unchanged. New plan: ${run.planHash}`));
      } catch { /* the record in the run history stands */ }
    }
    return {...reply, narrowed: `\nThe owner is not available. Your delegate narrowed the approved plan (request ${decision.id}) because these acceptance criteria cannot be satisfied with the approved project checks and runner-recorded evidence: ${JSON.stringify(removed)}. Rationale: ${reply.rationale} They are no longer required and must not be reported as missing; every remaining criterion still applies unchanged.`};
  }
  private async agent(run: Run, stage: Stage, cwd: string, taskState?: TaskState, task?: Task, extra = '', skill?: string, collectReview = true): Promise<StageResult> {
    // A delegate may have amended the plan since the caller picked its task; the amended criteria are the approved ones.
    if (task) task = run.plan.tasks.find(t => t.id === task!.id) || task;
    const entryExtra = extra;
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
      // A file whose diff against the same base already passed review keeps that result across repair commits.
      const passedKey = `${run.id}:review-passed:${task?.id || 'feature'}`;
      const saved = this.store.operation<{base: string; passed: {path: string; diffHash: string}[]}>(passedKey);
      const passed = saved?.base === base ? saved.passed : [];
      let result: StageResult = {outcome: 'passed', summary: 'No changed paths', findings: []};
      const failures: string[] = [], seenFindings = new Set<string>();
      let repeats = 0;
      for (const path of files) {
        let diff: string;
        try {diff = await new Git(cwd).run(['diff', '--no-ext-diff', '--no-textconv', base, 'HEAD', '--', path], cwd);}
        catch {throw new ClientError('review_input', 'Cannot capture complete file diff; split the task or request an explicit review decision');}
        const entry = {path, diffHash: hash(diff)};
        let shown = diff;
        if (/^Binary files /m.test(diff)) throw new ClientError('review_input', 'File diff requires a separate review decision: ' + path);
        if (diff.length > 200_000) {
          // Generated output (EF migration designers and snapshots, lock files) is checked through its head and tail, with the
          // omission stated to the reviewer; any other oversized file still needs an owner decision.
          if (!GENERATED_FILE.test(path)) throw new ClientError('review_input', 'File diff requires a separate review decision: ' + path);
          shown = diff.slice(0, 60_000) + `\n\n[The runner omitted ${diff.length - 80_000} characters from the middle of this generated file's diff. Review the head and tail shown and the source that produces it.]\n\n` + diff.slice(-20_000);
        }
        const known = (previousCoverage?.base === base && previousCoverage.covered.some(c => c.path === path && c.diffHash === entry.diffHash)) ||
          passed.some(c => c.path === path && c.diffHash === entry.diffHash);
        if (!known) {
          // Every file is reviewed before repair, so one repair receives all findings instead of one file's per round.
          try {result = await this.agent(run, stage, cwd, taskState, task, extra + `\nReview complete file ${JSON.stringify(path)} against ${base}:\n${shown}` +
            '\nReport only problems located in this file or caused by its diff. Other changed files are reviewed in separate requests; if this file has no problem, return passed even when you noticed issues elsewhere.', skill, false);}
          catch (error) {
            if (!(error instanceof CodeFailure)) throw error;
            await new Git(cwd).clean(cwd);
            if (await new Git(cwd).head(cwd) !== head) throw new Blocked('REVIEW changed the revision; coverage was not accepted');
            // A reviewer that answers every file with the same text is judging the whole commit: keep the text once and stop the round
            // after three repeats instead of paying for every remaining file; the repair comes first, the rest is reviewed afterwards.
            const text = message(error), fingerprint = hash(text);
            if (seenFindings.has(fingerprint)) {
              if (++repeats >= 3) {failures.push(`(Stopped after ${repeats} further files returned this same result; the files not yet reviewed are reviewed after the repair.)`); break;}
              continue;
            }
            seenFindings.add(fingerprint); repeats = 0; failures.push(`${path}:\n${text}`);
            continue;
          }
        }
        await new Git(cwd).clean(cwd);
        if (await new Git(cwd).head(cwd) !== head) throw new Blocked('REVIEW changed the revision; coverage was not accepted');
        covered.push(entry);
        this.store.recordOperation(key, run.id, 'review.coverage', {head, base, required: files, covered});
        this.store.recordOperation(passedKey, run.id, 'review.passed', {base, passed: [...passed.filter(c => c.path !== path), entry]});
        passed.splice(0, passed.length, ...passed.filter(c => c.path !== path), entry);
      }
      if (failures.length) throw new CodeFailure(`REVIEW found problems in ${failures.length} of ${files.length} changed files:\n\n` + failures.join('\n\n'));
      if (!files.length) result = await this.agent(run, stage, cwd, taskState, task, extra + '\nRunner observed no changed paths.', skill, false);
      return result;
    }
    const question = run.pendingDecision;
    if (question && question.stage === stage && question.taskId === task?.id) {
      if (!question.answer) throw new Blocked('Awaiting answer to decision request ' + question.id);
      if (question.planHash !== run.planHash || question.head !== await new Git(cwd).head(cwd)) throw new Blocked('Decision answer is stale after plan or revision change');
      extra += question.source === 'delegate'
        ? `\nThe owner is not available. Your delegate answered request ${question.id}: ${JSON.stringify({question: question.question, answer: question.answer})}. Treat as clarification within the approved scope, never permission to expand rules, models, checks, publication or merge rights.`
        : `\nHuman response to request ${question.id}: ${JSON.stringify({question: question.question, answer: question.answer})}. Treat as clarification within the approved scope, never permission to expand rules, models, checks, publication or merge rights.`;
    }
    const sessions = taskState ? taskState.sessions : run.finalSessions;
    const contextKey = `${run.id}:context:${task?.id || 'feature'}:${stage}`;
    const previous = this.store.operation<{session: string; manifest: ContextManifest}>(contextKey);
    // Without this, REVIEW took carried planning files for unrelated additions and asked to delete what VERIFY required.
    const carried = (this.store.events(run.id) as {type: string; data: string}[]).find(e => e.type === 'integration.created');
    const inputs: string[] = carried ? JSON.parse(carried.data || '{}').carried || [] : [];
    if ((stage === 'VERIFY' || stage === 'REVIEW') && inputs.length)
      extra += '\nApproved task inputs carried from the source checkout into the first task commit; they belong to this task, update them in place and never delete them as unrelated additions: ' + JSON.stringify(inputs);
    // Codex BUILD blocked twice on a test host that could not open a socket inside its sandbox, although the runner runs checks itself.
    if (stage === 'BUILD') extra += '\nAfter BUILD the runner runs every approved check outside your sandbox: ' + JSON.stringify(run.plan.project.checks.map(c => c.id)) +
      '. A build or test that cannot run in your sandbox for an environmental reason is not a reason to return blocked; finish the change, report the command and error in findings, and return passed.';
    if (stage === 'VERIFY') extra += '\nJudge only against the approved checks ' + JSON.stringify(run.plan.project.checks.map(c => c.id)) + ' and the evidence the runner recorded; never demand checks, manifests or provenance that are not in the approved configuration. If an acceptance criterion cannot be verified with them, report that as a finding naming the criterion by its number (counting from 0) and quoting it, so the plan can be narrowed instead of repaired.' +
      '\nStandard of proof: read the diff, the documents and the tests, and weigh the recorded approved checks. A criterion is met when the code and documents show it and nothing contradicts it; the runner does not record per-test counts, provenance or a proof that nothing else happened, and you must not require them. Return passed when every criterion is met that way, failed only with a concrete defect naming the file and what is wrong, and blocked only for a decision nobody but the owner can make; never block because evidence is not independent.' +
      '\nAvailable approved diagnostic commands: ' + JSON.stringify(run.plan.project.checks.filter(c => run.plan.verification?.diagnostics.includes(c.id)).map(c => ({command: c.command, args: c.args}))) + '\nAvailable browser tools: ' + JSON.stringify(run.plan.verification?.browserTools || []);
    // In the exact session the model already holds the unchanged large sections; only the short ones that frame each request are repeated.
    const assembled = assembleContext({...run, root: cwd}, stage, task, extra, skill, previous && sessions[stage] && previous.session === sessions[stage] ? previous.manifest : undefined);
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
        const delegated = await this.delegate(run, cwd, stage, task, run.pendingDecision, result);
        if (delegated?.narrowed) return this.agent(run, stage, cwd, taskState, task, entryExtra + delegated.narrowed, skill, false);
        if (delegated) {
          run.pendingDecision = {...run.pendingDecision, answer: delegated.answer, source: 'delegate'};
          this.store.save(run, 'decision.answered', {request: run.pendingDecision.id, delegate: true});
          return this.agent(run, stage, cwd, taskState, task, entryExtra, skill, false);
        }
        this.store.save(run, 'decision.requested', {request: run.pendingDecision.id, stage, task: task?.id});
        if (run.parentIssue && !run.plan.workflow) {
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
    const cwd = state.worktree, sliced = run.plan.workflow?.mode === 'slices';
    await git.carryIgnoredControls(run.root, cwd);
    await this.guard(run, cwd); await this.setup(run, git, cwd);
    while (!state.integrated) {
      this.checkpoint(run);
      // A delegate may amend the plan inside a stage; later steps (PR text, further stages) use the amended task.
      task = run.plan.tasks.find(t => t.id === task.id) || task;
      try {
        switch (state.cursor) {
          case 'BUILD': case 'REPAIR': {
            if (state.pr) {
              const pr = await github.viewPr(state.pr.number);
              if (pr.state === 'MERGED') {state.cursor = 'INTEGRATE'; this.store.save(run, 'task.merge.recovered'); break;}
              await github.setIssue(state.issue!, true, 'Implementation is being repaired; previous readiness is invalid.');
            }
            const repair = pendingRepair(this.store, run, `task:${state.id}`);
            // A failed slice check or review becomes a bug Issue before the corrective BUILD, like a whole-feature repair.
            const bug = repair && sliced ? await publishRepairIssue(this.store, run, github, repair) : undefined;
            if (bug && state.issue) await github.commentOnce(state.issue, `repair:${repair!.id}`, `Repair required: #${bug}\n\n${cleanExcerpt(repair!.reason, this.store.home)}`);
            state.head = await this.build(run, git, cwd, state, task, repair?.id || `initial-${state.id}`,
              repair ? `Repair ${repair.id}: ${JSON.stringify(repair)}. Preserve all approved inputs.` : `Implement the approved ${sliced ? 'slice only; later slices follow in their own PRs' : 'task'}. Keep Git commits under runner control.`);
            if (bug) await github.commentOnce(bug, `implemented:${repair!.id}`, `Corrective BUILD completed at ${state.head}. Independent checks, VERIFY, REVIEW and the slice merge are pending.`);
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
            await this.agent(run, 'SHIP', cwd, state, task, 'Inspect delivery readiness. The runner publishes and closes the Issue. SHIP cannot edit code: if you find a real defect that needs a code or test change, return outcome failed with the defect in findings so the runner repairs it; return blocked only for a decision that nobody but the owner can make.');
            await git.clean(cwd); if (await git.head(cwd) !== head) throw new Blocked('SHIP changed the reviewed commit');
            await git.push(state.branch!, cwd);
            const checked = `Checks at ${head}:\n${state.evidence.map(e => '- ' + e.checkId + ': passed').join('\n')}\n\nReview: passed at ${state.reviewHead}`;
            // A slice PR names its Issue and bug Issues with Fixes; GitHub closes only on the default branch, so the runner closes them after its merge.
            state.pr = sliced
              ? await github.pr(`${run.id}:pr:${task.id}`, task.title, `${task.description}\n\n## Acceptance criteria\n\n${task.acceptance.map(a => '- ' + a).join('\n')}\n\n## Verification\n\n${checked}\n\n` +
                `## Issues\n\n${[state.issue!, ...sliceRepairIssues(this.store, run, task.id)].map(n => 'Fixes #' + n).join('\n')}\nParent: #${run.parentIssue}\n\nThe runner merges this PR into \`${run.branch}\` at the reviewed head; the PR to ${run.plan.project.mainBranch} is merged by the owner.`,
                state.branch!, run.branch, {labels: issueLabels(run, false), assignSelf: true})
              : await github.pr(`${run.id}:pr:${task.id}`, task.title, `${task.description}\n\nImplements #${state.issue}.\n\n${checked}`, state.branch!, run.branch);
            if (state.pr.headRefOid !== head) throw new Blocked('PR head differs from the checked commit');
            if (sliced) await github.commentOnce(state.issue!, `verified:${head}`, `Verified and reviewed at ${head}. PR: ${state.pr.url}. This Issue closes after the runner merges it into ${run.branch}.`);
            else await github.setIssue(state.issue!, false, `Implemented and verified at ${head}. PR: ${state.pr.url}. Dependencies remain pending until integration merge.`);
            state.cursor = 'INTEGRATE'; this.store.save(run, 'task.pr.ready', {task: task.id, pr: state.pr}); break;
          }
          case 'INTEGRATE': {
            if (run.plan.workflow?.mode === 'slices' ? !run.plan.workflow.permissions.mergeSlices : !run.plan.permissions.mergeIntermediate) throw new Blocked('Intermediate merge requires permission in the approved plan');
            const merge = (pr: PullRequest, head: string, base: string) => sliced ? this.mergeSlice(run, github, pr, head, base) : this.merge(run, github, pr, head, base);
            let pr = await github.viewPr(state.pr!.number);
            if (pr.baseRefName !== run.branch || pr.headRefName !== state.branch) throw new Blocked('PR target or source changed');
            if (pr.state !== 'MERGED') {
              if (pr.state === 'CLOSED') {await github.setIssue(state.issue!, true, 'PR rejected; task requires a new decision.'); throw new Blocked('Intermediate PR was closed without merge');}
              const head = await git.head(cwd);
              if (pr.headRefOid !== head || state.reviewHead !== head || !this.sufficient(run, state.evidence, head))
                throw new Blocked('PR changed after validation');
              const pending = this.store.operation<{state: string; base: string}>(`${run.id}:merge:${pr.number}:${head}`);
              // Observe an authorized in-flight request before changing either branch; a refused slice merge starts again from a fresh sync.
              if (pending && !(sliced && pending.state === 'failed')) {
                if (pending.state === 'merged') throw new ClientError('waiting_merge', 'Merge request completed; waiting for the actual PR outcome');
                await merge(pr, head, pending.base);
                break;
              }
              await this.syncTask(run, state, task, git, github);
              if (state.cursor !== 'INTEGRATE') break;
              await merge(pr, head, await git.run(['rev-parse', `origin/${run.branch}`]));
              pr = await github.viewPr(pr.number);
            }
            if (pr.state !== 'MERGED' || !pr.mergedAt) throw new Blocked('Intermediate merge is not confirmed');
            if (pr.headRefOid !== state.reviewHead || !this.sufficient(run, state.evidence, pr.headRefOid)) throw new Blocked('Merged PR head differs from the reviewed and verified revision; dependency remains pending');
            await git.fetch(); await git.clean(run.worktree!);
            await git.run(['merge', '--ff-only', `origin/${run.branch}`], run.worktree!);
            // Closing is idempotent and precedes the integrated mark, so an interruption never leaves a merged slice's Issues open.
            if (sliced && run.plan.workflow!.permissions.closeIssueOnMerge) {
              for (const bug of sliceRepairIssues(this.store, run, task.id)) await github.setIssue(bug, false, `Repaired slice merged into ${run.branch}: ${pr.url}`);
              await github.setIssue(state.issue!, false, `Slice merged into ${run.branch} at ${pr.headRefOid}: ${pr.url}. The feature reaches ${run.plan.project.mainBranch} through the final PR.`);
            }
            state.pr = pr; state.integrated = true;
            run.failures = {fingerprint: '', head: '', count: 0};
            this.store.save(run, 'task.integrated', {task: task.id, pr: pr.number}); break;
          }
        }
      } catch (error) {
        if (!(error instanceof CheckFailure || error instanceof CodeFailure)) throw error;
        // A defect SHIP names is repaired like one VERIFY or REVIEW names; only a failed check at these cursors is a stop.
        if (['INTEGRATE', 'REPAIR'].includes(state.cursor) || (state.cursor === 'SHIP' && !(error instanceof CodeFailure))) {
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
  /**
   * The runner merges a slice PR into the feature branch itself: the approved plan grants it, and the evidence is the runner's
   * own checks and REVIEW at the PR head, so no GitHub merge policy is involved. The intent binds head, base and plan like an
   * authorized merge; a lost response is retried against the same head, a refusal stops for the owner.
   */
  private async mergeSlice(run: Run, github: GitHub, pr: PullRequest, head: string, base: string) {
    const key = `${run.id}:merge:${pr.number}:${head}`;
    const prior = this.store.operation<{state: string; base: string; head: string; planHash: string}>(key);
    if (prior && prior.state !== 'failed' && (prior.base !== base || prior.head !== head || prior.planHash !== run.planHash)) throw new Blocked('Merge authorization binding changed; a new decision is required');
    const intent = {state: 'executing', base, head, planHash: run.planHash, slice: true};
    this.store.recordOperation(key, run.id, 'merge.slice.intent', intent);
    try {await github.mergeSlice(pr.number, head, base);}
    catch (error) {
      if (error instanceof MergeTerminalError) {
        this.store.recordOperation(key, run.id, 'merge.slice.failed', {...intent, state: 'failed', reason: redact(message(error))});
        throw new Blocked(message(error) + '; resolve it on GitHub, then resume');
      }
      if (!(error instanceof ClientError && ['quota', 'network'].includes(error.kind)))
        this.store.recordOperation(key, run.id, 'merge.slice.uncertain', {...intent, state: 'uncertain', reason: redact(message(error))});
      throw error;
    }
    this.store.recordOperation(key, run.id, 'merge.slice.merged', {...intent, state: 'merged'});
    this.store.event(run.id, 'merge.observed', {pr: pr.number, state: 'merged', slice: true});
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
        const issue = await publishRepairIssue(this.store, run, github, repair);
        if (issue && run.parentIssue) await github.commentOnce(run.parentIssue, `repair:${repair.id}`, `Repair required: #${issue}\n\n${cleanExcerpt(repair.reason, this.store.home)}`);
        await this.build(run, git, cwd, undefined, undefined, repair.id, `Repair whole-feature failure ${JSON.stringify(repair)}. Preserve all integrated tasks.`);
        if (issue) await github.commentOnce(issue, `implemented:${repair.id}`, `Corrective BUILD completed at ${await git.head(cwd)}. Independent checks, VERIFY and REVIEW are pending.`);
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
        for (const issue of repairIssues(this.store, run)) await github.commentOnce(issue, `verified:${head}`,
          `Independent VERIFY and REVIEW passed at ${head}. Delivery PR and merge are pending.`);
        run.finalReviewHead = head; run.finalPhase = 'SHIP'; this.store.save(run, 'feature.reviewed');
      } else {
        await git.fetch();
        if (run.syncedBase !== await git.run(['rev-parse', `origin/${run.plan.project.mainBranch}`])) {
          run.finalPhase = 'SYNC'; this.store.save(run, 'feature.base.changed'); continue;
        }
        const head = await git.head(cwd);
        if (head !== run.finalReviewHead || !this.sufficient(run, run.finalEvidence, head)) {run.finalPhase = 'VERIFY'; continue;}
        await this.agent(run, 'SHIP', cwd, undefined, undefined, 'Verify final PR readiness. Do not merge the main branch. SHIP cannot edit code: if you find a real defect that needs a code or test change, return outcome failed with the defect in findings so the runner repairs it; return blocked only for a decision that nobody but the owner can make.');
        await git.clean(cwd); if (await git.head(cwd) !== head) throw new Blocked('Final SHIP changed the commit');
        if (run.plan.workflow && (!run.plan.workflow.permissions.pushBranch || !run.plan.workflow.permissions.createPullRequest))
          throw new Blocked('The approved task does not authorize branch push and PR creation');
        await git.push(run.branch, cwd);
        const change = (await execute({command: 'git', args: ['diff', '--shortstat', `origin/${run.plan.project.mainBranch}`, 'HEAD']}, {cwd, role: 'git'})).stdout.trim();
        run.finalPr = await github.pr(`${run.id}:final`, pullRequestTitle(run), pullRequestBody(this.store, run, head, change), run.branch, run.plan.project.mainBranch,
          run.plan.workflow?.issueHistory ? {labels: issueLabels(run, false), assignSelf: true} : undefined);
        if (run.finalPr.headRefOid !== head || run.finalPr.baseRefName !== run.plan.project.mainBranch || run.finalPr.headRefName !== run.branch || run.finalPr.state !== 'OPEN')
          throw new Blocked('Final PR identity or head changed');
        if (run.plan.workflow?.issueHistory) for (const issue of [run.parentIssue, ...repairIssues(this.store, run)]) {
          if (issue) await github.commentOnce(issue, `delivery:${head}`, `Verified at ${head}. Delivery PR: ${run.finalPr.url}\nCloses when this PR merges into ${run.plan.project.mainBranch}.`);
        }
        run.status = 'ready'; this.store.save(run, 'feature.ready', {pr: run.finalPr});
        this.store.enqueue(`${run.id}:ready:${head}`, {runId: run.id, project: run.plan.project.name, feature: run.plan.title,
          state: 'ready', reason: 'Ready for final verification and a separate merge decision', url: run.finalPr.url});
      }
      } catch (error) {
        // SHIP is read-only and cannot repair what it finds: a code defect it reports goes to the same repair as one from VERIFY or REVIEW.
        if (!(error instanceof CheckFailure || error instanceof CodeFailure) || !(['VERIFY', 'REVIEW'].includes(run.finalPhase) || (run.finalPhase === 'SHIP' && error instanceof CodeFailure))) throw error;
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
      // Holding the run lock proves no execution is in progress; an idle worker (paused or waiting for a decision) exits
      // by itself once it sees the abandoned status, so only a live client blocks abandonment.
      if (ownerAlive(run.childPid, run.childIdentity)) throw new Error('Stop the active executor before abandonment');
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
        if (run.parentIssue && (!run.plan.workflow || run.plan.workflow.permissions.closeIssueOnMerge)) await github.setIssue(run.parentIssue, false, `Feature merged: ${pr.url}`);
        await closeRepairIssues(this.store, run, github, pr.url);
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
      if (run.parentIssue && (!run.plan.workflow || run.plan.workflow.permissions.closeIssueOnMerge)) await github.setIssue(run.parentIssue, false, `Feature merged: ${confirmed.url}`);
      await closeRepairIssues(this.store, run, github, confirmed.url);
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
