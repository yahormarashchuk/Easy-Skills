import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { Engine } from '../../src/runner/engine.js';
import { pollRemote } from '../../src/runner/remote.js';
import { flushNotifications } from '../../src/notifications/index.js';

test('three identical failed code repairs stop without starting dependent work', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    let attempts = 0;
    const engine = new Engine(f.store, {github: f.github, client: {async run(a, p, o) {
      if (a.model === 'exact-BUILD') {attempts++; writeFileSync(join(o.cwd, 'broken'), 'failed fixture');}
      return f.client.run(a, p, o);
    }}});
    const result = await engine.run(f.run.id);
    assert.equal(result.status, 'needs_decision'); assert.equal(result.failures.count, 3); assert.equal(attempts, 3);
    assert.match(result.reason!, /Three identical/); assert.equal(result.tasks[1]!.worktree, undefined);
    const pending = await flushNotifications(f.store); assert.equal(pending.configured, false); assert.equal(pending.pending, 1);
  } finally {await f.dispose();}
});
test('rule changes revoke readiness before implementation', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    writeFileSync(join(f.root, 'AGENTS.md'), 'Changed rule');
    const result = await f.engine.run(f.run.id);
    assert.equal(result.status, 'needs_decision'); assert.match(result.reason!, /rules changed/); assert.equal(f.calls.length, 0);
  } finally {await f.dispose();}
});
test('remote controls reject wrong authors, stale plans and replayed comments', async () => {
  const f = await fixture();
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash); run.parentIssue = 99; f.store.save(run, 'test.parent');
    writeFileSync(join(f.store.home, 'settings.json'), JSON.stringify({remote: {allowedAuthors: ['human']}}));
    f.github.issueComments = [
      {id: 1, author: 'other', body: `/easy-skills pause ${run.id} ${run.planHash}`},
      {id: 2, author: 'human', body: `/easy-skills pause ${run.id} ${'a'.repeat(64)}`},
      {id: 3, author: 'human', body: `/easy-skills pause ${run.id} ${run.planHash}`},
    ];
    await pollRemote(f.store, run, f.engine, f.github);
    assert.deepEqual(f.store.operation(`${run.id}:control`), {action: 'pause'});
    f.store.recordOperation(`${run.id}:control`, run.id, 'control', {});
    await pollRemote(f.store, run, f.engine, f.github);
    assert.deepEqual(f.store.operation(`${run.id}:control`), {});
    assert.equal(f.store.events(run.id).filter(e => e.type === 'remote.rejected').length, 2);
  } finally {await f.dispose();}
});
