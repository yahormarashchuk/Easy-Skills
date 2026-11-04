import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { Git } from '../../src/git/index.js';

test('a file that is only briefly left behind does not stop the run, and one that stays is named', async () => {
  const f = await fixture();
  try {
    const git = new Git(f.root);
    await git.clean(f.root, false, 20);
    const stray = join(f.root, 'stray-build-output.tmp');
    writeFileSync(stray, 'left by a stopped build server');
    setTimeout(() => rmSync(stray, {force: true}), 60);
    await git.clean(f.root, false, 400);
    writeFileSync(stray, 'still here');
    await assert.rejects(git.clean(f.root, false, 40), /Worktree contains uncommitted, untracked or ignored files: .* \(stray-build-output\.tmp\)/);
    for (let i = 0; i < 7; i++) writeFileSync(join(f.root, `extra-${i}.tmp`), 'x');
    await assert.rejects(git.clean(f.root, false, 20), /extra-0\.tmp.*and 3 more/);
  } finally {await f.dispose();}
});
