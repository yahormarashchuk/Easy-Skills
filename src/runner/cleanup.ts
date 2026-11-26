import { closeRepairIssues } from './issue-history.js';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../persistence/store.js';
import { Git } from '../git/index.js';
import { Gh, type GitHub } from '../github/index.js';
import { alive, hash } from '../util.js';
import { ignoredOutputs, removeSetupOutput, type SetupOutput } from './setup-outputs.js';

export interface CleanupOptions {
  /** Include unchanged ignored files that the approved setup created (exact per-file hashes). */
  setupOutputs?: boolean;
  /** Include every ignored file (build outputs such as bin/obj/node_modules), bound to a reviewed inventory. */
  ignoredOutputs?: boolean;
}
type Resource = {path: string; branch: string; head: string; setupOutputs?: SetupOutput[]; ignored?: IgnoredSummary};
interface IgnoredSummary {files: number; bytes: number; top: string[]; inventory: string}

/** A reviewable summary of a worktree's ignored files; the inventory hash binds paths, sizes and modification times. */
async function ignoredSummary(git: Git, cwd: string): Promise<IgnoredSummary> {
  const paths = (await git.run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], cwd)).split('\0').filter(Boolean).sort();
  let bytes = 0;
  const entries = paths.map(path => {
    const stat = lstatSync(join(cwd, path));
    if (stat.isSymbolicLink()) throw new Error('Ignored output is a symbolic link: ' + path);
    bytes += stat.size; return [path, stat.size, stat.mtimeMs];
  });
  const top = [...new Set(paths.map(path => path.split('/')[0]!))].sort().slice(0, 20);
  return {files: paths.length, bytes, top, inventory: hash(entries)};
}

/**
 * The cleanup proposal for a run whose final PR is confirmed merged, or for an abandoned run. Branches are always kept,
 * so an abandoned run's commits stay in the repository; uncommitted or untracked changes always block removal.
 */
