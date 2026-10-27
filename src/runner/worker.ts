import { setTimeout as delay } from 'node:timers/promises';
import { Store, ResourceBusy } from '../persistence/store.js';
import { Engine } from './engine.js';
import { pollRemote } from './remote.js';
import { flushNotifications } from '../notifications/index.js';
import { message, redact } from '../util.js';
import type { GitHub } from '../github/index.js';

export async function worker(store: Store, id: string, options: {engine?: Engine; github?: GitHub; signal?: AbortSignal; notify?: () => Promise<unknown>; now?: () => number; pollMs?: number} = {}) {
  const key = 'worker:' + id, owner = store.acquire(key);
  const abort = new AbortController();
  const stop = () => abort.abort();
  options.signal?.addEventListener('abort', stop, {once: true});
  if (options.signal?.aborted) abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const engine = options.engine || new Engine(store, {signal: abort.signal});
  const clock = options.now || Date.now, pollMs = options.pollMs || 15_000;
  const report = (type: string, error: unknown) => {
    const detail = {kind: error instanceof ResourceBusy ? 'resource_busy' : 'infrastructure', message: redact(message(error))};
    try {store.event(id, type, detail);} catch {process.stderr.write(JSON.stringify(detail) + '\n');}
  };
  let polling = false;
  async function poll() {
    if (polling) return; polling = true;
    try {
      const key = `${id}:worker-poll`, prior = store.operation<{nextPollAt: number}>(key);
      if (prior && prior.nextPollAt > clock()) return;
      store.recordOperation(key, id, 'worker.poll.scheduled', {nextPollAt: clock() + pollMs});
      for (const operation of [() => engine.reconcileFinalMerge(id), () => pollRemote(store, store.get(id), engine, options.github), options.notify || (() => flushNotifications(store))])
        try {await operation();} catch (error) {report('worker.poll.failed', error);}
    }
    finally {polling = false;}
  }
  await poll().catch(error => report('worker.poll.failed', error));
  const interval = setInterval(() => {void poll().catch(error => report('worker.poll.failed', error));}, Math.min(pollMs, 1000));
  try {
    while (!abort.signal.aborted) {
      const run = store.get(id);
      if (['merged', 'stopped', 'draft', 'abandoned'].includes(run.status)) break;
      const resume = store.operation<{resume: boolean}>(`${id}:resume-request`);
      const control = store.operation<{action: 'pause' | 'stop'}>(`${id}:control`);
      if (control?.action && run.status !== 'running' && !store.locked('run:' + id)) {
        let runOwner: string;
        try {runOwner = store.acquire('run:' + id);} catch (error) {if (error instanceof ResourceBusy) continue; throw error;}
        try {
          const current = store.get(id);
          current.status = control.action === 'pause' ? 'paused' : 'stopped';
          store.recordOperation(`${id}:control`, id, 'control', {});
          store.save(current, 'control.applied');
        } finally {store.release('run:' + id, runOwner);}
        continue;
      }
      if (['approved', 'running'].includes(run.status) ||
        (['waiting_quota', 'waiting_external', 'waiting_resource'].includes(run.status) && !!run.retryAt && Date.parse(run.retryAt) <= clock()) ||
        (resume?.resume && ['paused', 'needs_decision', 'waiting_quota', 'waiting_external', 'waiting_resource'].includes(run.status))) {
        try {
          await engine.run(id);
          if (resume?.resume) store.recordOperation(`${id}:resume-request`, id, 'remote.resume', {resume: false});
        } catch (error) {
          report('worker.execution.failed', error);
          // The engine owns run mutations. A failed lock acquisition must never write its owner's state.
          await delay(1000, undefined, {signal: abort.signal}).catch(() => {});
        }
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
