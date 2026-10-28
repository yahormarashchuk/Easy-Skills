import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectClaudePolicy, type PolicySources } from '../../src/adapters/claude-policy.js';
import { restrictClaude } from '../../src/adapters/index.js';

const HKLM = 'HKLM\\SOFTWARE\\Policies\\ClaudeCode', HKCU = 'HKCU\\SOFTWARE\\Policies\\ClaudeCode';
async function withPolicy(check: (config: string, sources: (registry?: Record<string, string | Error>) => PolicySources, system: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'easy claude policy ')), config = join(root, 'config'), system = join(root, 'system');
  mkdirSync(config); mkdirSync(system);
  const sources = (registry: Record<string, string | Error> = {}): PolicySources => ({platform: 'win32', directory: system, async readRegistry(key) {
    const value = registry[key]; if (value instanceof Error) throw value; return value;
  }});
  try {await check(config, sources, system);} finally {rmSync(root, {recursive: true, force: true});}
}

test('Claude policy allows launch only when no managed source configures hooks, plugins or a policy helper', async () => {
  await withPolicy(async (config, sources, system) => {
    const account = (subscriptionType?: string) => ({loggedIn: true, configDirectory: config, subscriptionType});
    assert.equal(await inspectClaudePolicy(account('max'), sources()), undefined);
    assert.match(await inspectClaudePolicy(account('team'), sources()) || '', /not been synced/);
    writeFileSync(join(config, 'remote-settings.json'), '{}');
    assert.equal(await inspectClaudePolicy(account('team'), sources()), undefined);
    writeFileSync(join(config, 'remote-settings.json'), JSON.stringify({hooks: {SessionStart: [{hooks: [{type: 'command', command: 'fixture'}]}]}}));
    assert.match(await inspectClaudePolicy(account('team'), sources()) || '', /organization settings.*configures hooks/);
    writeFileSync(join(config, 'remote-settings.json'), '{bad');
    assert.match(await inspectClaudePolicy(account(), sources()) || '', /not valid JSON/);
    rmSync(join(config, 'remote-settings.json'));

    assert.equal(await inspectClaudePolicy(account(), sources({[HKLM]: '{"permissions":{"deny":["WebFetch"]},"hooks":{}}'})), undefined);
    assert.match(await inspectClaudePolicy(account(), sources({[HKCU]: '{"enabledPlugins":{"fixture@market":true}}'})) || '', /HKCU.*enabledPlugins/);
    assert.match(await inspectClaudePolicy(account(), sources({[HKLM]: '{"policyHelper":{"command":"fixture"}}'})) || '', /policyHelper/);
    assert.match(await inspectClaudePolicy(account(), sources({[HKLM]: new Error('denied')})) || '', /cannot be read/);

    writeFileSync(join(system, 'managed-settings.json'), '{"permissions":{"deny":["WebFetch"]}}');
    assert.equal(await inspectClaudePolicy(account(), sources()), undefined);
    mkdirSync(join(system, 'managed-settings.d'));
    writeFileSync(join(system, 'managed-settings.d', '10-team.json'), '{"hooks":{"PreToolUse":[]}}');
    assert.match(await inspectClaudePolicy(account(), sources()) || '', /10-team\.json configures hooks/);
    rmSync(join(system, 'managed-settings.d'), {recursive: true});
    writeFileSync(join(system, 'managed-mcp.json'), '{}');
    assert.match(await inspectClaudePolicy(account(), sources()) || '', /Managed MCP servers/);
  });
});

test('Claude launch restriction requires a signed-in account and refuses with policy detail', async () => {
  await withPolicy(async (config, sources) => {
    const status = (value: object) => async () => ({code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false});
    const resolved = {command: 'claude', prefix: []};
    await assert.rejects(restrictClaude(resolved, config, status({loggedIn: false}), sources()), /claude auth login/);
    await restrictClaude(resolved, config, status({loggedIn: true, configDirectory: config, subscriptionType: 'pro'}), sources());
    writeFileSync(join(config, 'remote-settings.json'), JSON.stringify({hooks: {Stop: []}}));
    await assert.rejects(restrictClaude(resolved, config, status({loggedIn: true, configDirectory: config, subscriptionType: 'enterprise'}), sources()),
      /launch refused.*hooks.*No provider fallback/);
  });
});
