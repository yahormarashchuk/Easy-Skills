import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { PastedAnswer, pasteQuietMs } from '../../src/cli/paste.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('lines of one paste are a single answer and the next answer starts clean', async () => {
  const source = new EventEmitter(), reader = new PastedAnswer(source, undefined, 40);
  const first = reader.next();
  for (const line of ['ANSWER TO QUESTION 1', '', '- reception-led check-in', '- staff available']) source.emit('line', line);
  assert.equal(await first, 'ANSWER TO QUESTION 1\n\n- reception-led check-in\n- staff available');
  const second = reader.next();
  source.emit('line', 'one typed line');
  assert.equal(await second, 'one typed line');
});

test('a typed answer is returned once the input is quiet', async () => {
  const source = new EventEmitter(), reader = new PastedAnswer(source, undefined, 30);
  const started = Date.now(), answer = reader.next();
  source.emit('line', 'yes');
  assert.equal(await answer, 'yes');
  assert.ok(Date.now() - started < 1000);
});

test('input received in the middle of a line keeps the answer open', async () => {
  const source = new EventEmitter(), activity = new EventEmitter(), reader = new PastedAnswer(source, activity, 60);
  const answer = reader.next();
  source.emit('line', 'first line');
  await pause(40); activity.emit('data', Buffer.from('partial'));
  await pause(40); activity.emit('data', Buffer.from(' line'));
  await pause(30); source.emit('line', 'partial line');
  assert.equal(await answer, 'first line\npartial line');
});

test('lines that arrive while no answer is awaited are not carried into the next question', async () => {
  const source = new EventEmitter(), reader = new PastedAnswer(source, undefined, 20);
  source.emit('line', 'stray');
  const answer = reader.next();
  source.emit('line', 'real');
  assert.equal(await answer, 'real');
});

test('closed input rejects an unanswered question and keeps a partial paste', async () => {
  const source = new EventEmitter(), reader = new PastedAnswer(source, undefined, 500);
  const empty = reader.next();
  source.emit('close');
  await assert.rejects(empty, /Input was closed/);
  const partial = reader.next();
  source.emit('line', 'half');
  source.emit('close');
  assert.equal(await partial, 'half');
});

test('a real readline interface keeps a multi-chunk paste as one answer across consecutive questions', async () => {
  const input = new PassThrough(), terminal = createInterface({input, output: new PassThrough()});
  const reader = new PastedAnswer(terminal, input, 80);
  const first = reader.next();
  input.write('Pilot studio\nOne studio that has its own ');
  await pause(20);
  input.write('legacy database\n- Legacy studio ID: s_id\n\n- Governing timezone: Europe/Berlin\n');
  assert.equal(await first, 'Pilot studio\nOne studio that has its own legacy database\n- Legacy studio ID: s_id\n\n- Governing timezone: Europe/Berlin');
  const second = reader.next();
  input.write('short answer\n');
  assert.equal(await second, 'short answer');
  terminal.close();
});

test('EASY_SKILLS_PASTE_MS overrides the quiet period and invalid values fall back', () => {
  assert.equal(pasteQuietMs({EASY_SKILLS_PASTE_MS: '10'}), 10);
  assert.equal(pasteQuietMs({EASY_SKILLS_PASTE_MS: 'x'}), 250);
  assert.equal(pasteQuietMs({EASY_SKILLS_PASTE_MS: '-5'}), 250);
  assert.equal(pasteQuietMs({}), 250);
});
