import { randomUUID } from 'node:crypto';
import type { Run } from '../contracts.js';
import { Store } from '../persistence/store.js';
import { CheckFailure } from './check-failure.js';
import { message, redact, now } from '../util.js';

export class CodeFailure extends Error {}
export interface Repair {
  id: string; scope: string; failedStage: string; head: string; reason: string;
  bundle?: unknown; session?: string; state: 'pending' | 'completed'; createdAt: string;
}
export function repairKey(run: Run, scope: string) {return `${run.id}:repair:${scope}`;}
export function startRepair(store: Store, run: Run, scope: string, failedStage: string, head: string, error: CheckFailure | CodeFailure): Repair {
  const key = repairKey(run, scope);
  const history = store.operation<Repair[]>(key) || [];
  const pending = history.find(r => r.state === 'pending');
  if (pending) return pending;
  const maximum = run.plan.repairPolicy?.maxCompletedAttempts;
  if (maximum === undefined) throw new Error('Legacy plan has no approved repair limit; review a replacement plan');
  if (history.filter(r => r.state === 'completed').length >= maximum) throw new Error(`Approved repair limit reached (${maximum} completed attempts in ${scope}); a revised plan needs approval`);
  const repair: Repair = {id: randomUUID(), scope, failedStage, head, reason: redact(message(error)),
    bundle: error instanceof CheckFailure ? error.bundle : undefined,
    session: scope === 'feature' ? run.finalSessions.BUILD : run.tasks.find(t => scope === `task:${t.id}`)?.sessions.BUILD,
    state: 'pending', createdAt: now()};
  store.recordOperation(key, run.id, 'repair.created', [...history, repair]);
  return repair;
}
export function pendingRepair(store: Store, run: Run, scope: string) {
  return store.operation<Repair[]>(repairKey(run, scope))?.find(r => r.state === 'pending');
}
export function completeRepair(store: Store, run: Run, scope: string, id: string) {
  const key = repairKey(run, scope), history = store.operation<Repair[]>(key) || [];
  store.recordOperation(key, run.id, 'repair.completed', history.map(r => r.id === id ? {...r, state: 'completed'} : r));
}
