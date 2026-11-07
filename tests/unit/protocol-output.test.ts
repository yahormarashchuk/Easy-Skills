import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput } from '../../src/adapters/protocol.js';

const base = {outcome: 'passed', summary: 'Delivered.', findings: ['ok']};
test('an empty question or plan means nothing to ask and no plan', () => {
  for (const question of [null, '', '   ']) {
    const result = parseOutput({...base, question, planJson: ''});
    assert.equal(result.question, undefined);
    assert.equal(result.plan, undefined);
  }
});
test('a real question is kept and a missing summary still fails', () => {
  assert.equal(parseOutput({...base, outcome: 'blocked', question: 'Which branch?'}).question, 'Which branch?');
  assert.throws(() => parseOutput({...base, summary: ''}));
});
