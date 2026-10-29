import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checked, execute } from '../../src/process.js';
import { Git } from '../../src/git/index.js';

const longPaths = async (root: string) => (await execute({command: 'git', args: ['config', '--local', '--get', 'core.longpaths']}, {cwd: root})).stdout.trim();

test('Windows task worktrees enable core.longpaths in the repository once; other platforms are untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'easy long paths '));
  try {
    await checked('git', ['init', '--initial-branch=trunk'], root);
    const git = new Git(root);
    assert.equal(await git.enableLongPaths('linux'), false);
    assert.equal(await longPaths(root), '');
    assert.equal(await git.enableLongPaths('win32'), true);
    assert.equal(await longPaths(root), 'true');
    assert.equal(await git.enableLongPaths('win32'), false);
    await checked('git', ['config', '--local', 'core.longpaths', 'false'], root);
    assert.equal(await git.enableLongPaths('win32'), true);
    assert.equal(await longPaths(root), 'true');
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('uncommitted in-scope inputs are carried into a new task worktree; other changes stay in the source checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'easy carry ')), source = join(root, 'source'), target = join(root, 'task');
  try {
    mkdirSync(join(source, 'docs/plan'), {recursive: true});
    await checked('git', ['init', '--initial-branch=trunk'], source);
    await checked('git', ['config', 'user.name', 'Easy Skills Test'], source);
    await checked('git', ['config', 'user.email', 'test@example.invalid'], source);
    writeFileSync(join(source, 'docs/plan/a.md'), 'old');
    writeFileSync(join(source, 'docs/plan/d.md'), 'gone');
    writeFileSync(join(source, '.gitignore'), 'docs/plan/*.log\n');
    await checked('git', ['add', '--all'], source);
    await checked('git', ['commit', '-m', 'base'], source);
    writeFileSync(join(source, 'docs/plan/a.md'), 'new');
    writeFileSync(join(source, 'docs/plan/b.pdf'), Buffer.from([0, 1, 2, 255]));
    await checked('git', ['add', 'docs/plan/b.pdf'], source);
    writeFileSync(join(source, 'docs/plan/c.md'), 'untracked');
    writeFileSync(join(source, 'docs/plan/debug.log'), 'ignored');
    rmSync(join(source, 'docs/plan/d.md'));
    writeFileSync(join(source, 'outside.txt'), 'not in scope');
    const git = new Git(source);
    await checked('git', ['worktree', 'add', '-b', 'task', target, 'HEAD'], source);
    assert.deepEqual(await git.carryUncommitted(source, target, ['docs/plan']), ['docs/plan/a.md', 'docs/plan/b.pdf', 'docs/plan/c.md', 'docs/plan/d.md']);
    assert.equal(readFileSync(join(target, 'docs/plan/a.md'), 'utf8'), 'new');
    assert.deepEqual([...readFileSync(join(target, 'docs/plan/b.pdf'))], [0, 1, 2, 255]);
    assert.equal(existsSync(join(target, 'docs/plan/d.md')), false);
    assert.equal(existsSync(join(target, 'docs/plan/debug.log')), false);
    assert.equal(existsSync(join(target, 'outside.txt')), false);
    assert.deepEqual(await git.carryUncommitted(source, target, ['docs/plan']), []);
    assert.deepEqual(await git.carryUncommitted(source, target, []), []);
    assert.equal(readFileSync(join(source, 'docs/plan/a.md'), 'utf8'), 'new');
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('without a configured Git identity, task commits use the supplied author', async () => {
  const root = mkdtempSync(join(tmpdir(), 'easy author ')), home = join(root, 'home'), repo = join(root, 'repo');
  const saved = {HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE};
  mkdirSync(home); mkdirSync(repo);
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    await checked('git', ['init', '--initial-branch=trunk'], repo);
    await checked('git', ['config', 'user.useConfigOnly', 'true'], repo);
    const git = new Git(repo);
    assert.equal(await git.hasAuthor(), false);
    writeFileSync(join(repo, 'a.md'), 'a');
    git.author = {name: 'Owner', email: '1+owner@users.noreply.github.com'};
    await git.commit(repo, 'first');
    assert.equal(await git.run(['log', '-1', '--format=%an <%ae>|%cn <%ce>'], repo), 'Owner <1+owner@users.noreply.github.com>|Owner <1+owner@users.noreply.github.com>');
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(root, {recursive: true, force: true});
  }
});
