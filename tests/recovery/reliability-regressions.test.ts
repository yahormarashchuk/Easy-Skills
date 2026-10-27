import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { Engine } from '../../src/runner/engine.js';
import { ClientError } from '../../src/adapters/index.js';
import { pendingRepair, repairKey, type Repair } from '../../src/runner/repairs.js';
import { worker } from '../../src/runner/worker.js';
import { ResourceBusy } from '../../src/persistence/store.js';
import { hash } from '../../src/util.js';
import { cleanup, cleanupPlan } from '../../src/runner/cleanup.js';

for (const attack of ['check', 'branch', 'instructions'] as const) test(`result integrity stops ${attack} changes before accepting evidence`, async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-BUILD') {
        if (attack === 'check') {writeFileSync(join(o.cwd, 'check.mjs'), '// no-op\n'); writeFileSync(join(o.cwd, 'broken'), 'must fail');}
        if (attack === 'instructions') {mkdirSync(join(o.cwd, 'src'), {recursive: true}); writeFileSync(join(o.cwd, 'src/AGENTS.md'), 'New authority');}
        if (attack === 'branch') await f.git.run(['switch', '-c', 'unexpected-branch'], o.cwd);
      }
      return f.client.run(a, p, o);
    }}});
    const run = await engine.run(f.run.id);
    assert.equal(run.status, 'needs_decision'); assert.match(run.reason!, /Protected verification|ownership changed|instructions/);
    assert.equal(run.tasks[0]!.evidence.length, 0); assert.equal(run.tasks[1]!.worktree, undefined);
    assert.equal(f.github.prs.size, 0);
    assert.ok(existsSync(run.tasks[0]!.worktree!));
  } finally {await f.dispose();}
});

test('approved setup precedes baseline and runs once per worktree; cleanup reviews only unchanged setup outputs', async () => {
  const f = await fixture('node', {setup: [{id: 'deps', command: process.execPath, args: ['-e', 'const f=require("fs");f.mkdirSync("node_modules",{recursive:true});f.writeFileSync("node_modules/dependency.txt","fixture")'], timeoutMs: 1000}],
    checkSource: 'import fs from "node:fs"; if (!fs.existsSync("node_modules/dependency.txt")) process.exit(127);\n'});
  try {
    f.engine.approve(f.run.id, f.run.planHash); const ready = await f.engine.run(f.run.id);
    assert.equal(ready.status, 'ready', ready.reason || '');
    const setup = f.store.operation<any>(`${ready.id}:setup:${hash(ready.worktree)}`);
    assert.equal(setup.status, 'passed'); assert.equal(setup.ownedOutputs.length, 1);
    await f.engine.run(ready.id); assert.deepEqual(f.store.operation(`${ready.id}:setup:${hash(ready.worktree)}`), setup);
    await f.engine.confirmFinalMerge(ready.id, ready.finalReviewHead!);
    await assert.rejects(cleanupPlan(f.store, ready.id, f.github), /ignored/);
    const proposal = await cleanupPlan(f.store, ready.id, f.github, true);
    await cleanup(f.store, ready.id, proposal.hash, f.github, true);
    assert.equal(existsSync(ready.worktree!), false);
  } finally {await f.dispose();}
});

test('R5: a prior task check bundle cannot leak into another task REVIEW repair', async () => {
  const f = await fixture(); let firstBuild = true, secondReview = true, seen = false;
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-BUILD' && o.cwd.endsWith('one')) {
        if (firstBuild) {firstBuild = false; writeFileSync(join(o.cwd, 'broken'), 'first task check failure');}
        else rmSync(join(o.cwd, 'broken'), {force: true});
      }
      if (a.model === 'exact-REVIEW' && o.cwd.endsWith('two') && secondReview) {secondReview = false; return {outcome: 'failed', summary: 'Second task review finding', findings: []};}
      if (a.model === 'exact-BUILD' && o.cwd.endsWith('two') && !secondReview) {seen = true; assert.doesNotMatch(p, /"exitCode":1/); assert.match(p, /Second task review finding/);}
      return f.client.run(a, p, o);
    }}});
    const result = await engine.run(f.run.id); assert.equal(result.status, 'ready', result.reason || ''); assert.equal(seen, true);
  } finally {await f.dispose();}
});

