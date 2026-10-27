import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { CliClient, decode, invocation, classify } from '../../src/adapters/index.js';
const events = JSON.parse(readFileSync(new URL('../fixtures/client-events.json', import.meta.url), 'utf8'));

test('protocol classifies unavailable models, refusals and structured-output exhaustion', () => {
  assert.equal(classify("The 'exact-model' model is not supported when using Codex with a ChatGPT account."), 'model');
  assert.equal(classify('Request refused by provider'), 'refusal');
  assert.equal(classify('error_max_structured_output_retries'), 'protocol');
});

test('intermediate Codex JSON is not a final stage result; corrupt events fail explicitly', () => {
  const result = {outcome: 'passed', summary: 'intermediate', findings: []};
  assert.equal(decode('codex', JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(result)}})).result, undefined);
  assert.match(decode('codex', '{corrupt').error!, /JSON|protocol/i);
  assert.equal(decode('claude-code', JSON.stringify({type: 'result', subtype: 'success', result: JSON.stringify(result)})).result, undefined);
});

for (const provider of ['codex', 'claude-code'] as const) test(`${provider} launch and resume use schema and authoritative final channel`, async () => {
  const commands: string[][] = [];
  const client = new CliClient(async (command, options) => {
    commands.push(command.args);
    const value = {outcome: 'passed', summary: 'authoritative final', findings: [], question: null};
    const key = (provider === 'codex' ? 'codex' : 'claude') + (commands.length === 1 ? 'Launch' : 'Resume');
    for (const event of events[key]) options.onLine?.(JSON.stringify(event));
    if (provider === 'codex') {
      const output = command.args[command.args.indexOf('--output-last-message') + 1]!;
      assert.ok(command.args.includes('--output-schema')); writeFileSync(output, JSON.stringify(value));
    } else {
      assert.ok(command.args.includes('--json-schema'));
    }
    return {code: 0, stdout: '', stderr: '', timedOut: false, truncated: false};
  });
  let session: string | undefined;
  await client.run({provider, model: 'fixture-exact'}, 'fixture', {cwd: '.', mode: 'read', onSession: id => {session = id;}});
  const result = await client.run({provider, model: 'fixture-exact'}, 'delta', {cwd: '.', mode: 'read', session});
  assert.equal(result.summary, 'authoritative final'); assert.ok(commands[1]!.includes('fixture-session'));
});

test('Claude VERIFY enables approved diagnostics and browser tools without edit tools', () => {
  const command = invocation({provider: 'claude-code', model: 'fixture'}, undefined, 'read', undefined,
    {capabilities: {diagnostics: ['node check.mjs'], browserTools: ['mcp__browser__snapshot']}});
  const tools = command.args.slice(command.args.indexOf('--allowedTools') + 1).join(' ');
  assert.match(tools, /Bash\(node check.mjs\)/); assert.match(tools, /mcp__browser__snapshot/); assert.doesNotMatch(tools, /Edit|Write/);
});

test('Codex accepts a completed retried turn while terminal/protocol failures remain fatal', async () => {
  for (const kind of ['transient', 'terminal', 'corrupt'] as const) {
    const client = new CliClient(async (command, options) => {
      options.onLine?.(kind === 'corrupt' ? '{broken' : JSON.stringify({type: kind === 'terminal' ? 'turn.failed' : 'error', error: {code: 'ECONNRESET', message: 'Connection interrupted'}}));
      writeFileSync(command.args[command.args.indexOf('--output-last-message') + 1]!, JSON.stringify({outcome: 'passed', summary: 'Completed authoritative turn', findings: []}));
      options.onLine?.('{"type":"turn.completed"}');
      return {code: 0, stdout: '', stderr: '', timedOut: false, truncated: false};
    });
    const call = client.run({provider: 'codex', model: 'fixture'}, 'fixture', {cwd: '.'});
    if (kind === 'transient') assert.equal((await call).outcome, 'passed');
    else await assert.rejects(call);
  }
  assert.equal(decode('codex', JSON.stringify({type: 'turn.failed', error: {status: 429, message: 'Provider wait'}})).kind, 'quota');
  const args = invocation({provider: 'claude-code', model: 'fixture'}, undefined, 'read', undefined,
    {capabilities: {diagnostics: ['"C:/Program Files (x86)/node.exe" "check \u2603.mjs"'], browserTools: []}}).args;
  assert.ok(args.includes('Bash("C:/Program Files (x86)/node.exe" "check \u2603.mjs")'));
});
