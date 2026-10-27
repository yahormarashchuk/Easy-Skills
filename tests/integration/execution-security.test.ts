import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from '../../src/process.js';
import { childEnvironment, trustedExecutable, clientCommand } from '../../src/execution.js';
import { restrictCodex, classify } from '../../src/adapters/index.js';
import { Gh } from '../../src/github/index.js';
import { githubRepository } from '../../src/git/remotes.js';
import { fixture } from '../helpers.js';

test('R1: runner tools ignore a planted cwd launcher and poisoned PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy trusted fixture ')), old = process.env.PATH, previous = process.cwd();
  try {
    writeFileSync(join(dir, 'git.cmd'), '@echo planted'); writeFileSync(join(dir, 'gh.cmd'), '@echo planted');
    process.env.PATH = dir;
    process.chdir(dir);
    const result = await execute({command: 'git', args: ['--version']}, {cwd: dir});
    assert.equal(result.code, 0); assert.match(result.stdout, /^git version /); assert.doesNotMatch(result.stdout, /planted/);
    try {assert.notEqual(trustedExecutable('gh', dir), join(dir, 'gh.cmd'));} catch (error) {assert.match(String(error), /unavailable/);}
  } finally {process.chdir(previous); process.env.PATH = old; rmSync(dir, {recursive: true, force: true});}
});

test('R3: reviewed npm client shims use a verified JavaScript entry point with literal JSON arguments', {skip: process.platform !== 'win32'}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy client install fixture ')), previous = process.env.EASY_SKILLS_HOME;
  try {
    const install = join(dir, 'install'), cwd = join(dir, 'managed'); mkdirSync(install); mkdirSync(cwd);
    const base = join(install, 'node_modules/@anthropic-ai/claude-code'); mkdirSync(base, {recursive: true});
    const shim = join(install, 'claude.cmd'); writeFileSync(shim, '@echo off\r\nexit /b 99');
    writeFileSync(join(base, 'package.json'), '{"name":"@anthropic-ai/claude-code"}');
    writeFileSync(join(base, 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    process.env.EASY_SKILLS_HOME = dir; writeFileSync(join(dir, 'settings.json'), JSON.stringify({execution: {tools: {claude: shim}}}));
    const command = clientCommand('claude-code', cwd), args = ['--json-schema', '{"type":"object"}', 'literal & %PATH% (x86)'];
    assert.equal(command.command, process.execPath);
    const result = await execute({command: command.command, args: [...command.prefix, ...args]}, {cwd, role: 'client'});
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), args);
    writeFileSync(join(base, 'package.json'), '{"name":"unreviewed"}');
    assert.throws(() => clientCommand('claude-code', cwd), /Unsupported client batch shim/);
  } finally {if (previous === undefined) delete process.env.EASY_SKILLS_HOME; else process.env.EASY_SKILLS_HOME = previous; rmSync(dir, {recursive: true, force: true});}
});

test('R13: credential profiles preserve explicit provider grants and exclude SMTP from children', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy environment fixture ')), old = process.env.EASY_SKILLS_HOME;
  try {
    process.env.EASY_SKILLS_HOME = dir;
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({smtp: {passwordEnv: 'MAIL_PASSWORD'}, execution: {environment: {client: ['CUSTOM_PROVIDER_AUTH'], mcp: ['MCP_AUTH']}}}));
    const source = {MAIL_PASSWORD: 'fixture-mail', GH_TOKEN: 'fixture-gh', CUSTOM_PROVIDER_AUTH: 'fixture-client', MCP_AUTH: 'fixture-mcp', NODE_OPTIONS: 'unsafe'};
    assert.equal(childEnvironment('project', source).MAIL_PASSWORD, undefined);
    assert.equal(childEnvironment('project', source).GH_TOKEN, undefined);
    assert.equal(childEnvironment('client', source).CUSTOM_PROVIDER_AUTH, 'fixture-client');
    assert.equal(childEnvironment('github', source).GH_TOKEN, 'fixture-gh');
    assert.equal(childEnvironment('mcp', source).MCP_AUTH, 'fixture-mcp');
    for (const role of ['client', 'project', 'mcp', 'git', 'github'] as const) {
      assert.equal(childEnvironment(role, source).MAIL_PASSWORD, undefined);
      assert.equal(childEnvironment(role, source).NODE_OPTIONS, undefined);
    }
    const result = await execute({command: process.execPath, args: ['-e', 'process.stdout.write(String(process.env.MAIL_PASSWORD))']}, {cwd: dir, env: {MAIL_PASSWORD: 'fixture-mail'}, role: 'project'});
    assert.equal(result.stdout, 'undefined');
  } finally {if (old === undefined) delete process.env.EASY_SKILLS_HOME; else process.env.EASY_SKILLS_HOME = old; rmSync(dir, {recursive: true, force: true});}
});

