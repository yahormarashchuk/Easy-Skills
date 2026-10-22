import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/runner/engine.js';
import { fixture } from '../helpers.js';

for (const change of ['auth', 'version', 'path']) test(`compatibility stops before BUILD when ${change} changes`, async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const engine = new Engine(f.store, {github: f.github, client: {...f.client, async diagnose() {
      return {installed: true, authenticated: change !== 'auth', version: change === 'version' ? 'fixture-2' : 'fixture-1', executable: change === 'path' ? '/other/client' : '/fixture/client'};
    }}});
    const run = await engine.run(f.run.id);
    assert.equal(run.status, 'needs_decision');
    assert.equal(f.calls.length, 0);
    assert.match(run.reason!, change === 'auth' ? /auth/i : /compatibility|configuration/i);
  } finally {await f.dispose();}
});

test('final sync without conflicts does not require an already completed BUILD assignment', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const ready = await f.engine.run(f.run.id);
    ready.status = 'approved'; ready.finalPhase = 'SYNC'; ready.finalReviewHead = undefined; ready.finalEvidence = [];
    f.store.save(ready, 'fixture.reverify');
    f.store.db.prepare('DELETE FROM probes WHERE key=?').run(f.store.probeKey(ready.plan.assignments.BUILD));
    const refreshed = await f.engine.run(f.run.id);
    assert.equal(refreshed.status, 'ready', refreshed.reason || '');
    assert.equal(f.calls.filter(c => c.startsWith('exact-BUILD')).length, 2);
  } finally {await f.dispose();}
});
