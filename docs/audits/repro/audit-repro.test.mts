// Independent audit reproductions. Read-only with respect to the repository: every
// scenario uses temporary Git repositories, temporary state homes and fake clients/GitHub.
// Run from the repository root: node --import tsx --test --test-concurrency=1 docs/audits/repro/*.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../../tests/helpers.js';
import { execute } from '../../../src/process.js';
import { CliClient, ClientError, classify, invocation } from '../../../src/adapters/index.js';
import { assignmentMcp } from '../../../src/adapters/mcp-permissions.js';
import { Engine } from '../../../src/runner/engine.js';
import { worker } from '../../../src/runner/worker.js';
import { ResourceBusy } from '../../../src/persistence/store.js';
import { Git } from '../../../src/git/index.js';
import { Gh } from '../../../src/github/index.js';
import { generatePlan } from '../../../src/runner/planning.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const win = process.platform === 'win32';
const passed = {outcome: 'passed' as const, summary: 'ok', findings: []};
const leaf = (cwd: string) => cwd.split(/[\\/]/).pop()!;

test('R1 Windows: a git.cmd in the working directory is executed instead of Git', {skip: !win}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'es-audit-plant-'));
  writeFileSync(join(dir, 'git.cmd'), '@echo PLANTED-GIT %*\r\n');
  try {
    const viaExecute = await execute({command: 'git', args: ['--version']}, {cwd: dir});
    const viaGitClass = await new Git(dir).run(['--version']);
    console.log('execute stdout:', viaExecute.stdout.trim(), '| Git.run:', viaGitClass);
    assert.match(viaExecute.stdout, /PLANTED-GIT/);
    assert.match(viaGitClass, /PLANTED-GIT/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('R2 Windows: gh auth failure (no HTTP status) is classified as a network wait', {skip: !win}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'es-audit-gh-'));
  writeFileSync(join(dir, 'gh.cmd'), '@echo To get started with GitHub CLI, please run:  gh auth login 1>&2\r\n@exit /b 4\r\n');
  try {
    const error = await new Gh('owner/repo', dir).viewPr(1).catch(e => e);
    console.log('error kind:', error.kind, '|', error.message);
    assert.ok(error instanceof ClientError); assert.equal(error.kind, 'network');
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('R3 Windows: an npm claude.cmd shim makes every Claude invocation fail the metacharacter guard', {skip: !win}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'es-audit-claude-'));
  writeFileSync(join(dir, 'claude.cmd'), '@echo should-not-run\r\n');
  const old = process.env.PATH; process.env.PATH = dir + ';' + old;
  try {
    const cmd = invocation({provider: 'claude-code', model: 'claude-sonnet-5-5'}, undefined, 'read');
    console.log('resolved command:', cmd.command);
    await assert.rejects(new CliClient().run({provider: 'claude-code', model: 'claude-sonnet-5-5'}, 'p', {cwd: dir, mode: 'read', stage: 'VERIFY'}),
      /Unsafe metacharacter argument/);
  } finally {process.env.PATH = old; rmSync(dir, {recursive: true, force: true});}
});

test('R4 REVIEW rejections with differing prose never reach the three-identical stop', async () => {
  const f = await fixture();
  try {
    let builds = 0, reviews = 0;
    const engine = new Engine(f.store, {github: f.github, client: {...f.client, async run(a, _p, o) {
      o.onSession?.(o.session || 'session-' + a.model);
      if (a.model === 'exact-BUILD') {
        builds++;
        if (builds > 8) return {outcome: 'blocked', summary: 'audit harness stop', findings: [], question: 'stop?'};
        writeFileSync(join(o.cwd, 'one.txt'), 'attempt ' + builds + '\n');
        return passed;
      }
      if (a.model === 'exact-REVIEW') {reviews++; return {outcome: 'failed', summary: `Reviewer wording ${reviews}: acceptance is not demonstrated`, findings: []};}
      return passed;
    }}});
    engine.approve(f.run.id, f.run.planHash);
    const run = await engine.run(f.run.id);
    console.log({builds, reviews, status: run.status, failuresCount: run.failures.count, reason: run.reason});
    assert.equal(builds, 9); assert.equal(reviews, 8);
    assert.doesNotMatch(run.reason || '', /Three identical/);
  } finally {await f.dispose();}
});

