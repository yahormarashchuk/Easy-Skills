import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveChoice } from '../../src/cli/choices.js';
import { TerminalInteraction } from '../../src/cli/interaction.js';

const choices = [{value: 'model-second', label: 'Friendly model'}, {value: 'model-first', label: 'Another model'}];
test('model numbers resolve the displayed order and Enter preserves a listed exact default', () => {
  assert.equal(resolveChoice('1', choices), 'model-second');
  assert.equal(resolveChoice(' 2 ', choices), 'model-first');
  assert.equal(resolveChoice('', choices, 'model-first'), 'model-first');
  assert.equal(resolveChoice('model-second', choices), 'model-second');
  for (const value of ['0', '3', '-1', '1.5', '01', 'Friendly model', '', 'sol 6.1']) assert.throws(() => resolveChoice(value, choices), /Choose a number/);
  assert.throws(() => resolveChoice('', choices, 'missing-model'), /Choose a number/);
});

test('scripted model selection requires exact listed IDs and never silently adopts a changed ordinal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'easy model choice ')), file = join(root, 'answers.json');
  try {
    writeFileSync(file, JSON.stringify({'profile:model': '2'}));
    let ui = new TerminalInteraction({answers: file, nonInteractive: true}); ui.say = () => {};
    await assert.rejects(ui.select('profile:model', 'Choose a model', choices), /exact model ID/); ui.close();
    writeFileSync(file, JSON.stringify({'profile:model': 'model-first'}));
    ui = new TerminalInteraction({answers: file, nonInteractive: true}); ui.say = () => {};
    assert.equal(await ui.select('profile:model', 'Choose a model', choices), 'model-first');
    await assert.rejects(ui.select('missing', 'Choose a model', choices, 'model-second'), /Input required/); ui.close();
    writeFileSync(file, JSON.stringify({'profile:effort': '2'}));
    ui = new TerminalInteraction({answers: file, nonInteractive: true}); ui.say = () => {};
    await assert.rejects(ui.select('profile:effort', 'Choose effort', [{value: 'medium', label: 'Medium'}, {value: 'high', label: 'High'}], 'medium', 'effort'), /exact effort value/); ui.close();
    writeFileSync(file, JSON.stringify({'profile:effort': 'high'}));
    ui = new TerminalInteraction({answers: file, nonInteractive: true}); ui.say = () => {};
    assert.equal(await ui.select('profile:effort', 'Choose effort', [{value: 'medium', label: 'Medium'}, {value: 'high', label: 'High'}], 'medium', 'effort'), 'high'); ui.close();
  } finally {
    if (!root.startsWith(join(tmpdir(), 'easy model choice '))) throw new Error('Invalid choice fixture path');
    rmSync(root, {recursive: true, force: true});
  }
});

test('invalid scripted provider fails clearly without retrying or substituting a provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'easy provider choice ')), file = join(root, 'answers.json');
  try {
    writeFileSync(file, JSON.stringify({'profile:REVIEW:provider': '1'}));
    const ui = new TerminalInteraction({answers: file, nonInteractive: true});
    await assert.rejects(ui.askProvider('profile:REVIEW:provider', 'REVIEW provider', 'codex'), /Scripted answers must use a provider ID/);
    ui.close();
    writeFileSync(file, JSON.stringify({'profile:REVIEW:provider': 'claude-code'}));
    const blocked = new TerminalInteraction({answers: file, nonInteractive: true});
    await assert.rejects(blocked.askProvider('profile:REVIEW:provider', 'REVIEW provider', 'codex', [{provider: 'codex', available: true}, {provider: 'claude-code', available: false, reason: 'Isolation is not verified.'}]), /Claude Code is unavailable/);
    blocked.close();
    writeFileSync(file, JSON.stringify({'profile:REVIEW:provider': 'codex'}));
    const valid = new TerminalInteraction({answers: file, nonInteractive: true});
    assert.equal(await valid.askProvider('profile:REVIEW:provider', 'REVIEW provider', 'codex', [{provider: 'codex', available: true}]), 'codex');
    valid.close();
  } finally {
    if (!root.startsWith(join(tmpdir(), 'easy provider choice '))) throw new Error('Invalid provider fixture path');
    rmSync(root, {recursive: true, force: true});
  }
});

test('provider picker requires an explicit replacement for an unavailable saved provider', async () => {
  const ui = new TerminalInteraction(), messages: string[] = [], prompts: (string | undefined)[] = [];
  const inputs = ['', '2', '1'];
  ui.say = text => {messages.push(text);};
  Object.assign(ui, {input: async (_id: string, _question: string, fallback?: string) => {prompts.push(fallback); return inputs.shift();}});
  const options = [{provider: 'codex' as const, available: true}, {provider: 'claude-code' as const, available: false, reason: 'Isolation is not verified.'}];
  assert.equal(await ui.askProvider('profile:REVIEW:provider', 'REVIEW provider', 'claude-code', options), 'codex');
  assert.deepEqual(prompts, [undefined, undefined, undefined]);
  assert.ok(messages.some(text => text.includes('Choose a provider number')));
  assert.ok(messages.some(text => text.includes('Claude Code is unavailable')));
  assert.equal(inputs.length, 0);
  await assert.rejects(ui.askProvider('x', 'Provider', 'codex', options.map(option => ({...option, available: false}))), /No providers are currently available/);
  ui.close();
});
