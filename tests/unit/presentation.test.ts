import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageBanner, useColor } from '../../src/cli/presentation.js';

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
