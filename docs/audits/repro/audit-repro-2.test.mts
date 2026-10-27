// Further audit reproductions; temporary repositories, fake clients and fake GitHub only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../../tests/helpers.js';
import { Engine } from '../../../src/runner/engine.js';

const passed = {outcome: 'passed' as const, summary: 'ok', findings: []};

test('R14 a merge-queue entry that GitHub removed leaves the run waiting forever as waiting_quota', async () => {
  const f = await fixture();
  try {
    let mergeCalls = 0;
    f.github.merge = async () => {mergeCalls++; return {state: 'enqueued' as const, operationId: 'queue-entry'};};
    const engine = new Engine(f.store, {client: f.client, github: f.github});
    engine.approve(f.run.id, f.run.planHash);
    const observed: string[] = [];
    for (let i = 0; i < 4; i++) {const run = await engine.run(f.run.id); observed.push(run.status + ': ' + run.reason?.split('\n')[0]);}
    const pr = [...f.github.prs.values()][0]!;
    console.log({observed, mergeRequestsSent: mergeCalls, prState: pr.state});
    assert.equal(mergeCalls, 1);
    assert.ok(observed.every(s => s.startsWith('waiting_quota')));
  } finally {await f.dispose();}
});

test('R15 a failed baseline blocks permanently after main is fixed, and the feature ID cannot be reused', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, 'broken'), 'pre-existing failure\n');
    await f.git.run(['add', '.']); await f.git.run(['commit', '-m', 'break main']); await f.git.push('trunk', f.root);
    const engine = new Engine(f.store, {client: f.client, github: f.github});
    engine.approve(f.run.id, f.run.planHash);
    const first = (await engine.run(f.run.id)).reason;
    unlinkSync(join(f.root, 'broken'));
    await f.git.run(['add', '.']); await f.git.run(['commit', '-m', 'fix main']); await f.git.push('trunk', f.root);
    const second = (await engine.run(f.run.id)).reason;
    const identity = await f.git.identity();
    const reuse = (() => {try {f.store.create(identity.root, identity.commonDir, f.run.plan); return 'created';} catch (e) {return (e as Error).message;}})();
    console.log({first, afterMainFixed: second, reuseSameFeatureId: reuse, clientCalls: f.calls.length});
    assert.match(second || '', /Baseline pre_existing_failure/);
    assert.match(reuse, /unfinished run already uses this feature ID/);
  } finally {await f.dispose();}
});
