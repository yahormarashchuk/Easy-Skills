import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { Run, Plan } from '../contracts.js';
import { VERSION, RunSchema } from '../contracts.js';
import { alive, ensureDir, hash, now, stateHome } from '../util.js';

export class ResourceBusy extends Error {}

export class Store {
  readonly db: DatabaseSync;
  readonly home: string;
  private transactionDepth = 0;
  constructor(home = stateHome()) {
    this.home = ensureDir(home);
    this.db = new DatabaseSync(join(home, 'runner.db'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, root TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, time TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, acquired_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (key TEXT PRIMARY KEY, payload TEXT NOT NULL, sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, plan_hash TEXT NOT NULL, head TEXT NOT NULL, action TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT);
      CREATE TABLE IF NOT EXISTS probes (key TEXT PRIMARY KEY, checked_at TEXT NOT NULL, version TEXT NOT NULL);
    `);
    const schema = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema');
    if (schema && !['1', '2'].includes(String(schema.value))) throw new Error('Unsupported database schema; use the matching runner version');
    if (schema?.value === '1') this.db.prepare('VACUUM INTO ?').run(join(home, `runner-before-v2-${Date.now()}-${randomUUID()}.db`));
    if (!schema || schema.value === '1') this.transaction(() => {
      // Another process may have migrated after discovery but before BEGIN IMMEDIATE.
      const current = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema');
      if (current?.value === '2') return;
      if (current && current.value !== '1') throw new Error('Database schema changed while opening; use the matching runner version');
      this.db.exec(`ALTER TABLE notifications ADD COLUMN lease_owner TEXT;
        ALTER TABLE notifications ADD COLUMN lease_until TEXT;
        ALTER TABLE notifications ADD COLUMN retry_at TEXT;
        ALTER TABLE decisions ADD COLUMN operation_key TEXT;
        ALTER TABLE probes ADD COLUMN executable TEXT;`);
      this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('schema', '2');
    });
  }
  close() {this.db.close();}
  transaction<T>(fn: () => T): T {
    const level = this.transactionDepth;
    this.db.exec(level ? `SAVEPOINT nested_${level}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {const result = fn(); this.db.exec(level ? `RELEASE nested_${level}` : 'COMMIT'); return result;}
    catch (e) {this.db.exec(level ? `ROLLBACK TO nested_${level}; RELEASE nested_${level}` : 'ROLLBACK'); throw e;}
    finally {this.transactionDepth--;}
  }
  create(root: string, commonDir: string, plan: Plan): Run {
    for (const repository of [root, resolve(commonDir, '..')]) {
      const homeRel = relative(realpathSync.native(repository), realpathSync.native(this.home));
      if (!homeRel.startsWith('..') && !isAbsolute(homeRel)) throw new Error('Runner state must be outside the repository');
    }
    const run: Run = {
      id: randomUUID(), root, commonDir, plan, planHash: hash(plan), revision: 0,
      status: 'draft', createdAt: now(), updatedAt: now(), branch: `feature/${plan.featureId}`,
      tasks: plan.tasks.map(t => ({id: t.id, integrated: false, cursor: 'BUILD', evidence: [], sessions: {}})),
      finalPhase: 'SYNC', finalEvidence: [], finalSessions: {}, failures: {fingerprint: '', head: '', count: 0},
    };
    this.transaction(() => {
      if (this.list().some(r => r.commonDir === commonDir && r.plan.featureId === plan.featureId && r.status !== 'merged'))
        throw new Error('An unfinished run already uses this feature ID');
      this.db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run(run.id, root, run.revision, JSON.stringify(run));
      this.event(run.id, 'draft.created', {planHash: run.planHash, version: VERSION});
    });
    return run;
  }
  get(id: string): Run {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    if (!row) throw new Error('Run not found: ' + id);
    return RunSchema.parse(JSON.parse(String(row.data)));
  }
  list(): Run[] {return this.db.prepare('SELECT data FROM runs ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.data)) as Run);}
  save(run: Run, type: string, detail: unknown = {}): void {
    const expected = run.revision;
    const saved = {...run, revision: expected + 1, updatedAt: now()};
    RunSchema.parse(saved);
    this.transaction(() => {
      const result = this.db.prepare('UPDATE runs SET revision=?,data=? WHERE id=? AND revision=?')
        .run(saved.revision, JSON.stringify(saved), run.id, expected);
      if (result.changes !== 1) throw new Error('Concurrent state change; reload the run');
      this.event(run.id, type, detail);
    });
    Object.assign(run, saved);
  }
  event(runId: string, type: string, data: unknown): void {
    this.db.prepare('INSERT INTO events(run_id,time,type,data) VALUES (?,?,?,?)').run(runId, now(), type, JSON.stringify(data));
  }
  events(id: string) {return this.db.prepare('SELECT sequence,time,type,data FROM events WHERE run_id=? ORDER BY sequence').all(id);}
  acquire(key: string): string {
    const owner = randomUUID();
    this.transaction(() => {
      if (key.startsWith('environment:') && this.list().some(run => run.activeResource === key.slice('environment:'.length) && alive(run.childPid)))
        throw new ResourceBusy('Resource has a live recorded child: ' + key);
      const existing = this.db.prepare('SELECT * FROM locks WHERE key=?').get(key);
      if (existing && alive(Number(existing.pid))) throw new ResourceBusy('Resource is in use: ' + key);
      this.db.prepare('DELETE FROM locks WHERE key=?').run(key);
      this.db.prepare('INSERT INTO locks VALUES (?,?,?,?)').run(key, owner, process.pid, now());
    });
    return owner;
  }
  release(key: string, owner: string) {this.db.prepare('DELETE FROM locks WHERE key=? AND owner=?').run(key, owner);}
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let owner: string | undefined;
    const deadline = Date.now() + 30_000;
    while (!owner) {
      try {owner = this.acquire(key);}
      catch (error) {
        if (!(error instanceof ResourceBusy) || Date.now() >= deadline) throw error;
        await delay(50);
      }
    }
    try {return await operation();} finally {this.release(key, owner);}
  }
  locked(key: string): boolean {
    const row = this.db.prepare('SELECT pid FROM locks WHERE key=?').get(key);
    return !!row && alive(Number(row.pid));
  }
  operation<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM operations WHERE key=?').get(key);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }
  recordOperation(key: string, runId: string, kind: string, value: unknown) {
    this.db.prepare('INSERT INTO operations VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data')
      .run(key, runId, kind, JSON.stringify(value));
  }
  enqueue(key: string, payload: unknown) {this.db.prepare('INSERT OR IGNORE INTO notifications(key,payload) VALUES (?,?)').run(key, JSON.stringify(payload));}
  pendingNotifications() {return this.db.prepare('SELECT * FROM notifications WHERE sent_at IS NULL').all();}
  markSent(key: string) {this.db.prepare('UPDATE notifications SET sent_at=?,attempts=attempts+1 WHERE key=?').run(now(), key);}
  markAttempt(key: string) {this.db.prepare('UPDATE notifications SET attempts=attempts+1 WHERE key=?').run(key);}
  claimNotification(owner: string, leaseMs = 120_000) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM notifications WHERE sent_at IS NULL
        AND (retry_at IS NULL OR retry_at<=?) AND (lease_until IS NULL OR lease_until<=?) ORDER BY rowid LIMIT 1`).get(now(), now());
      if (!row) return undefined;
      this.db.prepare('UPDATE notifications SET lease_owner=?,lease_until=? WHERE key=?')
        .run(owner, new Date(Date.now() + leaseMs).toISOString(), row.key!);
      return row;
    });
  }
  completeNotification(key: string, owner: string): boolean {
    return this.db.prepare('UPDATE notifications SET sent_at=?,lease_owner=NULL,lease_until=NULL,attempts=attempts+1 WHERE key=? AND lease_owner=?')
      .run(now(), key, owner).changes === 1;
  }
  retryNotification(key: string, owner: string, attempts: number) {
    this.db.prepare('UPDATE notifications SET lease_owner=NULL,lease_until=NULL,retry_at=?,attempts=attempts+1 WHERE key=? AND lease_owner=?')
      .run(new Date(Date.now() + Math.min(60_000 * 2 ** Math.min(attempts, 8), 4 * 60 * 60_000)).toISOString(), key, owner);
  }
  probeKey(assignment: unknown) {return hash(assignment);}
  recordProbe(assignment: unknown, version: string, executable?: string) {
    this.db.prepare('INSERT INTO probes(key,checked_at,version,executable) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET checked_at=excluded.checked_at,version=excluded.version,executable=excluded.executable')
      .run(this.probeKey(assignment), now(), version, executable || null);
  }
  hasProbe(assignment: unknown, identity?: {version?: string; executable?: string}): boolean {
    const row = this.db.prepare('SELECT * FROM probes WHERE key=?').get(this.probeKey(assignment));
    return !!row && (identity ? !!identity.executable && !!identity.version && row.version === identity.version && row.executable === identity.executable
      : Date.now() - Date.parse(String(row.checked_at)) < 24 * 60 * 60 * 1000);
  }
  createDecision(run: Run, head: string, action: string, code: string, ttlMs = 15 * 60_000): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO decisions(id,run_id,plan_hash,head,action,code_hash,expires_at,consumed_at) VALUES (?,?,?,?,?,?,?,NULL)').run(
      id, run.id, run.planHash, head, action, hash(code), new Date(Date.now() + ttlMs).toISOString());
    return id;
  }
  consumeDecision(id: string, run: Run, head: string, action: string, code: string, operationKey?: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id);
      const digest = Buffer.from(hash(code));
      if (!row || row.run_id !== run.id || row.plan_hash !== run.planHash || row.head !== head || row.action !== action ||
        (row.consumed_at ? !operationKey || row.operation_key !== operationKey : Date.parse(String(row.expires_at)) < Date.now()) ||
        !timingSafeEqual(Buffer.from(String(row.code_hash)), digest)) throw new Error('Invalid, expired, stale, or already consumed decision');
      this.db.prepare('UPDATE decisions SET consumed_at=COALESCE(consumed_at,?),operation_key=? WHERE id=?').run(now(), operationKey || null, id);
    });
  }
}
