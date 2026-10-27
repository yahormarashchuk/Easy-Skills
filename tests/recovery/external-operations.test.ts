import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/runner/engine.js';
import { fixture } from '../helpers.js';
import { ClientError } from '../../src/adapters/index.js';

test('lost merge responses reconcile actual merged PRs without merging twice', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const original = f.github.merge.bind(f.github); let once = true;
    f.github.merge = async (...args) => {const result = await original(...args); if (once) {once = false; throw new ClientError('network', 'ECONNRESET after merge');} return result;};
    assert.equal((await f.engine.run(f.run.id)).status, 'waiting_external');
    const ready = await f.engine.run(f.run.id);
    assert.equal(ready.status, 'ready', ready.reason || ''); assert.equal(f.github.merges.length, 2);
    once = true;
    await assert.rejects(f.engine.confirmFinalMerge(f.run.id, ready.finalReviewHead!), /ECONNRESET/);
    assert.equal((await f.engine.reconcileFinalMerge(f.run.id)).status, 'merged');
    assert.equal(f.github.merges.length, 3);
  } finally {await f.dispose();}
});

test('queued intermediate PR leaves its dependency pending and persists merge intent', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    f.github.merge = async () => ({state: 'enqueued'});
    const run = await f.engine.run(f.run.id);
    assert.equal(run.status, 'waiting_external');
    assert.equal(run.tasks[0]!.integrated, false); assert.equal(run.tasks[1]!.worktree, undefined);
    const intent = f.store.operation<any>(`${run.id}:merge:${run.tasks[0]!.pr!.number}:${run.tasks[0]!.head}`);
    assert.equal(intent.state, 'enqueued');
  } finally {await f.dispose();}
});

test('a manually merged PR with an unreviewed head does not satisfy its dependency', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const original = f.github.merge.bind(f.github);
    f.github.merge = async (...args) => {const result = await original(...args); f.github.prs.get(args[0])!.headRefOid = 'b'.repeat(40); return result;};
    const run = await f.engine.run(f.run.id);
    assert.equal(run.status, 'needs_decision'); assert.equal(run.tasks[0]!.integrated, false); assert.equal(run.tasks[1]!.worktree, undefined);
  } finally {await f.dispose();}
});

test('recovery reconciles a PR created before its response was persisted', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const original = f.github.pr.bind(f.github); let once = true;
    f.github.pr = async (...args) => {
      const pr = await original(...args);
      if (once) {once = false; throw new Error('Connection interrupted after create');}
      return pr;
    };
    const interrupted = await f.engine.run(f.run.id);
    assert.equal(interrupted.status, 'needs_decision'); assert.equal(f.github.prs.size, 1);
    const resumed = await f.engine.run(f.run.id);
    assert.equal(resumed.status, 'ready', resumed.reason || ''); assert.equal(f.github.prs.size, 3);
    assert.equal(f.github.issues.size, 3); assert.equal(f.github.merges.length, 2);
  } finally {await f.dispose();}
});
test('two feature workers use independent worktrees and only satisfy their own dependencies', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const otherPlan = {...f.run.plan, featureId: 'parallel', title: 'Parallel feature'};
    const second = f.store.create(f.run.root, f.run.commonDir, otherPlan);
    f.engine.approve(second.id, second.planHash);
    const [one, two] = await Promise.all([f.engine.run(f.run.id), new Engine(f.store, {testRemote: f.remote, client: f.client, github: f.github}).run(second.id)]);
    assert.equal(one.status, 'ready', one.reason || ''); assert.equal(two.status, 'ready', two.reason || '');
    assert.notEqual(one.worktree, two.worktree);
    for (const task of one.tasks) assert.ok(!two.tasks.some(t => t.worktree === task.worktree));
    assert.equal(f.github.merges.length, 4);
  } finally {await f.dispose();}
});