test('R5 a REVIEW failure in task two is repaired with task one\'s stale check-failure bundle', async () => {
  const f = await fixture();
  try {
    let oneBuilds = 0, twoReviews = 0; const prompts: string[] = [];
    const engine = new Engine(f.store, {github: f.github, client: {...f.client, async run(a, p, o) {
      o.onSession?.(o.session || 'session-' + a.model + leaf(o.cwd));
      if (a.model === 'exact-BUILD' && leaf(o.cwd) === 'one') {
        oneBuilds++;
        writeFileSync(join(o.cwd, 'one.txt'), 'x\n');
        if (oneBuilds === 1) writeFileSync(join(o.cwd, 'broken'), 'fails the check\n');
        else if (existsSync(join(o.cwd, 'broken'))) unlinkSync(join(o.cwd, 'broken'));
      }
      if (a.model === 'exact-BUILD' && leaf(o.cwd) === 'two') {prompts.push(p); writeFileSync(join(o.cwd, 'two.txt'), 'x\n');}
      if (a.model === 'exact-REVIEW' && leaf(o.cwd) === 'two' && ++twoReviews === 1) return {outcome: 'failed', summary: 'Task two misses an edge case', findings: []};
      return passed;
    }}});
    engine.approve(f.run.id, f.run.planHash);
    const run = await engine.run(f.run.id);
    const repair = prompts[1] || '';
    const bundle = repair.match(/Cleaned failure bundle: (\{.*?"expected":"[^"]*"[^}]*\})/)?.[1] || '';
    console.log({status: run.status, task2BuildCalls: prompts.length, bundleInTask2Repair: bundle.slice(0, 160)});
    assert.match(repair, /Task two misses an edge case/);
    assert.match(repair, /"checkId":"acceptance".*"exitCode":1/);
  } finally {await f.dispose();}
});

test('R6 final-phase quota interruptions during repair BUILD consume repair attempts', async () => {
  const f = await fixture();
  try {
    let finalBuildAttempts = 0, finalVerifies = 0;
    const engine = new Engine(f.store, {github: f.github, client: {...f.client, async run(a, _p, o) {
      o.onSession?.(o.session || 'session-' + a.model + leaf(o.cwd));
      const final = leaf(o.cwd) === 'integration';
      if (a.model === 'exact-BUILD' && !final) writeFileSync(join(o.cwd, leaf(o.cwd) + '.txt'), 'x\n');
      if (final && a.model === 'exact-VERIFY') {finalVerifies++; return {outcome: 'failed', summary: 'End-to-end scenario missing', findings: []};}
      if (final && a.model === 'exact-BUILD') {finalBuildAttempts++; throw new ClientError('quota', 'usage limit reached');}
      return passed;
    }}});
    engine.approve(f.run.id, f.run.planHash);
    const states: string[] = [];
    for (let i = 0; i < 3; i++) states.push((await engine.run(f.run.id)).status);
    const run = f.store.get(f.run.id);
    console.log({states, finalVerifies, finalBuildAttempts, completedRepairs: 0, reason: run.reason});
    assert.deepEqual(states, ['waiting_quota', 'waiting_quota', 'needs_decision']);
    assert.match(run.reason || '', /Three identical unsuccessful whole-feature repairs/);
  } finally {await f.dispose();}
});

test('R7 a task diff over 1 MiB fails REVIEW setup and is retried as a code repair', async () => {
  const f = await fixture();
  try {
    let builds = 0, reviews = 0;
    const big = Array.from({length: 60_000}, (_, i) => `generated fixture line ${i}`).join('\n');
    const engine = new Engine(f.store, {github: f.github, client: {...f.client, async run(a, _p, o) {
      o.onSession?.(o.session || 'session-' + a.model);
      if (a.model === 'exact-BUILD') {builds++; writeFileSync(join(o.cwd, 'generated.txt'), big);}
      if (a.model === 'exact-REVIEW') reviews++;
      return passed;
    }}});
    engine.approve(f.run.id, f.run.planHash);
    const run = await engine.run(f.run.id);
    console.log({bytes: big.length, builds, reviews, status: run.status, reason: run.reason?.slice(0, 140)});
    assert.equal(reviews, 0); assert.equal(builds, 3);
    assert.match(run.reason || '', /Three identical .*exceeded the capture limit/s);
  } finally {await f.dispose();}
});

test('R8 the detached worker terminates when another command holds the run lock', async () => {
  const f = await fixture();
  try {
    const engine = new Engine(f.store, {client: f.client, github: f.github});
    engine.approve(f.run.id, f.run.planHash);
    f.store.acquire('run:' + f.run.id); // e.g. `easy-skills sync` or `merge` running in another terminal
    const error = await worker(f.store, f.run.id, {engine, github: f.github, notify: async () => {}}).catch(e => e);
    console.log({workerError: error?.constructor?.name, message: error?.message, workerLockHeld: f.store.locked('worker:' + f.run.id), status: f.store.get(f.run.id).status});
    assert.ok(error instanceof ResourceBusy);
    assert.equal(f.store.locked('worker:' + f.run.id), false);
  } finally {await f.dispose();}
});

test('R9 `resume` refuses a run left in running status by a crash; easy-resume tells agents to use resume', async () => {
  const f = await fixture();
  try {
    const engine = new Engine(f.store, {client: f.client, github: f.github});
    engine.approve(f.run.id, f.run.planHash);
    const run = f.store.get(f.run.id); run.status = 'running'; f.store.save(run, 'audit.simulated.crash');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'resume', f.run.id],
      {cwd: REPO, env: {...process.env, EASY_SKILLS_HOME: f.store.home}, encoding: 'utf8'});
    console.log({exit: result.status, stderr: result.stderr.trim()});
    assert.equal(result.status, 1); assert.match(result.stderr, /Run is not resumable/);
  } finally {await f.dispose();}
});

