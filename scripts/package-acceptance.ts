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
  const engine = new compiled.Engine(store, {client: f.client, github: f.github});
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
  console.log(JSON.stringify({compiledFeature: 'merged', packagedSkills: true, compiledProtocol: true, realExternalActions: false}));
} finally {store.close(); await f.dispose();}
