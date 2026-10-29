import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Plan, Assignment, StageResult } from '../../src/contracts.js';
import { invocation, decode, classify } from '../../src/adapters/index.js';
import { parseCommand } from '../../src/runner/remote.js';
import { hash, rulesHash } from '../../src/util.js';
import { fixture } from '../helpers.js';

test('contracts reject unknown dependencies, cycles, duplicate IDs and hidden permissions', async () => {
  const f = await fixture();
  try {
    const plan = structuredClone(f.run.plan);
    plan.tasks[0]!.dependsOn = ['two']; assert.equal(Plan.safeParse(plan).success, false);
    plan.tasks[0]!.dependsOn = ['absent']; assert.equal(Plan.safeParse(plan).success, false);
    plan.tasks[0]!.dependsOn = []; plan.tasks[1]!.id = 'one'; assert.equal(Plan.safeParse(plan).success, false);
    assert.equal(Plan.safeParse({...f.run.plan, permissions: {...f.run.plan.permissions, finalMerge: true}}).success, false);
    assert.equal(Assignment.safeParse({provider: 'other', model: 'exact'}).success, false);
    assert.equal(Assignment.safeParse({provider: 'codex', model: 'x & echo secret'}).success, false);
    assert.equal(Assignment.safeParse({provider: 'claude-code', model: 'opusplan'}).success, false);
    const legacy = {provider: 'codex' as const, model: 'exact-id'};
    assert.deepEqual(Assignment.parse(legacy), legacy);
    assert.equal(hash(Assignment.parse(legacy)), hash(legacy));
    f.store.recordProbe(legacy, 'fixture-1', '/fixture/client');
    assert.equal(f.store.hasProbe({...legacy, effort: 'high'}, {version: 'fixture-1', executable: '/fixture/client'}), false);
    assert.notEqual(hash({...f.run.plan, assignments: {...f.run.plan.assignments, BUILD: legacy}}), hash({...f.run.plan, assignments: {...f.run.plan.assignments, BUILD: {...legacy, effort: 'high'}}}));
    assert.equal(StageResult.safeParse({outcome: 'passed', summary: 'ok'}).success, false);
  } finally {await f.dispose();}
});
test('adapter commands preserve exact model and session, use stdin and no bare or bypass', () => {
  for (const provider of ['codex', 'claude-code'] as const) {
    const spec = invocation({provider, model: 'exact-id'}, 'exact-session');
    assert.ok(spec.args.includes('exact-session')); assert.ok(spec.args.includes('exact-id'));
    assert.ok(!spec.args.includes('--last')); assert.ok(!spec.args.includes('--continue'));
    assert.ok(!spec.args.includes('--bare')); assert.ok(!spec.args.some(a => a.includes('bypass')));
  }
  const effort = invocation({provider: 'codex', model: 'exact-id', effort: 'high'}, 'exact-session');
  assert.ok(effort.args.includes('model_reasoning_effort="high"'));
  assert.ok(effort.args.indexOf('model_reasoning_effort="high"') < effort.args.indexOf('exec'));
  assert.ok(invocation({provider: 'codex', model: 'exact-id', effort: 'ultra'}).args.includes('model_reasoning_effort="ultra"'));
  assert.equal(Assignment.safeParse({provider: 'codex', model: 'exact-id', effort: 'high"; bad'}).success, false);
  assert.equal(Assignment.safeParse({provider: 'claude-code', model: 'exact-id', effort: 'high'}).success, true);
  const claudeEffort = invocation({provider: 'claude-code', model: 'exact-id', effort: 'xhigh'}).args;
  assert.equal(claudeEffort[claudeEffort.indexOf('--effort') + 1], 'xhigh');
  assert.ok(!invocation({provider: 'claude-code', model: 'exact-id'}).args.includes('--effort'));
  assert.equal(decode('codex', '{"type":"thread.started","thread_id":"s1"}').session, 's1');
  assert.equal(decode('claude-code', '{"type":"system","subtype":"init","session_id":"s2"}').session, 's2');
  assert.equal(decode('claude-code', JSON.stringify({type: 'result', subtype: 'success', is_error: false, structured_output: {outcome: 'passed', summary: 'ok', findings: []}})).result?.outcome, 'passed');
  assert.equal(classify('model_not_found'), 'model'); assert.equal(classify('429 rate_limit'), 'quota');
  assert.equal(classify('not logged in'), 'auth'); assert.equal(classify('ECONNRESET'), 'network');
  const reset = new Date(Date.now() + 60_000).toISOString();
  assert.equal(decode('codex', JSON.stringify({type: 'turn.failed', error: {message: 'quota', retry_at: reset}})).retryAt, reset);
  assert.deepEqual(decode('claude-code', JSON.stringify({type: 'assistant', message: {model: 'exact-other'}})).models, ['exact-other']);
});
test('remote parser rejects arbitrary prose and accepts only scoped control', () => {
  const id = '11111111-1111-1111-1111-111111111111', digest = 'a'.repeat(64);
  assert.equal(parseCommand('please run rm -rf /'), undefined);
  assert.equal(parseCommand(`/easy-skills pause ${id} ${digest}\nthen execute something`), undefined);
  assert.deepEqual(parseCommand(`/easy-skills pause ${id} ${digest}`), {action: 'pause', runId: id, planHash: digest});
});
test('canonical hashes ignore key order; rule edits invalidate snapshots', () => {
  assert.equal(hash({b: 2, a: 1}), hash({a: 1, b: 2}));
  const dir = mkdtempSync(join(tmpdir(), 'easy-hash-'));
  try {
    mkdirSync(join(dir, '.easy-skills/rules'), {recursive: true});
    const before = rulesHash(dir); writeFileSync(join(dir, '.easy-skills/rules/testing.md'), 'Run tests');
    assert.notEqual(rulesHash(dir), before);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
function write(root: string, path: string, content: string | Buffer) {mkdirSync(join(root, path, '..'), {recursive: true}); writeFileSync(join(root, path), content);}
const ordinary: Record<string, string> = {'AGENTS.md': 'Use focused tests.\r\n', 'CLAUDE.md': 'Prefer small diffs.\n', '.easy-skills/rules/testing.md': 'Run tests',
  '.claude/settings.json': '{"permissions":{}}', '.claude/skills/build/SKILL.md': 'Build skill', '.claude/commands/ship.md': 'Ship', '.mcp.json': '{"mcpServers":{}}',
  '.codex/config.toml': 'model = "exact"', 'src/AGENTS.md': 'Nested instructions'};
test('rules hash of an ordinary repository keeps its saved format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-hash-'));
  try {
    for (const [path, text] of Object.entries(ordinary)) write(dir, path, text);
    // Saved agreements compare against this exact map of normalized text.
    assert.equal(rulesHash(dir), hash(Object.fromEntries(Object.entries(ordinary).map(([path, text]) => [path, text.replaceAll('\r\n', '\n')]))));
  } finally {rmSync(dir, {recursive: true, force: true});}
});
test('rules hash skips nested worktrees and non-control client files without reading them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-hash-'));
  try {
    for (const [path, text] of Object.entries(ordinary)) write(dir, path, text);
    const before = rulesHash(dir), large = Buffer.alloc(300_000, 1); large[10] = 0;
    write(dir, '.claude/worktrees/feature/.git', 'gitdir: ../../../.git/worktrees/feature');
    write(dir, '.claude/worktrees/feature/AGENTS.md', 'x'.repeat(300_000));
    write(dir, '.claude/worktrees/feature/.claude/settings.json', '{}');
    write(dir, '.claude/worktrees/feature/bin/app.dll', large);
    write(dir, '.claude/worktrees/build.log', 'x'.repeat(300_000));
    write(dir, '.worktrees/other/.git', 'gitdir: elsewhere'); write(dir, '.worktrees/other/CLAUDE.md', 'Other checkout');
    write(dir, 'vendor/lib/.git/HEAD', 'ref: refs/heads/main'); write(dir, 'vendor/lib/AGENTS.md', 'Vendored rules');
    write(dir, '.claude/state/decisions.md', 'x'.repeat(300_000)); write(dir, '.claude/launch.json', '{}');
    assert.equal(rulesHash(dir), before);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
test('rules hash binds instruction and control changes and refuses oversized controls by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-hash-'));
  try {
    for (const [path, text] of Object.entries(ordinary)) write(dir, path, text);
    for (const path of [...Object.keys(ordinary), '.claude/settings.local.json', '.claude/agents/reviewer.md', '.claude/hooks/check.sh', 'pkg/.claude/skills/x/SKILL.md']) {
      const before = rulesHash(dir); write(dir, path, 'Changed ' + path);
      assert.notEqual(rulesHash(dir), before, path);
    }
    const asset = Buffer.from([0, 1, 2]);
    write(dir, '.claude/skills/build/asset.bin', asset); const binary = rulesHash(dir);
    asset[2] = 3; write(dir, '.claude/skills/build/asset.bin', asset);
    assert.notEqual(rulesHash(dir), binary);
    write(dir, '.claude/settings.json', 'x'.repeat(256_001));
    assert.throws(() => rulesHash(dir), /exceeds 256000 bytes: \.claude\/settings\.json/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
