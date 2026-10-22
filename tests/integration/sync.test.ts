import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { Engine } from '../../src/runner/engine.js';
import { answerDecision } from '../../src/runner/remote.js';
import { hash } from '../../src/util.js';

test('sync preserves a blocked conflict and resumes only its recorded merge with a scoped answer', async () => {
  const f = await fixture();
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash);
    writeFileSync(join(f.root, 'shared.txt'), 'base\n');
    await f.git.commit(f.root, 'shared base'); await f.git.push('trunk', f.root);
    const path = join(f.store.home, 'worktrees', run.id, 'integration');
    run.worktree = await f.git.worktree(run.branch, 'trunk', path);
    f.store.save(run, 'test.integration');
    writeFileSync(join(run.worktree, 'shared.txt'), 'feature behavior\n'); await f.git.commit(run.worktree, 'feature');
    writeFileSync(join(f.root, 'shared.txt'), 'access control\n'); await f.git.commit(f.root, 'main changed'); await f.git.push('trunk', f.root);
    let calls = 0, answerSeen = false;
    const engine = new Engine(f.store, {github: f.github, client: {...f.client, async run(a, prompt, options) {
      calls++; options.onSession?.('conflict-session');
      if (calls === 1) return {outcome: 'blocked', summary: 'Need intended contract', question: 'Preserve both behaviors?', findings: []};
      answerSeen = prompt.includes('Keep both');
      assert.equal(options.session, 'conflict-session');
      writeFileSync(join(options.cwd, 'shared.txt'), 'feature behavior\naccess control\n');
      await f.git.run(['add', 'shared.txt'], options.cwd);
      return {outcome: 'passed', summary: 'Both behaviors preserved', findings: []};
    }}});
    await assert.rejects(engine.syncManual(run.id), /Need intended contract/);
    const blocked = f.store.get(run.id);
    assert.equal(blocked.status, 'needs_decision');
    assert.ok(blocked.pendingDecision);
    const mergeHead = await f.git.run(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], run.worktree);
    assert.equal(existsSync(mergeHead), true);
    answerDecision(f.store, run.id, blocked.pendingDecision!.id, 'Keep both');
    await assert.rejects(Promise.resolve().then(() => answerDecision(f.store, run.id, blocked.pendingDecision!.id, 'Different')), /already answered/);
    const synced = await engine.syncManual(run.id);
    assert.equal(answerSeen, true); assert.equal(synced.finalReviewHead, undefined); assert.equal(synced.finalPhase, 'VERIFY');
    assert.equal(existsSync(mergeHead), false);
    assert.equal(readFileSync(join(synced.worktree!, 'shared.txt'), 'utf8'), 'feature behavior\naccess control\n');
    assert.equal(f.store.operation<{completed: boolean}>(`${run.id}:sync:${hash(synced.worktree)}`)?.completed, true);
  } finally {await f.dispose();}
});
