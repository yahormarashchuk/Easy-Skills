import which from 'which';
import { protectedManifest } from '../src/runner/protected-inputs.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Plan, VERSION, type PullRequest } from '../src/contracts.js';
import { Store } from '../src/persistence/store.js';
import { Engine } from '../src/runner/engine.js';
import { Git } from '../src/git/index.js';
import { checked } from '../src/process.js';
import { rulesHash } from '../src/util.js';
import type { GitHub, MergeResult } from '../src/github/index.js';
import type { Client } from '../src/adapters/index.js';
import { stringify } from 'yaml';
import { agreementProposal, applyAgreement, draftInterview, requireAgreement } from '../src/runner/onboarding.js';

export async function fixture(stack = 'node', options: {setup?: import('../src/contracts.js').Check[]; checkSource?: string} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'easy skills test ')), root = join(dir, 'project with spaces'), remote = join(dir, 'remote.git');
  mkdirSync(root); mkdirSync(remote);
  const git = new Git(root, undefined, {repository: 'test/example', testRemote: remote});
  await checked('git', ['init', '--bare', '--initial-branch=trunk', remote], dir);
  await git.run(['init', '--initial-branch=trunk']);
  for (const path of [root, remote]) {
    await checked('git', ['config', 'user.name', 'Easy Skills Test'], path);
    await checked('git', ['config', 'user.email', 'test@example.invalid'], path);
  }
  writeFileSync(join(root, 'AGENTS.md'), 'Use focused tests.\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n__pycache__/\n');
  writeFileSync(join(root, stack === 'node' ? 'package.json' : 'pyproject.toml'), stack === 'node' ? '{"name":"example","private":true}' : '[project]\nname="example"\nversion="0.1.0"\n');
  writeFileSync(join(root, 'check.mjs'), options.checkSource || 'import fs from "node:fs"; if (fs.existsSync("broken")) process.exit(1);\n');
  if (stack === 'python') writeFileSync(join(root, 'check.py'), 'from pathlib import Path\nassert not Path("broken").exists()\n');
  await git.run(['add', '.']); await git.run(['commit', '-m', 'initial']);
  await git.run(['remote', 'add', 'origin', 'https://github.com/test/example.git']);
  await git.run(['config', `url.${remote.replaceAll('\\', '/')}.insteadOf`, 'https://github.com/test/example.git']);
  await git.run(['push', '-u', 'origin', 'trunk']);
  const store = new Store(join(dir, 'private state'));
  const assignments = Object.fromEntries(['DEFINE', 'PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SHIP'].map(stage => [stage, {provider: stage === 'REVIEW' ? 'claude-code' : 'codex', model: 'exact-' + stage}]));
  const plan = Plan.parse({schemaVersion: 2, repairPolicy: {maxCompletedAttempts: 3}, protectedInputs: {}, featureId: 'sample', title: 'Sample feature', spec: 'Deliver two independent, tested behaviors.',
    project: {schemaVersion: 2, name: 'Example', repository: 'test/example', mainBranch: 'trunk', githubTransport: 'gh', mergePolicy: {mode: 'strict', requiredChecks: [{name: 'fixture-ci'}]},
      setup: options.setup || [], checks: [{id: 'acceptance', command: stack === 'python' ? which.sync(process.platform === 'win32' ? 'python' : 'python3') : process.execPath,
        args: [stack === 'python' ? 'check.py' : 'check.mjs']}]}, assignments,
    tasks: [{id: 'one', title: 'First', description: 'First behavior', acceptance: ['First behavior works']},
      {id: 'two', title: 'Second', description: 'Second behavior', dependsOn: ['one'], acceptance: ['Both behaviors work']}],
    rulesHash: rulesHash(root), runnerVersion: VERSION, skillsVersion: VERSION,
    permissions: {publishIssues: true, mergeIntermediate: true}});
  mkdirSync(join(root, '.easy-skills'), {recursive: true});
  writeFileSync(join(root, '.easy-skills/project.yaml'), stringify(plan.project));
  const interview = {...draftInterview(), status: 'agreed', decisions: draftInterview().decisions.map(d => ({...d, status: 'resolved', answer: 'Reviewed fixture constraint'}))};
  applyAgreement(root, interview, agreementProposal(root, interview).hash);
  plan.rulesAgreement = requireAgreement(root);
  await git.run(['add', '.']); await git.run(['commit', '-m', 'Agree fixture rules']); await git.push('trunk', root);
  plan.protectedInputs = protectedManifest(root, plan.project);
  const identity = await git.identity(), run = store.create(identity.root, identity.commonDir, plan);
  for (const a of Object.values(plan.assignments)) store.recordProbe(a, 'fixture-1', '/fixture/client');
  const github = new FakeGitHub(remote);
  const calls: string[] = [];
  const client: Client = {async diagnose() {return {installed: true, authenticated: true, version: 'fixture-1', executable: '/fixture/client'};}, async run(assignment, prompt, options) {
    calls.push(assignment.model + ':' + options.cwd.split(/[\\/]/).pop());
    options.onSession?.(options.session || 'session-' + calls.length);
    if (assignment.model === 'exact-BUILD') writeFileSync(join(options.cwd, options.cwd.endsWith('one') ? 'one.txt' : 'two.txt'), 'tested behavior\n');
    return {outcome: 'passed', summary: 'Verified fixture result', findings: []};
  }};
  const engine = new Engine(store, {client, github, testRemote: remote});
  return {dir, root, remote, git, store, run, engine, github, client, calls,
    async dispose() {
      store.close();
      // Generated test fixture only; verify the resolved target has the fixed temp prefix.
      if (!dir.startsWith(join(tmpdir(), 'easy skills test '))) throw new Error('Invalid fixture cleanup path');
      rmSync(dir, {recursive: true, force: true});
    }};
}
export class FakeGitHub implements GitHub {
  objects = new Map<string, number>(); prs = new Map<number, PullRequest>(); issues = new Map<number, boolean>();
  issueComments: {id: number; author: string; body: string}[] = [];
  commentsWritten: string[] = []; merges: number[] = []; next = 1;
  constructor(readonly remote: string) {}
  async issue(key: string) {
    if (!this.objects.has(key)) {this.objects.set(key, this.next++); this.issues.set(this.objects.get(key)!, true);}
    return this.objects.get(key)!;
  }
  async pr(key: string, title: string, body: string, head: string, base: string) {
    const headOid = await checked('git', ['rev-parse', `refs/heads/${head}`], this.remote);
    if (!this.objects.has(key)) this.objects.set(key, this.next++);
    const number = this.objects.get(key)!;
    const pr = this.prs.get(number) || {number, url: `https://github.com/test/example/pull/${number}`, headRefOid: headOid,
      state: 'OPEN', mergedAt: null, baseRefName: base, headRefName: head};
    pr.headRefOid = headOid; this.prs.set(number, pr); return {...pr};
  }
  async viewPr(number: number) {
    const pr = this.prs.get(number)!;
    if (pr.state !== 'MERGED') pr.headRefOid = await checked('git', ['rev-parse', `refs/heads/${pr.headRefName}`], this.remote);
    return {...pr};
  }
  async merge(number: number, head: string): Promise<MergeResult> {
    const pr = await this.viewPr(number);
    if (pr.headRefOid !== head) throw new Error('head mismatch');
    const base = await checked('git', ['rev-parse', `refs/heads/${pr.baseRefName}`], this.remote);
    const tree = (await checked('git', ['merge-tree', '--write-tree', base, head], this.remote)).split(/\r?\n/)[0]!;
    const commit = await checked('git', ['commit-tree', tree, '-p', base, '-p', head, '-m', 'Merge fixture PR'], this.remote);
    await checked('git', ['update-ref', `refs/heads/${pr.baseRefName}`, commit], this.remote);
    Object.assign(this.prs.get(number)!, {state: 'MERGED', mergedAt: new Date().toISOString()}); this.merges.push(number);
    return {state: 'merged' as const};
  }
  async setIssue(number: number, open: boolean, comment: string) {this.issues.set(number, open); this.commentsWritten.push(comment);}
  async comments() {return this.issueComments;}
  async commentOnce(number: number, key: string, body: string) {this.commentsWritten.push(body);}
}
