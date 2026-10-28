import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { requireAgreement } from '../../src/runner/onboarding.js';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { execute, terminateTree } from '../../src/process.js';
import { alive, rulesHash } from '../../src/util.js';
import { fixture } from '../helpers.js';
import { setTimeout as delay } from 'node:timers/promises';
import { protectedManifest } from '../../src/runner/protected-inputs.js';

test('CLI onboarding previews changes and preserves existing instructions; a detached worker survives its launching CLI', async () => {
  const f = await fixture();
  let workerPid: number | undefined;
  try {
    for (const file of ['project.yaml', 'decisions/onboarding.json']) rmSync(join(f.root, '.easy-skills', file));
    const config = join(f.dir, 'project.yaml'); writeFileSync(config, stringify(f.run.plan.project));
    const cli = async (args: string[]) => {
      const result = await execute({command: process.execPath, args: ['--import', 'tsx', resolve('src/cli/index.ts'), '--project', f.root, ...args]},
        {cwd: process.cwd(), env: {...process.env, EASY_SKILLS_HOME: f.store.home}, timeoutMs: 20_000});
      assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
    };
    const proposal = await cli(['init', '--config', config]);
    assert.equal(existsSync(join(f.root, '.easy-skills/project.yaml')), false);
    await cli(['init', '--config', config, '--apply-hash', proposal.hash]);
    assert.ok(readFileSync(join(f.root, 'AGENTS.md'), 'utf8').startsWith('Use focused tests.'));
    assert.equal(readFileSync(join(f.root, 'AGENTS.md.easy-skills-backup'), 'utf8'), 'Use focused tests.\n');
    const draft = JSON.parse(readFileSync(join(f.root, '.easy-skills/decisions/onboarding.json'), 'utf8'));
    const interviewFile = join(f.dir, 'interview.json');
    writeFileSync(interviewFile, JSON.stringify({...draft, status: 'agreed', decisions: draft.decisions.map((d: any) => ({...d, status: 'resolved', answer: 'Reviewed by fixture owner'}))}));
    const agreement = await cli(['agree-rules', '--file', interviewFile]);
    await cli(['agree-rules', '--file', interviewFile, '--apply-hash', agreement.hash]);
    const plan = {...f.run.plan, featureId: 'cli-feature', protectedInputs: protectedManifest(f.root, f.run.plan.project), rulesHash: rulesHash(f.root), rulesAgreement: requireAgreement(f.root)};
    const file = join(f.dir, 'execution.yaml'); writeFileSync(file, stringify(plan));
    const drafted = await cli(['feature', 'draft', '--file', file]);
    assert.equal(drafted.status, 'draft');
    await cli(['feature', 'approve', drafted.runId, '--hash', drafted.planHash]);
    // Force a safe stop before any external GitHub operation or paid model request.
    f.store.db.prepare('DELETE FROM probes').run();
    const started = await cli(['start', drafted.runId]); workerPid = started.pid;
    assert.ok(workerPid && alive(workerPid));
    const deadline = Date.now() + 10_000;
    while (f.store.get(drafted.runId).status !== 'needs_decision' && Date.now() < deadline) await delay(50);
    const status = await cli(['status', drafted.runId]);
    assert.equal(status.status, 'needs_decision'); assert.match(status.reason, /exact model configuration/);
    assert.ok(alive(workerPid));
    const reattached = await cli(['start', drafted.runId]); assert.equal(reattached.attached, true);
    await cli(['stop', drafted.runId]);
    const stoppedAt = Date.now() + 10_000;
    while (alive(workerPid) && Date.now() < stoppedAt) await delay(50);
    assert.equal(alive(workerPid), false);
    assert.equal(f.store.get(drafted.runId).status, 'stopped');
  } finally {
    if (workerPid && alive(workerPid)) {await terminateTree(workerPid); await delay(200);}
    await f.dispose();
  }
});

test('resume of an already monitored ready feature does not leave a deferred execution request', async () => {
  const f = await fixture(), key = 'worker:' + f.run.id, owner = f.store.acquire(key);
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash); run.status = 'ready'; f.store.save(run, 'fixture.ready');
    const result = await execute({command: process.execPath, args: ['--import', 'tsx', resolve('src/cli/index.ts'), '--project', f.root, 'resume', run.id]},
      {cwd: process.cwd(), env: {...process.env, EASY_SKILLS_HOME: f.store.home}, timeoutMs: 20_000});
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).attached, true);
    assert.equal(f.store.operation(`${run.id}:resume-request`), undefined);
  } finally {f.store.release(key, owner); await f.dispose();}
});

test('readable status highlights the current stage and JSON status stays machine-readable', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const run = async (args: string[]) => execute({command: process.execPath, args: ['--import', 'tsx', resolve('src/cli/index.ts'), '--project', f.root, ...args]},
      {cwd: process.cwd(), env: {EASY_SKILLS_HOME: f.store.home}, timeoutMs: 20_000});
    const readable = await run(['status']);
    assert.equal(readable.code, 0, readable.stderr);
    assert.match(readable.stdout, /CURRENT STAGE: BUILD/);
    assert.match(readable.stdout, /Implement the approved changes/);
    assert.doesNotMatch(readable.stdout, /\u001b\[/);
    const json = await run(['status', '--json']);
    assert.equal(json.code, 0, json.stderr); assert.equal(JSON.parse(json.stdout)[0].status, 'approved');
  } finally {await f.dispose();}
});

for (const status of ['approved', 'running'] as const) test(`R9: CLI resume accepts ${status} without duplicating an attached executor`, async () => {
  const f = await fixture(), key = 'worker:' + f.run.id, owner = f.store.acquire(key);
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash); run.status = status; f.store.save(run, 'fixture.crash-state');
    const result = await execute({command: process.execPath, args: ['--import', 'tsx', resolve('src/cli/index.ts'), '--project', f.root, 'resume', run.id]},
      {cwd: process.cwd(), env: {EASY_SKILLS_HOME: f.store.home}, timeoutMs: 20000});
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).attached, true);
  } finally {f.store.release(key, owner); await f.dispose();}
});

test('guided commands resolve the repository root from a nested working directory', async () => {
  const f = await fixture();
  try {
    const nested = join(f.root, 'nested directory'); mkdirSync(nested);
    const result = await execute({command: process.execPath, args: ['--import', 'tsx', resolve('src/cli/index.ts'), '--project', nested, 'init', '--non-interactive']},
      {cwd: process.cwd(), env: {EASY_SKILLS_HOME: f.store.home}, timeoutMs: 20_000});
    assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Project rules already approved/);
    assert.equal(existsSync(join(nested, '.easy-skills')), false);
  } finally {await f.dispose();}
});
