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

test('the NuGet first-run marker in the worktree root is deleted with its empty folders, and look-alikes are kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'nuget-marker-'));
  try {
    mkdirSync(join(root, 'NuGet', 'Migrations'), {recursive: true}); mkdirSync(join(root, 'src', 'NuGet', 'Migrations'), {recursive: true}); mkdirSync(join(root, 'NuGet', 'Other'), {recursive: true});
    for (const path of ['NuGet/Migrations/1', 'src/NuGet/Migrations/1', 'NuGet/Other/file.txt']) writeFileSync(join(root, path), 'x');
    const rest = dropBytecode(root, ['NuGet/Migrations/1', 'src/NuGet/Migrations/1', 'NuGet/Other/file.txt']);
    assert.deepEqual(rest, ['src/NuGet/Migrations/1', 'NuGet/Other/file.txt']);
    assert.equal(existsSync(join(root, 'NuGet/Migrations')), false, 'the emptied folder is removed');
    assert.equal(existsSync(join(root, 'NuGet')), true, 'NuGet stays while another file is in it');
    assert.equal(existsSync(join(root, 'src/NuGet/Migrations/1')), true, 'only the root marker is touched');
    rmSync(join(root, 'NuGet', 'Other'), {recursive: true});
    writeFileSync(join(root, 'NuGet', 'Migrations-file'), 'x'); rmSync(join(root, 'NuGet', 'Migrations-file'));
    mkdirSync(join(root, 'NuGet', 'Migrations'), {recursive: true}); writeFileSync(join(root, 'NuGet/Migrations/2'), 'x');
    assert.deepEqual(dropBytecode(root, ['NuGet/Migrations/2']), []);
    assert.equal(existsSync(join(root, 'NuGet')), false, 'an emptied NuGet folder goes too');
  } finally {rmSync(root, {recursive: true, force: true});}
});
