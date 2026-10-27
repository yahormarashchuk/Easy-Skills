import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../../src/cli/bootstrap.js';

test('bootstrap diagnoses prerequisites and installs reviewed skills without model requests', async () => {
  const target = mkdtempSync(join(tmpdir(), 'easy bootstrap fixture '));
  try {
    const dependencies = {async execute() {return {code: 0, stdout: 'fixture version', stderr: '', timedOut: false, truncated: false};},
      async diagnose() {return {installed: true, authenticated: true, version: 'fixture', executable: '/fixture/cli'};}};
    const preview = await bootstrap('.', 'codex', target, undefined, dependencies);
    assert.equal(existsSync(join(target, 'easy-init/SKILL.md')), false);
    const applied = await bootstrap('.', 'codex', target, preview.hash, dependencies);
    assert.equal(applied.applied, true); assert.equal(existsSync(join(target, 'easy-init/SKILL.md')), true);
    const missing = await bootstrap('.', 'codex', target, undefined, {...dependencies, async diagnose() {return {installed: false, authenticated: false};}});
    assert.equal(missing.ready, false); assert.match(missing.next.join(' '), /Install|sign in/i);
  } finally {rmSync(target, {recursive: true, force: true});}
});
