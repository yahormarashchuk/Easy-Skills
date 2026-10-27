import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/persistence/store.js';
import { fixture } from '../helpers.js';
import { processIdentity } from '../../src/process-identity.js';

test('SQLite survives reopen and rejects lost updates or a second executor', async () => {
  const f = await fixture();
  try {
    const second = new Store(f.store.home), old = second.get(f.run.id);
    f.engine.approve(f.run.id, f.run.planHash);
    old.reason = 'stale'; assert.throws(() => second.save(old, 'stale'), /Concurrent/);
    const owner = f.store.acquire('run:test');
    assert.throws(() => second.acquire('run:test'), /in use/);
    second.release('run:test', 'wrong-owner'); assert.throws(() => second.acquire('run:test'), /in use/);
    f.store.release('run:test', owner); second.close();
    const reopened = new Store(f.store.home);
    assert.equal(reopened.get(f.run.id).status, 'approved');
    assert.equal(reopened.events(f.run.id).length, 2); reopened.close();
  } finally {await f.dispose();}
});

test('PID reuse releases an old birth identity while an unknown live identity remains conservative', async () => {
  const f = await fixture();
  try {
    const identity = processIdentity(process.pid);
    assert.ok(identity);
    f.store.db.prepare('INSERT INTO locks(key,owner,pid,acquired_at,process_identity) VALUES (?,?,?,?,?)').run('run:reused', 'old', process.pid, new Date().toISOString(), 'different-birth');
    const owner = f.store.acquire('run:reused'); assert.ok(owner); f.store.release('run:reused', owner);
    f.store.db.prepare('INSERT INTO locks(key,owner,pid,acquired_at) VALUES (?,?,?,?)').run('run:unknown', 'old', process.pid, new Date().toISOString());
    assert.throws(() => f.store.acquire('run:unknown'), /in use/);
  } finally {await f.dispose();}
});
test('decisions bind exact run, action, plan, head, expiry and single use', async () => {
  const f = await fixture();
  try {
    const id = f.store.createDecision(f.run, 'a'.repeat(40), 'final-merge', '12345678');
    assert.throws(() => f.store.consumeDecision(id, f.run, 'b'.repeat(40), 'final-merge', '12345678'), /Invalid/);
    assert.throws(() => f.store.consumeDecision(id, f.run, 'a'.repeat(40), 'final-merge', '87654321'), /Invalid/);
    f.store.consumeDecision(id, f.run, 'a'.repeat(40), 'final-merge', '12345678');
    assert.throws(() => f.store.consumeDecision(id, f.run, 'a'.repeat(40), 'final-merge', '12345678'), /Invalid/);
    const expired = f.store.createDecision(f.run, 'a'.repeat(40), 'final-merge', '12345678', -1);
    assert.throws(() => f.store.consumeDecision(expired, f.run, 'a'.repeat(40), 'final-merge', '12345678'), /Invalid/);
  } finally {await f.dispose();}
});
