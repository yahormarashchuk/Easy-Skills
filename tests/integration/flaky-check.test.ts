import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { Engine } from '../../src/runner/engine.js';

/** A check script that counts its runs outside the worktree and fails on the listed run numbers. */
function countingCheck(counter: string, failOn: number[]) {
  return `import fs from "node:fs"; const p = ${JSON.stringify(counter)};
const n = (fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) : 0) + 1; fs.writeFileSync(p, String(n));
if (${JSON.stringify(failOn)}.includes(n) || fs.existsSync("broken")) { console.log("not ok - intermittent timeout"); process.exit(1); }\n`;
}

test('a check that fails once and passes on its retry at the same head does not start a repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy skills flaky ')), counter = join(dir, 'runs.txt');
  // Run 1 is the baseline; run 2 is the first task check and fails once.
  const f = await fixture('node', {checkSource: countingCheck(counter, [2])});
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    let builds = 0;
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-BUILD') builds++;
      return f.client.run(a, p, o);
    }}});
    const run = await engine.run(f.run.id);
    const events = f.store.events(run.id) as {type: string; data: string}[];
    assert.ok(!events.some(e => e.type === 'task.repair' || e.type === 'feature.repair'), 'no repair for an intermittent failure');
    const flaky = events.filter(e => e.type === 'check.flaky');
    assert.equal(flaky.length, 1);
    assert.match(flaky[0]!.data, /"checkId":"acceptance"/);
    assert.equal(builds, 2, 'one BUILD per task, no repair BUILD');
    const evidence = run.tasks.find(t => t.id === 'one')!.evidence;
    assert.ok(evidence.some(e => e.checkId === 'acceptance' && e.code === 0 && e.failedAttempt), 'the passing evidence records the failed first attempt');
  } finally {await f.dispose(); rmSync(dir, {recursive: true, force: true});}
});

test('a check that fails again on its retry starts a repair with the second failure', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    let builds = 0, repair = '';
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-BUILD') {
        if (++builds === 1) {(await import('node:fs')).writeFileSync(join(o.cwd, 'broken'), 'break acceptance');}
        else {repair = p; return {outcome: 'blocked', summary: 'Fixture inspected repair bundle', findings: []};}
      }
      return f.client.run(a, p, o);
    }}});
    await engine.run(f.run.id);
    const events = f.store.events(f.run.id) as {type: string}[];
    assert.ok(events.some(e => e.type === 'task.repair'));
    assert.ok(!events.some(e => e.type === 'check.flaky'));
    assert.equal(events.filter(e => e.type === 'check.finished').length >= 3, true, 'baseline, first attempt and retry');
    assert.match(repair, /"checkId":"acceptance"/);
  } finally {await f.dispose();}
});
