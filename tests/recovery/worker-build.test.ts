import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../helpers.js';
import { worker } from '../../src/runner/worker.js';

test('an idle worker records its build and exits once another build is installed', async () => {
  const f = await fixture();
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 30_000);
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    f.engine.requestControl(f.run.id, 'pause');
    let installed = 'build-a';
    const done = worker(f.store, f.run.id, {engine: f.engine, github: f.github, signal: abort.signal, notify: async () => {}, build: () => installed});
    while (f.store.get(f.run.id).status !== 'paused' && !abort.signal.aborted) await delay(50);
    assert.equal(f.store.get(f.run.id).status, 'paused');
    assert.equal(f.store.operation<{build: string}>(`${f.run.id}:worker-build`)?.build, 'build-a');
    installed = 'build-b';
    await done;
    assert.equal(abort.signal.aborted, false, 'the worker must exit by itself, not by the test timeout');
    assert.ok(f.store.events(f.run.id).some(event => event.type === 'worker.replaced'));
    assert.equal(f.store.get(f.run.id).status, 'paused');
  } finally {clearTimeout(timer); abort.abort(); await f.dispose();}
});
