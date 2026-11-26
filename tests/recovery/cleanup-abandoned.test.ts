import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { Engine } from '../../src/runner/engine.js';
import { cleanup, cleanupPlan } from '../../src/runner/cleanup.js';

/** A run that stops at its first BUILD keeps an integration worktree and one task worktree. */
async function stoppedRun() {
  const f = await fixture();
  f.engine.approve(f.run.id, f.run.planHash);
  const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
    if (a.model === 'exact-BUILD') {
      // A real build leaves ignored outputs behind.
      mkdirSync(join(o.cwd, 'node_modules/cache'), {recursive: true}); writeFileSync(join(o.cwd, 'node_modules/cache/output.bin'), 'build output');
      return {outcome: 'blocked', summary: 'Owner decision needed', question: 'Which storage should I use?', findings: []};
    }
    return f.client.run(a, p, o);
  }}});
  const stopped = await engine.run(f.run.id);
  return {...f, engine, stopped};
}

test('cleanup refuses a run that is neither merged nor abandoned', async () => {
  const f = await stoppedRun();
  try {
    assert.notEqual(f.stopped.status, 'abandoned');
    await assert.rejects(cleanupPlan(f.store, f.run.id, f.github), /abandon it first/);
  } finally {await f.dispose();}
});

test('an abandoned run is cleaned up after review: ignored build outputs only with --ignored-outputs, branches kept', async () => {
  const f = await stoppedRun();
  try {
    await f.engine.abandon(f.run.id);
    const run = f.store.get(f.run.id), worktrees = [run.worktree, ...run.tasks.map(t => t.worktree)].filter((p): p is string => !!p && existsSync(p));
    assert.ok(worktrees.length >= 1, 'the stopped run kept worktrees');
    // Ignored files are private by default; the owner must ask to review them.
    await assert.rejects(cleanupPlan(f.store, run.id, f.github), /ignored/);
    const plan = await cleanupPlan(f.store, run.id, f.github, {ignoredOutputs: true});
    assert.equal(plan.reason, 'abandoned'); assert.equal(plan.mergedPr, undefined);
    const withOutputs = plan.resources.find(r => r.ignored);
    assert.ok(withOutputs && withOutputs.ignored!.files === 1 && withOutputs.ignored!.top.includes('node_modules'));

    // A change made after the review invalidates the approval.
    writeFileSync(join(withOutputs!.path, 'node_modules/cache/late.bin'), 'written after review');
    await assert.rejects(cleanup(f.store, run.id, plan.hash, f.github, {ignoredOutputs: true}), /does not match/);
    const reviewed = await cleanupPlan(f.store, run.id, f.github, {ignoredOutputs: true});

    const removed = await cleanup(f.store, run.id, reviewed.hash, f.github, {ignoredOutputs: true});
    assert.equal(removed.length, worktrees.length);
    for (const path of worktrees) assert.equal(existsSync(path), false, path + ' removed');
    for (const branch of reviewed.branchesKept) assert.ok(await f.git.run(['rev-parse', '--verify', `refs/heads/${branch}`]), branch + ' kept');
    const after = f.store.get(run.id);
    assert.equal(after.status, 'abandoned');
    assert.ok((f.store.events(run.id) as {type: string}[]).some(e => e.type === 'cleanup.ignored.removed'));
  } finally {await f.dispose();}
});

test('untracked work in an abandoned run blocks cleanup', async () => {
  const f = await stoppedRun();
  try {
    await f.engine.abandon(f.run.id);
    const run = f.store.get(f.run.id), path = [run.worktree, ...run.tasks.map(t => t.worktree)].find(p => !!p && existsSync(p))!;
    writeFileSync(join(path, 'notes.md'), 'unsaved owner notes');
    await assert.rejects(cleanupPlan(f.store, run.id, f.github, {ignoredOutputs: true}), /untracked/);
    assert.ok(existsSync(join(path, 'notes.md')));
  } finally {await f.dispose();}
});
