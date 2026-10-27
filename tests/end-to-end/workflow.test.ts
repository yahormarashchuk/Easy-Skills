import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, rmSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../src/runner/engine.js';
import { ClientError } from '../../src/adapters/index.js';
import { cleanup, cleanupPlan } from '../../src/runner/cleanup.js';
import { fixture } from '../helpers.js';

for (const stack of ['node', 'python']) test(`approved feature completes sequential tasks, final PR and explicit cleanup (${stack})`, async () => {
  const f = await fixture(stack);
  try {
    assert.throws(() => f.engine.approve(f.run.id, 'wrong'), /exact/);
    f.engine.approve(f.run.id, f.run.planHash);
    const ready = await f.engine.run(f.run.id);
    assert.equal(ready.status, 'ready', ready.reason || '');
    assert.equal(ready.tasks.every(t => t.integrated), true);
    assert.equal(f.github.merges.length, 2); assert.equal(f.github.issues.get(ready.parentIssue!), true);
    const firstMerge = f.store.events(f.run.id).find(e => e.type === 'task.integrated')!;
    const secondBuild = f.store.events(f.run.id).find(e => e.type === 'task.built' && JSON.parse(String(e.data)).task === 'two')!;
    assert.ok(Number(firstMerge.sequence) < Number(secondBuild.sequence));
    assert.equal(existsSync(join(ready.worktree!, 'one.txt')), true);
    assert.equal(existsSync(join(ready.worktree!, 'two.txt')), true);
    await assert.rejects(cleanupPlan(f.store, f.run.id, f.github), /not confirmed/);
    await assert.rejects(f.engine.confirmFinalMerge(f.run.id, 'wrong'), /Revision/);
    const merged = await f.engine.confirmFinalMerge(f.run.id, ready.finalReviewHead!);
    assert.equal(merged.status, 'merged'); assert.equal(f.github.issues.get(merged.parentIssue!), false);
    const proposal = await cleanupPlan(f.store, f.run.id, f.github);
    writeFileSync(join(merged.worktree!, 'untracked.txt'), 'keep me');
    await assert.rejects(cleanup(f.store, f.run.id, proposal.hash, f.github), /untracked/);
    await f.git.run(['add', 'untracked.txt'], merged.worktree!);
    await assert.rejects(cleanup(f.store, f.run.id, proposal.hash, f.github), /untracked/);
    await f.git.run(['restore', '--staged', 'untracked.txt'], merged.worktree!);
    rmSync(join(merged.worktree!, 'untracked.txt'));
    mkdirSync(join(merged.worktree!, 'node_modules'));
    writeFileSync(join(merged.worktree!, 'node_modules/private-data.txt'), 'Ignored user data must survive');
    await assert.rejects(cleanup(f.store, f.run.id, proposal.hash, f.github), /ignored/);
    rmSync(join(merged.worktree!, 'node_modules/private-data.txt'));
    rmdirSync(join(merged.worktree!, 'node_modules'));
    await cleanup(f.store, f.run.id, proposal.hash, f.github);
    assert.equal(existsSync(merged.worktree!), false);
    assert.ok((await f.git.run(['branch', '--list', merged.branch])).includes(merged.branch));
  } finally {await f.dispose();}
});
test('quota wait preserves the exact session without consuming repair cycles', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    let once = false, resumed: string | undefined;
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (!once) {once = true; o.onSession?.('quota-session'); throw new ClientError('quota', 'usage limit reached');}
      if (a.model === 'exact-BUILD' && o.cwd.endsWith('one')) resumed = o.session;
      return f.client.run(a, p, o);
    }}});
    const waiting = await engine.run(f.run.id);
    assert.equal(waiting.status, 'waiting_quota'); assert.equal(waiting.failures.count, 0);
    assert.ok(waiting.retryAt); assert.equal(waiting.tasks[0]!.sessions.BUILD, 'quota-session');
    f.store.db.prepare('UPDATE probes SET checked_at=?').run(new Date(Date.now() - 48 * 60 * 60_000).toISOString());
    for (const stage of ['DEFINE', 'PLAN']) f.store.db.prepare('DELETE FROM probes WHERE key=?').run(f.store.probeKey(f.run.plan.assignments[stage as 'PLAN']));
    const ready = await engine.run(f.run.id);
    assert.equal(ready.status, 'ready', ready.reason || ''); assert.equal(resumed, 'quota-session');
  } finally {await f.dispose();}
});
test('a live orphan child blocks recovery without launching a replacement', async () => {
  const f = await fixture();
  try {
    const approved = f.engine.approve(f.run.id, f.run.planHash);
    approved.childPid = process.pid; f.store.save(approved, 'test.orphan');
    const recovered = await f.engine.run(f.run.id);
    assert.equal(recovered.status, 'needs_decision'); assert.match(recovered.reason!, /still alive/); assert.equal(f.calls.length, 0);
  } finally {await f.dispose();}
});
