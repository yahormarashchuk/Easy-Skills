import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorIdentity } from '../../src/runner/failures.js';
import { cleanExcerpt, CheckFailure } from '../../src/runner/check-failure.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { protectedManifest } from '../../src/runner/protected-inputs.js';

test('different failing tests are different issues, while timing changes are not progress', () => {
  const bundle = {checkId: 'unit', command: 'node check.mjs', exitCode: 1, classification: 'regression',
    tests: ['not ok 1 - login (12.50ms)'], stdout: '', stderr: '', previousUnsuccessfulAttempts: 0, expected: 'pass'};
  const first = new CheckFailure(bundle);
  assert.notEqual(errorIdentity(first), errorIdentity(new CheckFailure({...bundle, tests: ['not ok 1 - permissions (12.50ms)']})));
  assert.equal(errorIdentity(first), errorIdentity(new CheckFailure({...bundle, tests: ['not ok 1 - login (99.99ms)']})));
});

test('protected inputs preserve non-UTF8 bytes and normalize only UTF8 text line endings', () => {
  const root = mkdtempSync(join(tmpdir(), 'easy protected bytes fixture '));
  try {
    const project = {schemaVersion: 2 as const, name: 'Fixture', repository: 'fixture/repo', mainBranch: 'main', remote: 'origin' as const, githubTransport: 'gh' as const,
      checks: [{id: 'check', command: './check.py', args: [], timeoutMs: 1000}]};
    const path = join(root, 'check.py');
    writeFileSync(path, Buffer.from([35, 32, 128])); const first = protectedManifest(root, project);
    writeFileSync(path, Buffer.from([35, 32, 129])); assert.notDeepEqual(protectedManifest(root, project), first);
    writeFileSync(path, Buffer.from([255])); const binary = protectedManifest(root, project);
    writeFileSync(path, '/w=='); assert.notDeepEqual(protectedManifest(root, project), binary);
    writeFileSync(path, '# fixture\r\n'); const text = protectedManifest(root, project);
    writeFileSync(path, '# fixture\n'); assert.deepEqual(protectedManifest(root, project), text);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('failure identity ignores timestamps, PIDs, revisions and changing temporary paths', () => {
  assert.equal(errorIdentity('Failed test login at 2026-10-21T10:22:33.000Z PID 123 C:/Temp/a/run.log'),
    errorIdentity('Failed test login at 2026-10-22T11:33:44.000Z PID 999 C:/Temp/b/run.log'));
  assert.notEqual(errorIdentity('Failed test login'), errorIdentity('Failed test permissions'));
});
test('repair excerpts remove credentials and private state paths', () => {
  process.env.EASY_FIXTURE_TOKEN = 'sensitive-fixture-token';
  try {
    const text = cleanExcerpt('secret sensitive-fixture-token password=fixture-pass C:\\private\\state\\check.log', 'C:\\private\\state');
    assert.ok(!text.includes('sensitive-fixture-token')); assert.ok(!text.includes('fixture-pass')); assert.ok(!text.includes('C:\\private'));
  } finally {delete process.env.EASY_FIXTURE_TOKEN;}
});

test('Windows private paths are redacted across case, slash and JSON-escaped forms', () => {
  for (const path of ['c:\\PRIVATE\\State\\check.log', 'C:/PRIVATE/STATE/check.log', 'C:\\\\PRIVATE\\\\State\\\\check.log']) {
    const excerpt = cleanExcerpt(path, 'C:\\Private\\State');
    assert.match(excerpt, /^<runner-private>/); assert.doesNotMatch(excerpt, /state/i);
  }
});
