import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activePolicyKeys, claudeAccount, inspectClaudePolicy, readRegistry, type PolicySources } from '../../src/adapters/claude-policy.js';
import { CliClient, restrictClaude } from '../../src/adapters/index.js';
import type { ProcessResult } from '../../src/process.js';

const HKLM = 'HKLM\\SOFTWARE\\Policies\\ClaudeCode', HKCU = 'HKCU\\SOFTWARE\\Policies\\ClaudeCode';
async function withPolicy(check: (config: string, sources: (registry?: Record<string, string | Error>) => PolicySources, system: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'easy claude policy ')), config = join(root, 'config'), system = join(root, 'system');
  mkdirSync(config); mkdirSync(system);
  const sources = (registry: Record<string, string | Error> = {}): PolicySources => ({platform: 'win32', directories: [system], async readRegistry(key) {
    const value = registry[key]; if (value instanceof Error) throw value; return value;
  }});
  try {await check(config, sources, system);} finally {rmSync(root, {recursive: true, force: true});}
}

test('Claude policy allows launch only when no managed source configures active hooks, plugins, a policy helper or extra permissions', async () => {
  await withPolicy(async (config, sources, system) => {
    const account = (subscriptionType?: string) => ({loggedIn: true, configDirectory: config, subscriptionType});
    assert.equal(await inspectClaudePolicy(account('max'), sources()), undefined);
    assert.match(await inspectClaudePolicy(account('team'), sources()) || '', /not been synced/);
    writeFileSync(join(config, 'remote-settings.json'), '{}');
    assert.equal(await inspectClaudePolicy(account('team'), sources()), undefined);
    writeFileSync(join(config, 'remote-settings.json'), JSON.stringify({hooks: {SessionStart: [{hooks: [{type: 'command', command: 'fixture'}]}]}}));
    assert.match(await inspectClaudePolicy(account('team'), sources()) || '', /organization settings.*configures hooks/);
    // The organization cache format is client-internal: a wrapped policy must still be found.
    writeFileSync(join(config, 'remote-settings.json'), JSON.stringify({version: 3, settings: {hooks: {Stop: [{hooks: []}]}}}));
    assert.match(await inspectClaudePolicy(account('team'), sources()) || '', /configures hooks/);
    writeFileSync(join(config, 'remote-settings.json'), '{bad');
    assert.match(await inspectClaudePolicy(account(), sources()) || '', /not valid JSON/);
    rmSync(join(config, 'remote-settings.json'));

    assert.equal(await inspectClaudePolicy(account(), sources({[HKLM]: '{"permissions":{"deny":["WebFetch"]},"hooks":{}}'})), undefined);
    assert.match(await inspectClaudePolicy(account(), sources({[HKCU]: '{"enabledPlugins":{"fixture@market":true}}'})) || '', /HKCU.*enabledPlugins/);
    assert.match(await inspectClaudePolicy(account(), sources({[HKLM]: '{"policyHelper":{"command":"fixture"}}'})) || '', /policyHelper/);
    assert.match(await inspectClaudePolicy(account(), sources({[HKLM]: '{"permissions":{"allow":["Bash(*)"]}}'})) || '', /permissions\.allow/);
    assert.match(await inspectClaudePolicy(account(), sources({[HKLM]: new Error('denied')})) || '', /cannot be read/);

    writeFileSync(join(system, 'managed-settings.json'), '{"permissions":{"deny":["WebFetch"]}}');
    assert.equal(await inspectClaudePolicy(account(), sources()), undefined);
    mkdirSync(join(system, 'managed-settings.d'));
    writeFileSync(join(system, 'managed-settings.d', '10-team.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"fixture"}]}]}}');
    assert.match(await inspectClaudePolicy(account(), sources()) || '', /10-team\.json configures hooks/);
    rmSync(join(system, 'managed-settings.d'), {recursive: true});
    writeFileSync(join(system, 'managed-mcp.json'), '{}');
    assert.match(await inspectClaudePolicy(account(), sources()) || '', /Managed MCP servers/);
  });
});

test('inert policy values are not treated as active', () => {
  assert.deepEqual(activePolicyKeys({hooks: {PreToolUse: []}, enabledPlugins: {'a@b': false}, policyHelper: '', permissions: {allow: [], deny: ['x']}}), []);
  assert.deepEqual(activePolicyKeys({hooks: []}), []);
  assert.deepEqual(activePolicyKeys({enabledPlugins: {'a@b': false, 'c@d': true}}), ['enabledPlugins']);
  assert.deepEqual(activePolicyKeys('not an object'), []);
});

test('Windows subsystem for Linux policy files are inspected through every configured directory', async () => {
  await withPolicy(async (config, _sources, system) => {
    const second = join(system, 'windows');
    mkdirSync(second);
    writeFileSync(join(second, 'managed-settings.json'), JSON.stringify({hooks: {Stop: [{hooks: [{type: 'command', command: 'fixture'}]}]}}));
    const sources: PolicySources = {platform: 'linux', directories: [system, second], async readRegistry() {return undefined;}};
    assert.match(await inspectClaudePolicy({loggedIn: true, configDirectory: config}, sources) || '', /windows.*configures hooks/);
  });
});

const result = (code: number, stdout = ''): ProcessResult => ({code, stdout, stderr: '', timedOut: false, truncated: false});
test('registry policy reads distinguish an absent key from one that cannot be read', async () => {
  const listing = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\r\n    (Default)    REG_SZ\r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Other\r\n';
  const value = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n    Settings    REG_SZ    {"hooks": {"Stop": [1]}}\r\n';
  const runner = (answers: Record<string, ProcessResult>) => async (command: {command: string; args: string[]}) => {
    assert.equal(command.command, 'reg'); assert.equal(command.args[0], 'query');
    return answers[command.args[1]!] || result(1);
  };
  assert.equal(await readRegistry(HKLM, runner({'HKLM\\SOFTWARE\\Policies': result(0, listing), [HKLM]: result(0, value)})), '{"hooks": {"Stop": [1]}}');
  assert.equal(await readRegistry(HKLM, runner({'HKLM\\SOFTWARE\\Policies': result(0, listing), [HKLM]: result(0, value.replace('REG_SZ', 'REG_EXPAND_SZ'))})), '{"hooks": {"Stop": [1]}}');
  // Absent key, absent parent, or a key without a Settings value is no policy.
  assert.equal(await readRegistry(HKLM, runner({'HKLM\\SOFTWARE\\Policies': result(0, listing.replace('ClaudeCode', 'Missing'))})), undefined);
  assert.equal(await readRegistry(HKLM, runner({})), undefined);
  assert.equal(await readRegistry(HKLM, runner({'HKLM\\SOFTWARE\\Policies': result(0, listing), [HKLM]: result(0, 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n')})), undefined);
  // The key is listed but cannot be queried, or holds an unsupported value type: never treated as absent.
  await assert.rejects(readRegistry(HKLM, runner({'HKLM\\SOFTWARE\\Policies': result(0, listing), [HKLM]: result(1)})), /Registry query failed/);
  await assert.rejects(readRegistry(HKLM, runner({'HKLM\\SOFTWARE\\Policies': result(0, listing), [HKLM]: result(0, value.replace('REG_SZ', 'REG_MULTI_SZ'))})), /Unsupported/);
});

test('Claude account status counts anything unparsable as signed out', () => {
  assert.equal(claudeAccount(0, '{"loggedIn":true,"subscriptionType":"team","configDirectory":"C:\\\\x"}').loggedIn, true);
  assert.equal(claudeAccount(1, '{"loggedIn":true}').loggedIn, false);
  assert.equal(claudeAccount(0, 'not json').loggedIn, false);
  assert.equal(claudeAccount(0, '{"loggedIn":"yes"}').loggedIn, false);
});

test('Claude launch restriction requires a signed-in account and refuses with policy detail', async () => {
  await withPolicy(async (config, sources) => {
    const status = (value: object) => async () => ({code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false});
    const resolved = {command: 'claude', prefix: []};
    await assert.rejects(restrictClaude(resolved, config, status({loggedIn: false}), sources()), /claude auth login/);
    await restrictClaude(resolved, config, status({loggedIn: true, configDirectory: config, subscriptionType: 'pro'}), sources());
    // A caller that already read the account status does not trigger another client launch.
    await restrictClaude(resolved, config, async () => {throw new Error('unexpected client launch');}, sources(), {loggedIn: true, configDirectory: config, subscriptionType: 'pro'});
    writeFileSync(join(config, 'remote-settings.json'), JSON.stringify({hooks: {Stop: [{hooks: [{type: 'command', command: 'fixture'}]}]}}));
    await assert.rejects(restrictClaude(resolved, config, status({loggedIn: true, configDirectory: config, subscriptionType: 'enterprise'}), sources()),
      /launch refused.*hooks.*No provider fallback/);
  });
});

test('injected clients never inspect or launch a real Claude client', async () => {
  let calls = 0;
  const client = new CliClient(async () => {calls++; throw new Error('Unexpected process');});
  await assert.rejects(client.run({provider: 'claude-code', model: 'claude-exact-a'}, 'prompt', {cwd: '.', mode: 'read'}), /Unexpected process/);
  assert.equal(calls, 1);
});
