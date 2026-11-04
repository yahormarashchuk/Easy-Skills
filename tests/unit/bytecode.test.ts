import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropBytecode } from '../../src/runner/bytecode.js';

test('Python bytecode caches are deleted and every other untracked path is kept for the scope check', () => {
  const root = mkdtempSync(join(tmpdir(), 'bytecode-'));
  try {
    mkdirSync(join(root, 'tools', '__pycache__'), {recursive: true}); mkdirSync(join(root, '__pycache__'), {recursive: true}); mkdirSync(join(root, 'tools', 'pycache'), {recursive: true});
    for (const path of ['tools/__pycache__/verify.cpython-315.pyc', '__pycache__/top.cpython-312.pyc', 'tools/__pycache__/notes.txt', 'tools/pycache/x.pyc', 'tools/real.py']) writeFileSync(join(root, path), 'x');
    const rest = dropBytecode(root, ['tools/__pycache__/verify.cpython-315.pyc', '__pycache__/top.cpython-312.pyc', 'tools/__pycache__/notes.txt', 'tools/pycache/x.pyc', 'tools/real.py']);
    assert.deepEqual(rest, ['tools/__pycache__/notes.txt', 'tools/pycache/x.pyc', 'tools/real.py']);
    assert.equal(existsSync(join(root, 'tools/__pycache__/verify.cpython-315.pyc')), false);
    assert.equal(existsSync(join(root, '__pycache__')), false, 'an emptied cache folder is removed');
    assert.equal(existsSync(join(root, 'tools/__pycache__/notes.txt')), true, 'a folder with another file stays');
    assert.equal(existsSync(join(root, 'tools/pycache/x.pyc')), true, 'only __pycache__ folders are touched');
    assert.deepEqual(dropBytecode(root, []), []);
  } finally {rmSync(root, {recursive: true, force: true});}
});
