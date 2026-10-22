import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/persistence/store.js';
import { fixture } from '../helpers.js';
import { hash } from '../../src/util.js';
import { Engine } from '../../src/runner/engine.js';

test('schema v1 migration backs up and preserves an existing alpha run without changing its approved plan', async () => {
  const f = await fixture(), home = mkdtempSync(join(tmpdir(), 'easy migration fixture '));
  try {
    const run = structuredClone(f.run);
    delete run.plan.rulesAgreement; delete run.plan.project.mergePolicy;
    run.planHash = hash(run.plan); run.approvedHash = run.planHash; run.status = 'approved';
    const old = new DatabaseSync(join(home, 'runner.db'));
    old.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO meta VALUES('schema','1');
      CREATE TABLE runs(id TEXT PRIMARY KEY,root TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE notifications(key TEXT PRIMARY KEY,payload TEXT NOT NULL,sent_at TEXT,attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE decisions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,plan_hash TEXT NOT NULL,head TEXT NOT NULL,action TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT);
      CREATE TABLE probes(key TEXT PRIMARY KEY,checked_at TEXT NOT NULL,version TEXT NOT NULL);`);
    old.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(run.id, run.root, run.revision, JSON.stringify(run)); old.close();
    const migrated = new Store(home);
    try {
      assert.equal(migrated.get(run.id).planHash, run.approvedHash);
      assert.deepEqual(migrated.get(run.id).plan, run.plan);
      assert.equal(migrated.db.prepare("SELECT value FROM meta WHERE key='schema'").get()!.value, '2');
      assert.equal(readdirSync(home).filter(p => p.startsWith('runner-before-v2-')).length, 1);
      migrated.enqueue('migrated', {}); assert.ok(migrated.claimNotification('fixture'));
      const restored = await new Engine(migrated, {client: f.client, github: f.github}).run(run.id);
      assert.equal(restored.status, 'needs_decision'); assert.match(restored.reason!, /Legacy plan lacks a rules agreement/);
    } finally {migrated.close();}
    const reopened = new Store(home); reopened.close();
    assert.equal(readdirSync(home).filter(p => p.startsWith('runner-before-v2-')).length, 1);
  } finally {await f.dispose(); rmSync(home, {recursive: true, force: true});}
});

test('another worker completing migration after version discovery does not migrate twice', () => {
  const home = mkdtempSync(join(tmpdir(), 'easy migration race fixture '));
  const old = new DatabaseSync(join(home, 'runner.db'));
  old.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schema','1');
    CREATE TABLE notifications(key TEXT PRIMARY KEY,payload TEXT NOT NULL,sent_at TEXT,attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE decisions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,plan_hash TEXT NOT NULL,head TEXT NOT NULL,action TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT);
    CREATE TABLE probes(key TEXT PRIMARY KEY,checked_at TEXT NOT NULL,version TEXT NOT NULL);`); old.close();
  const original = Store.prototype.transaction;
  let interleave = true, constructing: Store | undefined;
  Store.prototype.transaction = function<T>(fn: () => T): T {
    if (interleave) {
      interleave = false; constructing = this;
      // Complete the second opener before this opener acquires its migration transaction.
      const competitor = new Store(home); competitor.close();
    }
    return original.call(this, fn) as T;
  };
  try {
    const store = new Store(home);
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='schema'").get()!.value, '2');
  } finally {
    Store.prototype.transaction = original;
    constructing?.close(); rmSync(home, {recursive: true, force: true});
  }
});
