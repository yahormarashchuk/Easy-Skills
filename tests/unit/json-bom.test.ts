import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonFile, stripBom } from '../../src/util.js';

test('JSON written with a UTF-8 BOM (Windows PowerShell 5.1, some editors) is read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'es-bom-'));
  try {
    const file = join(dir, 'with-bom.json');
    writeFileSync(file, '\uFEFF{\n  "schemaVersion": 1\n}\n', 'utf8');
    assert.deepEqual(readJsonFile(file), {schemaVersion: 1});
    const plain = join(dir, 'plain.json');
    writeFileSync(plain, '{"schemaVersion":1}', 'utf8');
    assert.deepEqual(readJsonFile(plain), {schemaVersion: 1});
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('stripBom removes only a leading BOM', () => {
  assert.equal(stripBom('\uFEFFabc'), 'abc');
  assert.equal(stripBom('abc\uFEFF'), 'abc\uFEFF');
  assert.equal(stripBom(''), '');
});
