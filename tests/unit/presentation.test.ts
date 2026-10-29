import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interviewQuestion, stageBanner, stepTracker, useColor, useUnicode } from '../../src/cli/presentation.js';

test('stage headings identify setup position and runtime stage without relying on color', () => {
  assert.match(stageBanner('BUILD', 'model'), /\[3\/6\] MODEL SETUP: BUILD/);
  assert.match(stageBanner('VERIFY', 'model'), /\[4\/6\] MODEL SETUP: VERIFY/);
  assert.match(stageBanner('REVIEW', 'current'), /CURRENT STAGE: REVIEW/);
  assert.match(stageBanner('REPAIR', 'current'), /Address the reported problem/);
  assert.doesNotMatch(stageBanner('BUILD', 'model'), /\u001b\[/);
  assert.match(stageBanner('BUILD', 'model', true), /\u001b\[1;32m/);
  assert.equal(useColor(true, {}), true);
  assert.equal(useColor(false, {}), false);
  assert.equal(useColor(true, {NO_COLOR: '1'}), false);
  assert.equal(useColor(true, {TERM: 'dumb'}), false);
});

test('the step tracker marks finished, current and upcoming stages with an ASCII fallback', () => {
  assert.equal(stepTracker('VERIFY'), '[x] DEFINE - [x] PLAN - [x] BUILD - [>] VERIFY - [ ] REVIEW - [ ] SHIP');
  assert.equal(stepTracker('REPAIR'), '[x] DEFINE - [x] PLAN - [>] BUILD - [ ] VERIFY - [ ] REVIEW - [ ] SHIP');
  assert.equal(stepTracker('DEFINE', false, true), '● DEFINE ── ○ PLAN ── ○ BUILD ── ○ VERIFY ── ○ REVIEW ── ○ SHIP');
  assert.match(stageBanner('PLAN', 'current'), /\n  \[x\] DEFINE - \[>\] PLAN/);
  assert.doesNotMatch(stageBanner('PLAN', 'model'), /\[>\]/);
  assert.equal(useUnicode('win32', {}), false);
  assert.equal(useUnicode('win32', {WT_SESSION: '1'}), true);
  assert.equal(useUnicode('linux', {TERM: 'xterm-256color'}), true);
});

test('interview questions have a clear header, readable wrapping and an uncolored fallback', () => {
  const question = 'Should a production dependency require separate approval before it is added to the project?';
  const plain = interviewQuestion(question, 2, 52);
  const lines = plain.split('\n');
  assert.equal(lines[0], '---------- QUESTION 2 ----------');
  assert.equal(lines.slice(1, -1).join(' '), question);
  assert.ok(lines.slice(1, -1).every(line => line.length <= 50));
  assert.doesNotMatch(plain, /\u001b\[/);
  assert.match(interviewQuestion('A\nB', 1, 80, true), /\u001b\[1;36m.*QUESTION 1.*\u001b\[0m\nA\nB/);
});