test('R11: empty grants disable and verify the actual effective server list, with no model command', async () => {
  const calls: string[][] = [];
  const overrides = await restrictCodex({command: 'fixture', prefix: []}, '.', async (command) => {
    calls.push(command.args);
    const output = command.args.includes('features') ? 'hooks stable false\napps stable false\n' : JSON.stringify([{name: 'plugin_server', enabled: !command.args.some(value => value.startsWith('mcp_servers.plugin_server=') && value.includes('enabled=false'))}]);
    return {code: 0, stdout: output, stderr: '', truncated: false, timedOut: false};
  });
  assert.ok(overrides.some(value => value.startsWith('mcp_servers.plugin_server=') && value.includes('enabled=false')));
  assert.equal(calls.length, 3); assert.ok(calls.every(args => !args.includes('exec')));
  await assert.rejects(restrictCodex({command: 'fixture', prefix: []}, '.', async command => ({code: 0,
    stdout: command.args.includes('features') ? 'hooks stable false\napps stable false' : '[{"name":"managed","enabled":true}]', stderr: '', truncated: false, timedOut: false})), /remain enabled/);
});

test('R2/R10: gh exit 4 is authentication; ordinary test text is never provider quota/network evidence', async () => {
  const gh = new Gh('fixture/repo', '.', async () => ({code: 4, stdout: '', stderr: 'please run gh auth login', truncated: false, timedOut: false}));
  await assert.rejects(gh.api('pulls/1'), (error: any) => error.kind === 'auth');
  const limited = new Gh('fixture/repo', '.', async () => ({code: 1, stdout: JSON.stringify({message: 'API rate limit exceeded for fixture'}), stderr: 'HTTP 403', truncated: false, timedOut: false}));
  await assert.rejects(limited.api('pulls/1'), (error: any) => error.kind === 'quota');
  for (const text of ['FAIL tests/orders.test.ts:429', 'Assertion failed: network adapter', 'Error: context window limit reached']) assert.equal(classify(text), 'failure');
  assert.equal(classify('rate_limit_exceeded'), 'quota');
});

test('remote validation checks exact host and every effective fetch/push destination including rewriting', async () => {
  for (const url of ['https://notgithub.com/test/example.git', 'https://github.com.evil.invalid/test/example.git', 'https://user@github.com/test/example.git']) assert.equal(githubRepository(url), undefined);
  for (const url of ['https://github.com/test/example.git', 'git@github.com:test/example.git', 'ssh://git@github.com/test/example.git']) assert.equal(githubRepository(url), 'test/example');
  const f = await fixture();
  try {
    await f.git.validateRemotes();
    await f.git.run(['config', 'remote.origin.pushurl', 'https://notgithub.com/test/example.git']);
    await assert.rejects(f.git.validateRemotes(), /Effective origin/);
    await f.git.run(['config', '--unset', 'remote.origin.pushurl']);
    await f.git.run(['config', 'url.https://evil.invalid/.pushInsteadOf', 'https://github.com/']);
    await assert.rejects(f.git.validateRemotes(), /Effective origin/);
  } finally {await f.dispose();}
});
