import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../persistence/store.js';
import { Git } from '../git/index.js';
import { Gh, type GitHub } from '../github/index.js';
import { alive, hash } from '../util.js';
import { ignoredOutputs, removeSetupOutput, type SetupOutput } from './setup-outputs.js';

export async function cleanupPlan(store: Store, id: string, github?: GitHub, includeSetupOutputs = false) {
  const run = store.get(id);
  if (store.locked('run:' + id) || alive(run.childPid)) throw new Error('Feature has an active executor');
  if (!run.finalPr) throw new Error('Feature has no final PR');
  const gh = github || new Gh(run.plan.project.repository, run.root), pr = await gh.viewPr(run.finalPr.number);
  if (pr.state !== 'MERGED' || !pr.mergedAt || pr.baseRefName !== run.plan.project.mainBranch || pr.headRefName !== run.branch || pr.headRefOid !== run.finalReviewHead)
    throw new Error('The verified feature revision is not confirmed merged into the main branch');
  const git = new Git(run.root, operation => store.withLock('repository:' + run.commonDir, operation)), allowed = join(store.home, 'worktrees', run.id);
  const resources = [{path: run.worktree, branch: run.branch, head: run.finalReviewHead}, ...run.tasks.map(t => ({path: t.worktree, branch: t.branch, head: t.head}))]
    .filter((r): r is {path: string; branch: string; head: string} => !!r.path && !!r.branch && !!r.head);
  for (const resource of resources) {
    if (!existsSync(resource.path)) continue;
    await git.assertOwned(resource.path, resource.branch, allowed);
    await git.clean(resource.path, !includeSetupOutputs);
    const actual = includeSetupOutputs ? await ignoredOutputs(git, resource.path) : [];
    const setup = store.operation<{ownedOutputs?: SetupOutput[]}>(`${id}:setup:${hash(resource.path)}`);
    if (actual.some(output => !setup?.ownedOutputs?.some(owned => owned.path === output.path && owned.hash === output.hash)))
      throw new Error('Ignored files were not created by the approved setup or have changed; preserve them');
    Object.assign(resource, {setupOutputs: actual});
    if (await git.head(resource.path) !== resource.head) throw new Error('Worktree has commits outside the verified feature results');
    const intended = store.operation<{path: string; branch: string}>(`${run.id}:worktree:${resource.path === run.worktree ? 'integration' : run.tasks.find(t => t.worktree === resource.path)!.id}`);
    if (!intended || intended.branch !== resource.branch) throw new Error('Worktree ownership record is missing');
  }
  const plan = {runId: id, planHash: run.planHash, mergedPr: pr.number, mergedHead: pr.headRefOid, resources};
  return {...plan, hash: hash(plan)};
}
export async function cleanup(store: Store, id: string, expectedHash: string, github?: GitHub, includeSetupOutputs = false) {
  const key = 'run:' + id;
  // Plan before locking, then repeat all checks under the lock. Never use force removal.
  const plan = await cleanupPlan(store, id, github, includeSetupOutputs);
  if (expectedHash !== plan.hash) throw new Error('Cleanup approval does not match the current resource plan');
  const owner = store.acquire(key);
  try {
    const run = store.get(id), git = new Git(run.root, operation => store.withLock('repository:' + run.commonDir, operation)), allowed = join(store.home, 'worktrees', run.id);
    if (alive(run.childPid)) throw new Error('Feature has an active child process');
    const gh = github || new Gh(run.plan.project.repository, run.root);
    const confirmed = await gh.viewPr(run.finalPr!.number);
    if (confirmed.state !== 'MERGED' || !confirmed.mergedAt || confirmed.headRefOid !== plan.mergedHead ||
      confirmed.baseRefName !== run.plan.project.mainBranch || confirmed.headRefName !== run.branch)
      throw new Error('Merge evidence changed after cleanup review');
    for (const resource of plan.resources) {
      if (existsSync(resource.path)) {
        if (await git.head(resource.path) !== resource.head) throw new Error('Worktree revision changed after cleanup review');
        for (const output of (resource as typeof resource & {setupOutputs: SetupOutput[]}).setupOutputs || []) {
          removeSetupOutput(resource.path, output); store.event(id, 'cleanup.setup-output.removed', {worktree: resource.path, path: output.path});
        }
        await git.removeOwned(resource.path, resource.branch, allowed);
      }
      store.event(id, 'cleanup.worktree.removed', resource);
    }
    await gh.setIssue(run.parentIssue!, false, `Feature merged: ${confirmed.url}`);
    run.finalPr = confirmed; run.status = 'merged'; store.save(run, 'cleanup.completed');
    return plan.resources;
  } finally {store.release(key, owner);}
}
