import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope } from '../../src/util.js';

test('scope paths accept files, directories and globs but nothing outside them', () => {
  assert.equal(inScope('docs/checkin/legacy-restore.md', ['docs/checkin/**']), true);
  assert.equal(inScope('docs/checkin/nested/deep/file.md', ['docs/checkin/**']), true);
  assert.equal(inScope('docs/checkin/legacy-restore.md', ['docs/checkin/']), true);
  assert.equal(inScope('docs/checkin/legacy-restore.md', ['docs/checkin']), true);
  assert.equal(inScope('docs/specs/checkin-access.md', ['docs/specs/checkin-access.md']), true);
  assert.equal(inScope('anything/at/all.txt', ['.']), true);
  assert.equal(inScope('src/Domain/CheckIn/Rule.cs', ['src/*/CheckIn/**']), true);
  assert.equal(inScope('src/Domain/CheckIn/Rule.cs', ['src/*/CheckIn']), true);
  assert.equal(inScope('src/App/Pages/CheckIn/Page.razor', ['src/*/CheckIn/**']), false);
  assert.equal(inScope('test/checkin-tools/run.ps1', ['test/**/run.ps1']), true);
  assert.equal(inScope('test/run.ps1', ['test/**/run.ps1']), true);
  assert.equal(inScope('docs/checkinx/file.md', ['docs/checkin/**']), false);
  assert.equal(inScope('docs/checkin', ['docs/checkin/**']), false);
  assert.equal(inScope('docs/other/file.md', ['docs/checkin/**']), false);
  assert.equal(inScope('docs/checkin-other/file.md', ['docs/checkin']), false);
  assert.equal(inScope('src/file.cs', ['src/file.c?']), true);
  assert.equal(inScope('src/dir/file.cs', ['src/*.cs']), false);
  assert.equal(inScope('src/a+b/file.cs', ['src/a+b/**']), true);
  assert.equal(inScope('src/aab/file.cs', ['src/a+b/**']), false);
});
