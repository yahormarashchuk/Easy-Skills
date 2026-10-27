import { tmpdir } from 'node:os';
import type { Run } from '../contracts.js';
import type { Store } from '../persistence/store.js';
import { hash, message, now, redact } from '../util.js';
import { CheckFailure } from './check-failure.js';

export function errorIdentity(error: unknown): string {
  const detail = message(error) + (error instanceof CheckFailure && error.bundle.tests.length ? '\n' + error.bundle.tests.join('\n') : '');
  return redact(detail).replaceAll(tmpdir(), '<temp>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds)\b/g, '<duration>')
    .replace(/\bnot ok \d+\s*-?/g, 'not ok -')
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?\b/g, '<time>')
    .replace(/\b(?:PID|process id)\s*[:=]?\s*\d+/gi, 'PID <id>')
    .replace(/(?:[A-Z]:[\\/]|\/)(?:[^\s"']*[\\/])?(?:tmp|temp)[\\/][^\s"']*/gi, '<temp-path>')
    .replace(/\b[0-9a-f]{40,64}\b/gi, '<revision>');
}

export function recordFailure(store: Store, run: Run, scope: string, error: unknown, head: string): void {
  const fingerprint = hash(errorIdentity(error)), key = `${run.id}:failures:${scope}`;
  const ledger = store.operation<Record<string, {count: number; revisions: string[]; observedAt: string}>>(key) || {};
  const previous = ledger[fingerprint];
  ledger[fingerprint] = {count: (previous?.count || 0) + 1, revisions: [...(previous?.revisions || []), head].slice(-3), observedAt: now()};
  store.recordOperation(key, run.id, 'repair.failures', ledger);
  // HEAD is an observation, never evidence that the defect was resolved.
  run.failures = {fingerprint, head, count: ledger[fingerprint].count};
}

export function confirmedProgress(store: Store, run: Run, scope: string, head: string): void {
  store.recordOperation(`${run.id}:failures:${scope}`, run.id, 'repair.progress', {});
  store.event(run.id, 'repair.progress', {scope, head, criterion: 'independent stage succeeded'});
}
