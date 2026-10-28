import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describeActivity } from '../../src/adapters/activity.js';
import { ActivityView, elapsed } from '../../src/cli/activity.js';

const root = join(process.cwd(), 'project');

test('Claude events describe tool use with project-relative paths and the latest thought', () => {
  const tool = (name: string, input: object) => JSON.stringify({type: 'assistant', message: {content: [{type: 'tool_use', name, input}]}});
  assert.equal(describeActivity('claude-code', tool('Read', {file_path: join(root, 'src', 'a.ts')}), root), 'Reading src/a.ts');
  assert.equal(describeActivity('claude-code', tool('Grep', {pattern: 'showStage', path: join(root, 'src')}), root), 'Searching for "showStage" in src');
  assert.equal(describeActivity('claude-code', tool('Glob', {pattern: '**/*.md'}), root), 'Finding files **/*.md');
  assert.equal(describeActivity('claude-code', JSON.stringify({type: 'assistant', message: {content: [{type: 'thinking', thinking: '\n**Checking tests**\nmore'}]}})), 'Thinking: Checking tests');
  assert.equal(describeActivity('claude-code', JSON.stringify({type: 'system', subtype: 'init', session_id: 's'})), 'Session started');
  assert.equal(describeActivity('claude-code', JSON.stringify({type: 'result', subtype: 'success'})), undefined);
});

test('Codex events describe reasoning, unwrapped shell commands and file changes', () => {
  const item = (type: string, value: object, event = 'item.completed') => JSON.stringify({type: event, item: {id: 'i', type, ...value}});
  assert.equal(describeActivity('codex', JSON.stringify({type: 'turn.started'})), 'Thinking');
  assert.equal(describeActivity('codex', item('reasoning', {text: '**Exploring repository structure**\n\nDetails'})), 'Thinking: Exploring repository structure');
  assert.equal(describeActivity('codex', item('command_execution', {command: "bash -lc 'rg -n Stage src'"}, 'item.started')), 'Running rg -n Stage src');
  assert.equal(describeActivity('codex', item('command_execution', {command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem src"'}, 'item.started')), 'Running Get-ChildItem src');
  assert.equal(describeActivity('codex', item('command_execution', {command: 'ls', exit_code: 0})), undefined);
  assert.equal(describeActivity('codex', item('file_change', {changes: [{path: join(root, 'a.ts'), kind: 'update'}]}), root), 'Editing a.ts');
  assert.equal(describeActivity('codex', '{broken'), undefined);
});

test('model text cannot inject terminal control sequences into the live view', () => {
  const line = JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: 'Done\u001b[2J\u001b]0;title\u0007 here\u202e'}]}});
  const text = describeActivity('claude-code', line)!;
  assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\u202e]/);
  assert.match(text, /^Done/);
});

test('the live view redraws in place, keeps lines inside the terminal width and collapses when done', () => {
  let output = '';
  const view = new ActivityView({write: text => {output += text;}, columns: 60}, 'DEFINE', {provider: 'codex', model: 'fixture-model', effort: 'high'}, {color: false, unicode: false, tone: 36});
  for (let i = 0; i < 6; i++) view.update('Reading src/file-' + i + '.ts with a very long description that must be cut');
  view.update('Reading src/file-5.ts with a very long description that must be cut');
  (view as unknown as {render(): void}).render();
  const frame = output.slice(output.lastIndexOf('\r') + 1).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const lines = frame.split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /^[|/\\-] DEFINE . codex fixture-model \(high\)/);
  assert.match(lines[4]!, /file-5/);
  assert.ok(lines.every(line => line.length <= 59));
  view.done(true);
  // Collapsing must climb back over the whole five-line block before drawing the summary.
  assert.ok(output.includes('\u001b[4A'));
  assert.match(output, /\[x\] DEFINE finished in \d+s . 6 steps\u001b\[J\n\n$/);
  view.update('ignored after done');
  assert.match(output, /6 steps\u001b\[J\n\n$/);
  assert.equal(elapsed(125_000), '2m 05s');
});