test('R7: oversized file review stops for a decision without corrective BUILDs or false coverage', async () => {
  const f = await fixture(); let builds = 0;
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-BUILD') {builds++; writeFileSync(join(o.cwd, 'large.txt'), 'review this complete line\n'.repeat(60_000));}
      return f.client.run(a, p, o);
    }}});
    const run = await engine.run(f.run.id);
    assert.equal(run.status, 'needs_decision'); assert.equal(builds, 1); assert.match(run.reason!, /complete file diff|separate review/);
    assert.equal(run.tasks[0]!.reviewHead, undefined);
  } finally {await f.dispose();}
});

test('commit-before-save interruption resumes from its commit intent without invoking BUILD twice', async () => {
  const f = await fixture(); const save = f.store.save.bind(f.store); let once = true;
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    f.store.save = (run, type, detail) => {if (type === 'task.built' && once) {once = false; throw new Error('fixture interruption after commit');} return save(run, type, detail);};
    assert.equal((await f.engine.run(f.run.id)).status, 'needs_decision');
    const ready = await f.engine.run(f.run.id);
    assert.equal(ready.status, 'ready', ready.reason || ''); assert.equal(f.calls.filter(call => call.startsWith('exact-BUILD')).length, 2);
  } finally {f.store.save = save; await f.dispose();}
});

test('R14: a dequeued PR stops for a new authorization and is never resubmitted automatically', async () => {
  const f = await fixture(); let submissions = 0;
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    f.github.merge = async () => {submissions++; return {state: 'enqueued', operationId: 'fixture-request'};};
    Object.assign(f.github, {queueEntry: async () => false});
    const first = await f.engine.run(f.run.id), task = first.tasks[0]!;
    const key = `${first.id}:merge:${task.pr!.number}:${task.head}`, intent = f.store.operation<any>(key);
    f.store.recordOperation(key, first.id, 'fixture.clock', {...intent, nextPollAt: 0});
    const second = await f.engine.run(first.id);
    assert.equal(second.status, 'needs_decision'); assert.match(second.reason!, /left the merge queue/);
    assert.equal(submissions, 1); assert.equal(second.tasks[1]!.worktree, undefined);
  } finally {await f.dispose();}
});

test('R4: changing REVIEW prose and commits cannot reset the approved total repair limit', async () => {
  const f = await fixture(); let reviews = 0, builds = 0;
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-REVIEW') return {outcome: 'failed', summary: `Finding variant ${++reviews}`, findings: []};
      if (a.model === 'exact-BUILD') writeFileSync(join(o.cwd, 'repair.txt'), String(++builds));
      return f.client.run(a, p, o);
    }}});
    const run = await engine.run(f.run.id);
    assert.equal(run.status, 'needs_decision'); assert.match(run.reason!, /repair limit/);
    assert.equal(builds, 4); assert.equal(reviews, 4);
    const history = f.store.operation<Repair[]>(repairKey(run, 'task:one'))!;
    assert.equal(history.filter(r => r.state === 'completed').length, 3);
    assert.equal(new Set(history.map(r => r.id)).size, 3);
  } finally {await f.dispose();}
});

test('R6: final repair quota interruptions retain one repair ID, session and failed-stage count', async () => {
  const f = await fixture(); let finalReviews = 0, repairs = 0;
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-REVIEW' && o.cwd.endsWith('integration') && ++finalReviews === 1) return {outcome: 'failed', summary: 'Final defect', findings: []};
      if (a.model === 'exact-BUILD' && o.cwd.endsWith('integration')) {
        if (repairs++) assert.equal(o.session, 'repair-session');
        o.onSession?.('repair-session');
        if (repairs <= 2) throw new ClientError('quota', 'rate_limit_exceeded');
        writeFileSync(join(o.cwd, 'repaired.txt'), 'complete');
      }
      return f.client.run(a, p, o);
    }}});
    const first = await engine.run(f.run.id), id = pendingRepair(f.store, first, 'feature')!.id;
    assert.equal(first.finalPhase, 'REPAIR'); assert.equal(first.status, 'waiting_quota');
    const second = await engine.run(f.run.id);
    assert.equal(second.finalPhase, 'REPAIR'); assert.equal(second.failures.count, 1);
    assert.equal(pendingRepair(f.store, second, 'feature')!.id, id);
    const done = await engine.run(f.run.id);
    assert.equal(done.status, 'ready', done.reason || ''); assert.equal(repairs, 3);
    assert.equal(f.store.operation<Repair[]>(repairKey(done, 'feature'))!.length, 1);
  } finally {await f.dispose();}
});

