import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from '../tests/helpers.js';
import { execute } from '../src/process.js';

// Uses the installed compiled runtime with local doubles; never starts real AI clients.
const packageRoot = resolve(process.argv[2] || '');
assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name, 'easy-skills');
const compiled = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
const f = await fixture();
const store = new compiled.Store(f.store.home);
try {
  const engine = new compiled.Engine(store, {client: f.client, github: f.github, testRemote: f.remote});
  engine.approve(f.run.id, f.run.planHash);
  const ready = await engine.run(f.run.id);
  assert.equal(ready.status, 'ready', ready.reason || '');
  const workerKey = 'worker:' + f.run.id, workerOwner = store.acquire(workerKey);
  try {
    const resumed = await execute({command: process.execPath, args: [join(packageRoot, 'dist/cli/index.js'), 'resume', f.run.id]},
      {cwd: f.root, env: {...process.env, EASY_SKILLS_HOME: store.home}});
    assert.equal(resumed.code, 0, resumed.stderr); assert.equal(JSON.parse(resumed.stdout).attached, true);
    assert.equal(store.operation(`${f.run.id}:resume-request`), undefined);
  } finally {store.release(workerKey, workerOwner);}
  assert.equal((await engine.confirmFinalMerge(f.run.id, ready.finalReviewHead)).status, 'merged');
  const cli = join(packageRoot, 'dist/cli/index.js');
  const help = await execute({command: process.execPath, args: [cli, '--help']}, {cwd: f.root});
  assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /bootstrap/); assert.match(help.stdout, /agree-rules/);
  const target = join(f.dir, 'installed skills');
  const preview = await execute({command: process.execPath, args: [cli, 'install-skills', '--client', 'codex', '--target', target]}, {cwd: f.root});
  assert.equal(preview.code, 0, preview.stderr);
  const proposal = JSON.parse(preview.stdout);
  const applied = await execute({command: process.execPath, args: [cli, 'install-skills', '--client', 'codex', '--target', target, '--apply-hash', proposal.hash]}, {cwd: f.root});
  assert.equal(applied.code, 0, applied.stderr);
  assert.ok(existsSync(join(target, 'easy-init/references/interview.md')));
  assert.equal(JSON.parse(readFileSync(join(target, 'easy-feature/references/interview-evals.json'), 'utf8')).cases.length, 6);
  assert.ok(existsSync(join(target, 'easy-plan/references/plan.schema.json')));
  const client = new compiled.CliClient(async (command: {args: string[]}, options: {onLine?: (line: string) => void}) => {
    options.onLine?.('{"type":"thread.started","thread_id":"package-fixture-session"}');
    writeFileSync(command.args[command.args.indexOf('--output-last-message') + 1]!, JSON.stringify({outcome: 'passed', summary: 'compiled fixture', findings: [], question: null}));
    options.onLine?.('{"type":"turn.completed"}');
    return {code: 0, stdout: '', stderr: '', timedOut: false, truncated: false};
  });
  assert.equal((await client.run({provider: 'codex', model: 'fixture-exact'}, 'fixture', {cwd: f.root, mode: 'read'})).outcome, 'passed');
  const ui = {say(_text: string) {}, async ask() {return 'Preserve compatibility';}, async confirm() {return true;}};
  const profile = {name: 'Package fixture', assignments: f.run.plan.assignments};
  const github = Object.assign(f.github, {async readIssue(number: number) {
    return {number, title: 'Package task', body: 'Deliver a focused behavior.', url: 'https://github.com/test/example/issues/' + number, labels: [], state: 'open'};
  }});
  const guidedClient = {...f.client, async run(a: any, prompt: string, options: any) {
    if (options.stage === 'DEFINE') return {outcome: 'passed', findings: [], summary: JSON.stringify({summary: 'Focused package task', questions: [], specification: 'Deliver the package task. ' + (prompt.includes('Developer feedback:') ? 'Apply feedback.' : ''), acceptance: ['Behavior is verified'], outOfScope: ['Other work']})};
    if (options.stage === 'PLAN') {
      const seed = JSON.parse(prompt.split('small sequentially executable slices:\n')[1]!.split('\n')[0]!);
      seed.tasks = [{id: 'package', title: 'Package task', description: seed.spec, acceptance: ['Behavior is verified'], dependsOn: [], scope: {areas: [], paths: ['direct.txt']}}];
      return {outcome: 'passed', summary: 'Planned', findings: [], plan: compiled.Plan.parse(seed)};
    }
    if (options.stage === 'BUILD') writeFileSync(join(options.cwd, 'direct.txt'), prompt.includes('Apply feedback.') ? 'updated\n' : 'initial\n');
    return f.client.run(a, prompt, options);
  }};
  const wizard = new compiled.Guided(store, ui, {client: guidedClient, github, testRemote: f.remote});
  await wizard.profile(f.root, true, profile); await wizard.onboard(f.root, profile);
  const plan = await wizard.proposal(f.root, '909', profile), direct = await wizard.approve(f.root, plan);
  const directEngine = new compiled.Engine(store, {client: guidedClient, github, testRemote: f.remote});
  const directReady = await directEngine.run(direct.id);
  assert.equal(directReady.status, 'ready', directReady.reason || '');
  assert.equal(directReady.parentIssue, 909); assert.equal(directReady.tasks[0].worktree, undefined);
  const revised = await wizard.proposal(f.root, 'Apply feedback.', profile, directReady);
  const revisedRun = await wizard.approve(f.root, revised, directReady);
  const updated = await directEngine.run(revisedRun.id);
  assert.equal(updated.status, 'ready', updated.reason || ''); assert.equal(updated.finalPr.number, directReady.finalPr.number);
  const answers = join(f.dir, 'installation consent.json'); writeFileSync(answers, JSON.stringify({'install:approve': true}));
  const interactiveTarget = join(f.dir, 'interactive packaged skills');
  const interactive = await execute({command: process.execPath, args: [cli, 'install-skills', '--client', 'codex', '--target', interactiveTarget, '--interactive', '--non-interactive', '--answers', answers]}, {cwd: f.root});
  assert.equal(interactive.code, 0, interactive.stderr); assert.ok(existsSync(join(interactiveTarget, 'easy-init/SKILL.md')));
  for (const command of ['init', 'run', 'revise', 'config', 'rules']) {
    const result = await execute({command: process.execPath, args: [cli, command, '--help']}, {cwd: f.root});
    assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /--non-interactive/);
  }
  const readable = await execute({command: process.execPath, args: [cli, 'status', '909']}, {cwd: f.root, env: {EASY_SKILLS_HOME: store.home}});
  assert.equal(readable.code, 0, readable.stderr); assert.match(readable.stdout, /Task #909: ready/);
  const picker = new compiled.Guided(store, {say(_text: string) {}, async ask(id: string, _question: string, fallback?: string) {
    return id === 'profile:select' ? 'Numbered package profile' : id === 'profile:model' ? '2' : fallback || 'codex';
  }, async confirm(id: string) {return id !== 'profile:customize';}}, {client: {...f.client, async listModels() {
    return [{model: 'package-model-one', displayName: 'First package model', isDefault: true}, {model: 'package-model-two', displayName: 'Second package model', isDefault: false}];
  }}});
  const selected = await picker.profile(f.root, true);
  assert.equal(selected.assignments.BUILD.model, 'package-model-two'); assert.equal(selected.assignments.REVIEW.model, 'package-model-two');
  console.log(JSON.stringify({compiledFeature: 'merged', compiledDirectTask: 'ready', samePrFeedback: true, numberedModelSelection: true, packagedSkills: true, compiledProtocol: true, realExternalActions: false}));
} finally {store.close(); await f.dispose();}
