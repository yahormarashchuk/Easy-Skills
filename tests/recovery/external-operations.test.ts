import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/runner/engine.js';
import { fixture } from '../helpers.js';

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
    assert.equal(resumed.status, 'ready', resumed.reason); assert.equal(f.github.prs.size, 3);
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
    const [one, two] = await Promise.all([f.engine.run(f.run.id), new Engine(f.store, {client: f.client, github: f.github}).run(second.id)]);
    assert.equal(one.status, 'ready', one.reason); assert.equal(two.status, 'ready', two.reason);
    assert.notEqual(one.worktree, two.worktree);
    for (const task of one.tasks) assert.ok(!two.tasks.some(t => t.worktree === task.worktree));
    assert.equal(f.github.merges.length, 4);
  } finally {await f.dispose();}
});