export async function cleanupPlan(store: Store, id: string, github?: GitHub, options: CleanupOptions | boolean = {}) {
  const opts: CleanupOptions = typeof options === 'boolean' ? {setupOutputs: options} : options;
  const run = store.get(id), abandoned = run.status === 'abandoned';
  if (store.locked('run:' + id) || alive(run.childPid)) throw new Error('Feature has an active executor');
  let merged: {number: number; headRefOid: string} | undefined;
  if (!abandoned) {
    if (!run.finalPr) throw new Error('Feature has no final PR; abandon it first to clean up its worktrees');
    const gh = github || new Gh(run.plan.project.repository, run.root), pr = await gh.viewPr(run.finalPr.number);
    if (pr.state !== 'MERGED' || !pr.mergedAt || pr.baseRefName !== run.plan.project.mainBranch || pr.headRefName !== run.branch || pr.headRefOid !== run.finalReviewHead)
      throw new Error('The verified feature revision is not confirmed merged into the main branch');
    merged = {number: pr.number, headRefOid: pr.headRefOid};
  }
  const git = new Git(run.root, operation => store.withLock('repository:' + run.commonDir, operation)), allowed = join(store.home, 'worktrees', run.id);
  const candidates = [{path: run.worktree, branch: run.branch, head: run.finalReviewHead, id: 'integration'},
    ...run.tasks.map(t => ({path: t.worktree, branch: t.branch, head: t.head, id: t.id}))];
  const resources: Resource[] = [];
  for (const candidate of candidates) {
    if (!candidate.path || !candidate.branch || !existsSync(candidate.path) || (!abandoned && !candidate.head)) continue;
    const {path, branch} = candidate;
    await git.assertOwned(path, branch, allowed);
    await git.clean(path, false);
    const actualHead = await git.head(path);
    // A merged feature must hold exactly the verified results; an abandoned one keeps whatever is committed on its branch.
    if (!abandoned && actualHead !== candidate.head) throw new Error('Worktree has commits outside the verified feature results');
    const intended = store.operation<{path: string; branch: string}>(`${run.id}:worktree:${candidate.id}`);
    if (!intended || intended.branch !== branch) throw new Error('Worktree ownership record is missing');
    const resource: Resource = {path, branch, head: actualHead};
    if (opts.ignoredOutputs) {
      const summary = await ignoredSummary(git, path);
      if (summary.files) resource.ignored = summary;
    } else {
      const actual = opts.setupOutputs ? await ignoredOutputs(git, path) : [];
      if (!opts.setupOutputs) await git.clean(path, true);
      const setup = store.operation<{ownedOutputs?: SetupOutput[]}>(`${id}:setup:${hash(path)}`);
      if (actual.some(output => !setup?.ownedOutputs?.some(owned => owned.path === output.path && owned.hash === output.hash)))
        throw new Error('Ignored files were not created by the approved setup or have changed; preserve them, or review them with --ignored-outputs');
      resource.setupOutputs = actual;
    }
    resources.push(resource);
  }
  const plan = {runId: id, planHash: run.planHash, reason: abandoned ? 'abandoned' : 'merged', mergedPr: merged?.number, mergedHead: merged?.headRefOid,
    branchesKept: resources.map(r => r.branch), resources};
  return {...plan, hash: hash(plan)};
}
export async function cleanup(store: Store, id: string, expectedHash: string, github?: GitHub, options: CleanupOptions | boolean = {}) {
  const opts: CleanupOptions = typeof options === 'boolean' ? {setupOutputs: options} : options;
  const key = 'run:' + id;
  // Plan before locking, then repeat all checks under the lock. Never use force removal.
  const plan = await cleanupPlan(store, id, github, opts);
  if (expectedHash !== plan.hash) throw new Error('Cleanup approval does not match the current resource plan');
  const owner = store.acquire(key);
  try {
    const run = store.get(id), git = new Git(run.root, operation => store.withLock('repository:' + run.commonDir, operation)), allowed = join(store.home, 'worktrees', run.id);
    if (alive(run.childPid)) throw new Error('Feature has an active child process');
    const abandoned = plan.reason === 'abandoned';
    if (abandoned !== (run.status === 'abandoned')) throw new Error('Run status changed after cleanup review');
    const gh = github || new Gh(run.plan.project.repository, run.root);
    let confirmed: Awaited<ReturnType<GitHub['viewPr']>> | undefined;
    if (!abandoned) {
      confirmed = await gh.viewPr(run.finalPr!.number);
      if (confirmed.state !== 'MERGED' || !confirmed.mergedAt || confirmed.headRefOid !== plan.mergedHead ||
        confirmed.baseRefName !== run.plan.project.mainBranch || confirmed.headRefName !== run.branch)
        throw new Error('Merge evidence changed after cleanup review');
    }
    for (const resource of plan.resources) {
      if (existsSync(resource.path)) {
        if (await git.head(resource.path) !== resource.head) throw new Error('Worktree revision changed after cleanup review');
        await git.assertOwned(resource.path, resource.branch, allowed);
        if (resource.ignored) {
          await git.clean(resource.path, false);
          if ((await ignoredSummary(git, resource.path)).inventory !== resource.ignored.inventory) throw new Error('Ignored files changed after cleanup review');
          await git.run(['clean', '-fdX'], resource.path);
          store.event(id, 'cleanup.ignored.removed', {worktree: resource.path, files: resource.ignored.files, bytes: resource.ignored.bytes});
        }
        for (const output of resource.setupOutputs || []) {
          removeSetupOutput(resource.path, output); store.event(id, 'cleanup.setup-output.removed', {worktree: resource.path, path: output.path});
        }
        await git.removeOwned(resource.path, resource.branch, allowed);
      }
      store.event(id, 'cleanup.worktree.removed', {path: resource.path, branch: resource.branch, head: resource.head});
    }
    if (abandoned) {store.event(id, 'cleanup.completed', {reason: 'abandoned', resources: plan.resources.length}); return plan.resources;}
    if (run.parentIssue && (!run.plan.workflow || run.plan.workflow.permissions.closeIssueOnMerge)) await gh.setIssue(run.parentIssue, false, `Feature merged: ${confirmed!.url}`);
    await closeRepairIssues(store, run, gh, confirmed!.url);
    run.finalPr = confirmed; run.status = 'merged'; run.reason = undefined; store.save(run, 'cleanup.completed');
    return plan.resources;
  } finally {store.release(key, owner);}
}
