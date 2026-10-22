import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../persistence/store.js';
import { Engine } from './engine.js';
import { pollRemote } from './remote.js';
import { flushNotifications } from '../notifications/index.js';
import { message, redact } from '../util.js';
import type { GitHub } from '../github/index.js';

export async function worker(store: Store, id: string, options: {engine?: Engine; github?: GitHub; signal?: AbortSignal; notify?: () => Promise<unknown>} = {}) {
  const key = 'worker:' + id, owner = store.acquire(key);
  const abort = new AbortController();
  const stop = () => abort.abort();
  options.signal?.addEventListener('abort', stop, {once: true});
  if (options.signal?.aborted) abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const engine = options.engine || new Engine(store, {signal: abort.signal});
  let polling = false;
  async function poll() {
    if (polling) return; polling = true;
    try {
      for (const operation of [() => engine.reconcileFinalMerge(id), () => pollRemote(store, store.get(id), engine, options.github), options.notify || (() => flushNotifications(store))])
        try {await operation();} catch (error) {store.event(id, 'worker.poll.failed', {message: redact(message(error))});}
    }
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
      if (['approved', 'running'].includes(run.status) ||
        (run.status === 'waiting_quota' && !!run.retryAt && Date.parse(run.retryAt) <= Date.now()) ||
        (resume?.resume && ['paused', 'needs_decision', 'waiting_quota'].includes(run.status))) {
        await engine.run(id);
        if (resume?.resume) store.recordOperation(`${id}:resume-request`, id, 'remote.resume', {resume: false});
      }
      else await delay(1000, undefined, {signal: abort.signal}).catch(() => {});
    }
  } finally {
    clearInterval(interval);
    while (polling) await delay(20);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    options.signal?.removeEventListener('abort', stop);
    store.release(key, owner);
  }
}
