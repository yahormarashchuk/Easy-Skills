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

test('base movement during an in-flight merge preserves historical evidence until actual outcome', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash); const ready = await f.engine.run(f.run.id);
    const original = f.github.merge.bind(f.github);
    f.github.merge = async () => ({state: 'enqueued', operationId: 'fixture-request'});
    await assert.rejects(f.engine.confirmFinalMerge(ready.id, ready.finalReviewHead!), /waiting for actual/);
    writeFileSync(join(f.root, 'neighbor.txt'), 'Advance target while merge is queued');
    await f.git.commit(f.root, 'Move target'); await f.git.push('trunk', f.root);
    const waiting = await f.engine.reconcileFinalMerge(ready.id);
    assert.equal(waiting.status, 'needs_decision'); assert.equal(waiting.finalReviewHead, ready.finalReviewHead);
    assert.deepEqual(waiting.finalEvidence, ready.finalEvidence);
    await assert.rejects(f.engine.syncManual(ready.id), /outstanding merge/);
    f.github.merge = original; await f.github.merge(ready.finalPr!.number, ready.finalReviewHead!);
    assert.equal((await f.engine.reconcileFinalMerge(ready.id)).status, 'merged');
  } finally {await f.dispose();}
});

test('network scheduler uses one persisted deadline across idle loops and worker restart', async () => {
  const f = await fixture(); let calls = 0, clock = 1000;
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash); run.status = 'ready'; f.store.save(run, 'fixture.ready');
    f.engine.reconcileFinalMerge = async id => {calls++; return f.store.get(id);};
    for (let pass = 0; pass < 2; pass++) {
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 2100);
      try {await worker(f.store, run.id, {engine: f.engine, signal: abort.signal, now: () => clock, notify: async () => {}});}
      finally {clearTimeout(timer);}
      assert.equal(calls, 1);
      clock += 1000;
    }
    const operation = f.store.operation<{nextPollAt: number}>(`${run.id}:worker-poll`)!;
    assert.equal(operation.nextPollAt, 16000);
  } finally {await f.dispose();}
});
