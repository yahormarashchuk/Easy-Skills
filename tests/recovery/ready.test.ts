import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { worker } from '../../src/runner/worker.js';

test('ready monitoring restarts without BUILD and revokes readiness when main advances', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const ready = await f.engine.run(f.run.id), count = f.calls.length;
    const abort = new AbortController(), reconcile = f.engine.reconcileFinalMerge.bind(f.engine);
    f.engine.reconcileFinalMerge = async id => {const result = await reconcile(id); abort.abort(); return result;};
    await worker(f.store, f.run.id, {engine: f.engine, github: f.github, signal: abort.signal, notify: async () => {}});
    f.engine.reconcileFinalMerge = reconcile;
    const restarted = await f.engine.run(f.run.id);
    assert.equal(restarted.status, 'ready'); assert.equal(f.calls.length, count);
    writeFileSync(join(f.root, 'neighbor.txt'), 'new main behavior');
    await f.git.run(['add', '.']); await f.git.run(['commit', '-m', 'Advance main']); await f.git.push('trunk', f.root);
    const revoked = await f.engine.reconcileFinalMerge(f.run.id);
    assert.equal(revoked.status, 'approved'); assert.equal(revoked.finalReviewHead, undefined);
    await assert.rejects(f.engine.confirmFinalMerge(f.run.id, ready.finalReviewHead!), /not ready/);
    const refreshed = await f.engine.run(f.run.id);
    assert.equal(refreshed.status, 'ready', refreshed.reason || '');
    assert.notEqual(refreshed.finalReviewHead, ready.finalReviewHead);
    assert.equal(f.calls.filter(c => c.startsWith('exact-BUILD')).length, 2);
    await assert.rejects(f.engine.confirmFinalMerge(f.run.id, ready.finalReviewHead!), /Revision/);
  } finally {await f.dispose();}
});
