import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.js';
import { Engine } from '../../src/runner/engine.js';
import { hash } from '../../src/util.js';

async function stopped() {
  const f = await fixture();
  const run = f.engine.approve(f.run.id, f.run.planHash);
  run.status = 'needs_decision';
  run.finalSessions = {BUILD: 'old-final', VERIFY: 'keep'};
  for (const task of run.tasks) task.sessions = {BUILD: 'old-task', REVIEW: 'keep'};
  run.pendingDecision = {id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', planHash: run.planHash, head: 'a'.repeat(40), stage: 'BUILD', question: 'Which?'};
  f.store.save(run, 'fixture.stopped');
  return {f, id: run.id, engine: new Engine(f.store, {client: f.client, github: f.github, testRemote: f.remote})};
}
const target = {provider: 'codex', model: 'gpt-6.1-terra', effort: 'medium'};

test('the owner gives one stage another assignment by reviewed hash and only that stage changes', async () => {
  const {f, id, engine} = await stopped();
  try {
    const before = f.store.get(id), previousHash = before.planHash;
    const proposal = await engine.reassignStage(id, 'BUILD', target);
    assert.deepEqual(proposal.to, target); assert.equal(proposal.stage, 'BUILD');
    assert.equal(f.store.get(id).planHash, previousHash, 'a proposal changes nothing');
    await assert.rejects(engine.reassignStage(id, 'BUILD', target, 'wrong'), /proposal changed/);
    await engine.reassignStage(id, 'BUILD', target, proposal.hash);
    const after = f.store.get(id);
    assert.deepEqual(after.plan.assignments.BUILD, target); assert.equal(after.status, 'approved'); assert.equal(after.pendingDecision, undefined);
    for (const stage of ['DEFINE', 'PLAN', 'VERIFY', 'REVIEW', 'SHIP'] as const) assert.deepEqual(after.plan.assignments[stage], before.plan.assignments[stage]);
    assert.deepEqual({...after.plan, assignments: {}}, {...before.plan, assignments: {}}, 'nothing but the assignment changed');
    assert.equal(after.approvedHash, after.planHash); assert.equal(hash(after.plan), after.planHash);
    assert.equal(after.finalSessions.BUILD, undefined); assert.equal(after.finalSessions.VERIFY, 'keep');
    for (const task of after.tasks) {assert.equal(task.sessions.BUILD, undefined); assert.equal(task.sessions.REVIEW, 'keep');}
    assert.equal(f.store.operation<{planHash: string}>(`${id}:approval:${previousHash}`)?.planHash, previousHash);
    assert.ok((f.store.events(id) as {type: string}[]).some(e => e.type === 'plan.reassigned'));
  } finally {await f.dispose();}
});

test('a reassignment is refused for the same assignment, an invalid one, a running task or a task with a live client', async () => {
  const {f, id, engine} = await stopped();
  try {
    const current = f.store.get(id).plan.assignments.BUILD;
    await assert.rejects(engine.reassignStage(id, 'BUILD', current), /already uses this assignment/);
    await assert.rejects(engine.reassignStage(id, 'BUILD', {provider: 'claude-code', model: 'sonnet'}), /exact Claude model ID/);
    await assert.rejects(engine.reassignStage(id, 'BUILD', {provider: 'other', model: 'x'}), /./);
    await assert.rejects(engine.reassignStage(id, 'BUILD', {...target, extra: 1}), /./);
    const run = f.store.get(id); run.status = 'running'; f.store.save(run, 'fixture.running');
    await assert.rejects(engine.reassignStage(id, 'BUILD', target), /Only a task stopped for a decision/);
  } finally {await f.dispose();}
});
