import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../persistence/store.js';
import { Engine } from './engine.js';
import { pollRemote } from './remote.js';
import { flushNotifications } from '../notifications/index.js';
import { message, redact } from '../util.js';

export async function worker(store: Store, id: string) {
  const key = 'worker:' + id, owner = store.acquire(key);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const engine = new Engine(store, {signal: abort.signal});
  let polling = false;
  async function poll() {
    if (polling) return; polling = true;
    try {await engine.reconcileFinalMerge(id); await pollRemote(store, store.get(id), engine); await flushNotifications(store);}
    catch (error) {store.event(id, 'worker.poll.failed', {message: redact(message(error))});}
    finally {polling = false;}
  }
  const interval = setInterval(() => {void poll();}, 15_000);
  try {
    while (!abort.signal.aborted) {
      await poll();
      const run = store.get(id);
      if (['merged', 'stopped', 'draft'].includes(run.status)) break;
      const resume = store.operation<{resume: boolean}>(`${id}:resume-request`);
      const control = store.operation<{action: 'pause' | 'stop'}>(`${id}:control`);
      if (control?.action && run.status !== 'running') {
        run.status = control.action === 'pause' ? 'paused' : 'stopped';
        store.recordOperation(`${id}:control`, id, 'control', {});
        store.save(run, 'control.applied'); continue;
      }
      if (resume?.resume) store.recordOperation(`${id}:resume-request`, id, 'remote.resume', {resume: false});
      if (['approved', 'running'].includes(run.status) ||
        (run.status === 'waiting_quota' && !!run.retryAt && Date.parse(run.retryAt) <= Date.now()) ||
        (resume?.resume && ['paused', 'needs_decision', 'waiting_quota'].includes(run.status))) await engine.run(id);
      else await delay(1000, undefined, {signal: abort.signal}).catch(() => {});
    }
  } finally {
    clearInterval(interval);
    while (polling) await delay(20);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    store.release(key, owner);
  }
}