test('R8: supervisor survives contention without mutating another lock owner', async () => {
  const f = await fixture(), abort = new AbortController(); let calls = 0;
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const original = f.store.get(f.run.id), engine = new Engine(f.store, {client: f.client, github: f.github, testRemote: f.remote});
    engine.reconcileFinalMerge = async id => f.store.get(id);
    engine.run = async () => {if (++calls === 1) throw new ResourceBusy('fixture contention'); abort.abort(); return f.store.get(f.run.id);};
    await worker(f.store, f.run.id, {engine, signal: abort.signal, notify: async () => {}});
    assert.equal(calls, 2); assert.equal(f.store.get(f.run.id).revision, original.revision);
  } finally {await f.dispose();}
});

test('model decision questions redact known credentials before public Issue comments', async () => {
  const f = await fixture(), secret = 'ghp_' + 'syntheticfixture'.repeat(3);
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run() {
      return {outcome: 'blocked', summary: 'Decision required', question: `Question includes ${secret}`, findings: []};
    }}});
    const run = await engine.run(f.run.id);
    assert.equal(run.status, 'needs_decision');
    assert.ok(f.github.commentsWritten.some(text => text.includes('[REDACTED]')));
    assert.ok(f.github.commentsWritten.every(text => !text.includes(secret)));
  } finally {await f.dispose();}
});

test('a completed final merge is recorded after rules changed using only saved approval and evidence', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash); const ready = await f.engine.run(f.run.id);
    await f.github.merge(ready.finalPr!.number, ready.finalReviewHead!);
    writeFileSync(join(f.root, 'AGENTS.md'), 'Changed after external merge');
    const merged = await f.engine.reconcileFinalMerge(ready.id);
    assert.equal(merged.status, 'merged'); assert.equal(f.github.merges.length, 3);
  } finally {await f.dispose();}
});

test('R15: explicit baseline recapture preserves history and abandoned replacements receive fresh resources', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, 'broken'), 'pre-existing'); await f.git.commit(f.root, 'Fail baseline'); await f.git.push('trunk', f.root);
    f.engine.approve(f.run.id, f.run.planHash); const blocked = await f.engine.run(f.run.id);
    assert.equal(f.store.operation<any>(`${blocked.id}:baseline`).status, 'pre_existing_failure');
    rmSync(join(f.root, 'broken')); const base = await f.git.commit(f.root, 'Repair baseline'); await f.git.push('trunk', f.root);
    const proposal = await f.engine.recaptureBaseline(blocked.id, base);
    await f.engine.recaptureBaseline(blocked.id, base, proposal.hash);
    assert.equal(f.store.operation<any>(`${blocked.id}:baseline`).status, 'passed');
    assert.ok(f.store.operation(`${blocked.id}:baseline-history:${proposal.hash}`));
    await f.engine.abandon(blocked.id);
    await assert.rejects(f.engine.run(blocked.id), /cannot execute/);
    assert.equal(f.store.get(blocked.id).status, 'abandoned');
    const replacement = f.store.create(f.run.root, f.run.commonDir, f.run.plan);
    assert.notEqual(replacement.branch, blocked.branch); assert.equal(replacement.approvedHash, undefined);
    assert.equal(replacement.tasks[0]!.worktree, undefined); assert.ok(existsSync(blocked.worktree!));
  } finally {await f.dispose();}
});
