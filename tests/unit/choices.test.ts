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
    await assert.rejects(ui.askProvider('profile:REVIEW:provider', 'REVIEW provider', 'codex'), /Invalid provider.*codex or claude-code/);
    ui.close();
  } finally {
    if (!root.startsWith(join(tmpdir(), 'easy provider choice '))) throw new Error('Invalid provider fixture path');
    rmSync(root, {recursive: true, force: true});
  }
});
