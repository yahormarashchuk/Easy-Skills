import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { assembleContext, context } from '../../src/runner/context.js';
import { Engine } from '../../src/runner/engine.js';

test('baseline failure stops before BUILD and is saved separately from feature evidence', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, 'broken'), 'pre-existing');
    await f.git.run(['add', '.']); await f.git.run(['commit', '-m', 'Existing failure']); await f.git.push('trunk', f.root);
    f.engine.approve(f.run.id, f.run.planHash);
    const run = await f.engine.run(f.run.id);
    assert.equal(run.status, 'needs_decision'); assert.equal(f.calls.length, 0);
    assert.equal(f.store.operation<any>(`${run.id}:baseline`).status, 'pre_existing_failure');
    assert.equal(run.tasks[0]!.evidence.length, 0);
  } finally {await f.dispose();}
});

test('BUILD receives cleaned check failure details instead of a private log reference', async () => {
  const f = await fixture(); let repairs = '';
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    let builds = 0;
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-BUILD') {
        if (++builds === 1) writeFileSync(join(o.cwd, 'broken'), 'break acceptance');
        else {repairs = p; return {outcome: 'blocked', summary: 'Fixture inspected repair bundle', findings: []};}
      }
      return f.client.run(a, p, o);
    }}});
    await engine.run(f.run.id);
    assert.match(repairs, /"exitCode":1/); assert.match(repairs, /"checkId":"acceptance"/);
    assert.match(repairs, /"command":/); assert.ok(!repairs.includes(f.store.home));
  } finally {await f.dispose();}
});

test('a scoped task excludes unrelated large layer rules and full session history', async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, '.easy-skills/rules/layers'); mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'api.md'), 'API_REQUIRED_CONSTRAINT');
    writeFileSync(join(dir, 'ui.md'), 'UNRELATED_UI_RULE '.repeat(20_000));
    const task = {...f.run.plan.tasks[0]!, scope: {areas: ['api'], paths: ['src/api/']}};
    f.run.tasks[1]!.sessions.BUILD = 'PRIVATE_UNRELATED_SESSION';
    const prompt = context(f.run, 'BUILD', task);
    assert.match(prompt, /API_REQUIRED_CONSTRAINT/); assert.ok(!prompt.includes('UNRELATED_UI_RULE'));
    assert.ok(!prompt.includes('PRIVATE_UNRELATED_SESSION'));
    assert.match(prompt, /estimatedTokens/);
  } finally {await f.dispose();}
});

test('whole-feature review receives the final check evidence, task stages do not', async () => {
  const f = await fixture();
  try {
    f.run.finalEvidence = [{checkId: 'acceptance', head: 'a'.repeat(40), code: 0, finishedAt: '2026-11-03T10:29:59.000Z', log: 'PRIVATE_LOG_PATH'}];
    const review = context(f.run, 'REVIEW');
    assert.match(review, /\[check-evidence\]\n\[\{"id":"acceptance","head":"a{40}","code":0,/);
    assert.ok(!review.includes('PRIVATE_LOG_PATH'));
    assert.ok(!context(f.run, 'REVIEW', f.run.plan.tasks[0]!).includes('[check-evidence]'));
  } finally {await f.dispose();}
});

test('an exact session is not sent its unchanged large sections again, but each request keeps its framing and observation', async () => {
  const f = await fixture();
  try {
    const first = assembleContext(f.run, 'REVIEW', undefined, 'first observation');
    assert.ok(first.manifest.sections.every(s => s.sent), 'a new session receives everything');
    const second = assembleContext(f.run, 'REVIEW', undefined, 'second observation', undefined, first.manifest);
    const sent = (name: string) => second.manifest.sections.find(s => s.name === name)!.sent;
    for (const name of ['core', 'trust', 'review-scope', 'current-observation']) assert.ok(second.manifest.sections.some(s => s.name === name) ? sent(name) : true, name);
    assert.equal(sent('current-observation'), true);
    for (const name of ['procedure', 'workflow', 'specification', 'scope']) assert.equal(sent(name), false, name);
    assert.ok(second.prompt.length < first.prompt.length * 0.6, 'the second prompt is much smaller');
    assert.match(second.prompt, /\[specification unchanged in this exact session\]/); assert.match(second.prompt, /second observation/);
    f.run.plan.spec += ' Changed.';
    assert.equal(assembleContext(f.run, 'REVIEW', undefined, 'x', undefined, first.manifest).manifest.sections.find(s => s.name === 'specification')!.sent, true, 'a changed section is sent again');
  } finally {await f.dispose();}
});