test('R10 loose error classification turns permanent failures into indefinite quota/network waits', () => {
  const samples = ['Error: context window limit reached', 'FAIL tests/orders.test.ts:429 expected 200', 'Assertion failed: network adapter returned no rows',
    'Prompt is too long'];
  const kinds = Object.fromEntries(samples.map(s => [s, classify(s)]));
  console.log(kinds);
  assert.equal(kinds[samples[0]!], 'quota'); assert.equal(kinds[samples[1]!], 'quota'); assert.equal(kinds[samples[2]!], 'network');
});

test('R11 Codex MCP overrides: empty table is emitted last and server keys are JSON-quoted', () => {
  const root = mkdtempSync(join(tmpdir(), 'es-audit-mcp-')), home = mkdtempSync(join(tmpdir(), 'es-audit-codex-home-'));
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  try {
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex/config.toml'), '[mcp_servers.browser]\ncommand = "node"\nargs = ["server.js"]\n');
    const mcp = assignmentMcp(root, root, 'codex', ['mcp__browser__snapshot']);
    const args = invocation({provider: 'codex', model: 'm'}, undefined, 'read', undefined, {mcpOverrides: mcp.overrides}).args;
    const configs = args.flatMap((a, i) => a === '--config' ? [args[i + 1]!] : []);
    console.log(configs);
    assert.equal(configs.at(-1), 'mcp_servers={}');
    assert.ok(configs.some(c => c.startsWith('mcp_servers."browser".')));
  } finally {process.env.CODEX_HOME = old; rmSync(root, {recursive: true, force: true}); rmSync(home, {recursive: true, force: true});}
});

test('R12 PLAN can introduce VERIFY browser/MCP grants absent from the feature request', async () => {
  const f = await fixture();
  try {
    const {featureId, title, spec, assignments, permissions} = f.run.plan;
    const plan = await generatePlan(f.store, f.root, {featureId, title, spec, assignments, permissions}, {...f.client, async run() {
      return {outcome: 'passed', summary: 'Planned', findings: [], plan: {...f.run.plan, verification: {diagnostics: ['acceptance'], browserTools: ['mcp__github__merge_pull_request']}}};
    }});
    console.log('accepted verification grant:', plan.verification);
    assert.deepEqual(plan.verification?.browserTools, ['mcp__github__merge_pull_request']);
  } finally {await f.dispose();}
});

test('R13 runner secrets in the environment are inherited by check and client children', async () => {
  process.env.EASY_SKILLS_SMTP_PASSWORD = 'audit-fixture-secret';
  try {
    const r = await execute({command: process.execPath, args: ['-e', 'process.stdout.write(String(process.env.EASY_SKILLS_SMTP_PASSWORD))']}, {cwd: tmpdir()});
    console.log('child saw:', r.stdout);
    assert.equal(r.stdout, 'audit-fixture-secret');
  } finally {delete process.env.EASY_SKILLS_SMTP_PASSWORD;}
});
