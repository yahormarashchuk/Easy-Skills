import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { execute } from '../../src/process.js';
import { ago, describe, taskTable, watchRun, watchTasks } from '../../src/cli/monitor.js';
import { fixture } from '../helpers.js';

const style = {color: false, unicode: false};
const screen = () => {const chunks: string[] = []; return {chunks, out: {write: (text: string) => chunks.push(text), columns: 120, rows: 40}};};

test('activity reads like progress, not process bookkeeping', () => {
  assert.equal(describe('check.started', {check: 'unit', baseline: true}), 'Check unit (baseline) started');
  assert.equal(describe('check.finished', {checkId: 'unit', code: 0}), 'Check unit passed');
  assert.equal(describe('check.finished', {checkId: 'unit', code: 2}), 'Check unit failed (exit 2)');
  assert.equal(describe('run.suspended', {reason: 'Baseline failed'}), 'Stopped: Baseline failed');
  assert.equal(describe('setup.child.exited', {}), undefined);
  assert.equal(ago(new Date(0).toISOString(), 90_000), '1m ago');
});

test('delegated and escalated decisions are visible in the activity', () => {
  assert.equal(describe('decision.delegated', {stage: 'BUILD', question: 'Which path?'}), 'The delegate answered a BUILD question without you: Which path?');
  assert.equal(describe('decision.escalated', {}), 'The delegate left a question to you');
  assert.match(describe('decision.requested', {})!, /^Your decision is needed/);
});

test('a long question is wrapped, not cut, and stays on screen with the command that answers it', async () => {
  const f = await fixture();
  try {
    const question = 'Runner: is CHECKIN_LEGACY_TEST_DATABASE_URL available in your environment? If it is not, the Slice 0 verification cannot complete, and the owner needs to provision the disposable synthetic PostgreSQL database for it.';
    const run = f.engine.approve(f.run.id, f.run.planHash); run.status = 'needs_decision'; run.reason = 'Verification stays blocked on runner configuration: ' + 'detail '.repeat(30);
    run.pendingDecision = {id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', planHash: run.planHash, head: 'a'.repeat(40), stage: 'BUILD', question};
    f.store.save(run, 'fixture.waiting');
    for (let i = 0; i < 12; i++) f.store.save(run, 'check.started', {check: 'check-' + i, baseline: false});
    const view = screen(), controller = new AbortController();
    view.out.columns = 50; view.out.rows = 30;
    const watching = watchRun(f.store, run.id, {style, out: view.out, intervalMs: 20, signal: controller.signal});
    setTimeout(() => controller.abort(), 80);
    await watching;
    const text = view.chunks.join('').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ');
    assert.ok(text.includes(question.replace(/\s+/g, ' ')), 'the whole question is shown');
    assert.ok(text.includes('YOUR ACTION: easy-skills answer'));
    assert.ok(!text.includes('...'), 'nothing is cut with an ellipsis');
    for (const chunk of view.chunks) for (const line of chunk.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split(/[\r\n]+/)) assert.ok(line.length <= 49 || line.startsWith('Stopped watching'), line);
  } finally {await f.dispose();}
});

test('the task table lists every task with the ID status accepts, those waiting for the owner first', async () => {
  const f = await fixture();
  try {
    const waiting = f.engine.approve(f.run.id, f.run.planHash); waiting.status = 'needs_decision'; f.store.save(waiting, 'fixture.waiting');
    const table = taskTable([{...waiting, plan: {...waiting.plan, featureId: 'task-running'}, status: 'running', id: 'b'.repeat(36)}, waiting, {...waiting, status: 'abandoned', id: 'c'.repeat(36), plan: {...waiting.plan, featureId: 'task-old'}}]);
    const rows = table.split('\n');
    assert.match(rows[0]!, /^ID\s+RUN\s+STAGE\s+STATUS\s+UPDATED\s+TASK$/);
    assert.match(rows[1]!, /^sample\s+\S{8}\s+BUILD\s+needs_decision\s/);
    assert.match(rows[2]!, /^task-running\s/);
    assert.match(rows[3]!, /^task-old\s.*abandoned/);
  } finally {await f.dispose();}
});

test('watching a run stays open while it waits for the owner, shows the next command, and Ctrl+C only stops watching', async () => {
  const f = await fixture();
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash); run.status = 'running'; f.store.save(run, 'fixture.running');
    f.store.save(run, 'check.started', {check: 'acceptance', baseline: true});
    const first = screen(), controller = new AbortController();
    const watching = watchRun(f.store, run.id, {style, out: first.out, intervalMs: 20, signal: controller.signal});
    setTimeout(() => controller.abort(), 120);
    assert.equal((await watching).status, 'running');
    const text = first.chunks.join('');
    assert.match(text, /CURRENT STAGE: BUILD/); assert.match(text, /Check acceptance \(baseline\) started/);
    assert.match(text, /Stopped watching\. Watch again: easy-skills status sample/);
    assert.equal(f.store.get(run.id).status, 'running');

    const second = screen();
    const following = watchRun(f.store, run.id, {style, out: second.out, intervalMs: 20});
    const current = f.store.get(run.id); current.status = 'needs_decision'; current.reason = 'Approved repair limit reached (3 completed attempts in feature)';
    f.store.save(current, 'run.suspended', {reason: current.reason});
    await new Promise(resolve => setTimeout(resolve, 120));
    const waiting = second.chunks.join('');
    assert.match(waiting, /Stopped: Approved repair limit reached/);
    assert.match(waiting, />>> YOUR ACTION: easy-skills adopt-config sample --extra-repairs 2/);
    assert.doesNotMatch(waiting, /Stopped watching/, 'a run waiting for the owner keeps the view open');
    const stopped = f.store.get(run.id); stopped.status = 'stopped'; f.store.save(stopped, 'control.applied');
    assert.equal((await following).status, 'stopped');
  } finally {await f.dispose();}
});

test('watching several tasks stays open for paused ones and ends once all have finished', async () => {
  const f = await fixture();
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash); run.status = 'paused'; f.store.save(run, 'fixture.paused');
    const view = screen();
    const watching = watchTasks(f.store, f.run.root, {style, out: view.out, intervalMs: 20});
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.match(view.chunks.join(''), /sample\s+\S{8}\s+BUILD\s+paused/);
    const stopped = f.store.get(run.id); stopped.status = 'stopped'; f.store.save(stopped, 'control.applied');
    const runs = await watching;
    assert.deepEqual(runs.map(r => r.status), ['stopped']);
  } finally {await f.dispose();}
});

test('show ids lists tasks and status stays a single snapshot when output is not a terminal', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const cli = (args: string[]) => execute({command: process.execPath, args: ['--import', 'tsx', resolve('src/cli/index.ts'), '--project', f.root, ...args]},
      {cwd: process.cwd(), env: {EASY_SKILLS_HOME: f.store.home}, timeoutMs: 20_000});
    const ids = await cli(['show', 'ids']);
    assert.equal(ids.code, 0, ids.stderr); assert.match(ids.stdout, /^ID\s+RUN/); assert.match(ids.stdout, /\nsample\s+\S{8}\s+BUILD\s+approved\s/);
    const status = await cli(['status', 'sample']);
    assert.equal(status.code, 0, status.stderr); assert.match(status.stdout, /CURRENT STAGE: BUILD/); assert.doesNotMatch(status.stdout, /Watching|Ctrl\+C/);
    const unknown = await cli(['show', 'everything']);
    assert.notEqual(unknown.code, 0); assert.match(unknown.stderr, /Use easy-skills show ids/);
  } finally {await f.dispose();}
});
