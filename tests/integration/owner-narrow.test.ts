import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.js';
import { Engine } from '../../src/runner/engine.js';
import { hash } from '../../src/util.js';

/** A task stopped for a decision loses only the criteria the owner names, after reviewing the hash. */
async function stopped() {
  const f = await fixture();
  const run = f.engine.approve(f.run.id, f.run.planHash);
  const tasks = run.plan.tasks.map((t, index) => index === 0 ? {...t, description: 'Adopt the repair. Add a result validator. Run postgres-checkin, result-validator-tests and every other extra check.', acceptance: ['Behaviour works', 'Validator rejects stale results', 'Full contract passes', 'Documents are updated']} : t);
  run.plan = {...run.plan, tasks}; run.planHash = hash(run.plan); run.approvedHash = run.planHash; run.status = 'needs_decision';
  run.pendingDecision = {id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', planHash: run.planHash, head: 'a'.repeat(40), stage: 'VERIFY', taskId: run.plan.tasks[0]!.id, question: 'Which criteria?'};
  run.parentIssue = 4242;
  f.store.save(run, 'fixture.stopped');
  return {f, id: run.id, task: run.plan.tasks[0]!.id, engine: new Engine(f.store, {client: f.client, github: f.github, testRemote: f.remote})};
}

test('the owner narrows a stopped task by reviewed hash, and only the named criteria go', async () => {
  const {f, id, task, engine} = await stopped();
  try {
    const before = f.store.get(id), previousHash = before.planHash;
    const proposal = await engine.narrowAcceptance(id, task, [1, 2], 'Not verifiable with the approved checks.');
    assert.deepEqual(proposal.removed, ['Validator rejects stale results', 'Full contract passes']);
    assert.deepEqual(proposal.remaining, ['Behaviour works', 'Documents are updated']);
    assert.equal(f.store.get(id).planHash, previousHash, 'a proposal changes nothing');
    await assert.rejects(engine.narrowAcceptance(id, task, [1, 2], 'Not verifiable with the approved checks.', 'wrong'), /proposal changed/);
    const applied = await engine.narrowAcceptance(id, task, [1, 2], 'Not verifiable with the approved checks.', proposal.hash);
    const after = f.store.get(id);
    assert.equal(applied.status, 'approved'); assert.equal(after.status, 'approved'); assert.equal(after.pendingDecision, undefined);
    assert.deepEqual(after.plan.tasks.find(t => t.id === task)!.acceptance, ['Behaviour works', 'Documents are updated']);
    assert.equal(after.approvedHash, after.planHash); assert.equal(hash(after.plan), after.planHash);
    assert.deepEqual({...after.plan, tasks: []}, {...before.plan, tasks: []}, 'nothing but acceptance changed outside the tasks');
    assert.deepEqual(after.plan.tasks.map(t => ({...t, acceptance: 0})), before.plan.tasks.map(t => ({...t, acceptance: 0})));
    const history = f.store.operation<{planHash: string}>(`${id}:approval:${previousHash}`);
    assert.equal(history?.planHash, previousHash);
    assert.ok((f.store.events(id) as {type: string; data: string}[]).some(e => e.type === 'plan.narrowed' && JSON.parse(e.data).owner === true));
    assert.ok(f.github.commentsWritten.some(c => c.includes('Removed acceptance criteria') && c.includes('Validator rejects stale results')));
  } finally {await f.dispose();}
});

test('the owner may also replace a task description by a shorter one, with or without removing criteria', async () => {
  const {f, id, task, engine} = await stopped();
  try {
    const before = f.store.get(id), original = before.plan.tasks.find(t => t.id === task)!.description;
    const shorter = 'Adopt the repair.';
    assert.ok(shorter.length < original.length);
    const proposal = await engine.narrowAcceptance(id, task, [], 'The description demanded checks that do not exist.', undefined, shorter);
    assert.equal(proposal.descriptionChanged, true); assert.deepEqual(proposal.removed, []); assert.equal(proposal.remaining.length, 4);
    await assert.rejects(engine.narrowAcceptance(id, task, [], 'why', undefined, original + ' and more'), /not longer than the approved one/);
    await assert.rejects(engine.narrowAcceptance(id, task, [], 'why', undefined, '   '), /non-empty/);
    await assert.rejects(engine.narrowAcceptance(id, task, [], 'why'), /Name existing, distinct criteria/);
    await engine.narrowAcceptance(id, task, [1], 'The description demanded checks that do not exist.', proposal.hash, shorter).then(() => assert.fail('a different request must not use another hash'), error => assert.match(String(error), /proposal changed/));
    const both = await engine.narrowAcceptance(id, task, [1], 'The description demanded checks that do not exist.', undefined, shorter);
    await engine.narrowAcceptance(id, task, [1], 'The description demanded checks that do not exist.', both.hash, shorter);
    const after = f.store.get(id), amended = after.plan.tasks.find(t => t.id === task)!;
    assert.equal(amended.description, shorter); assert.equal(amended.acceptance.length, 3); assert.equal(after.status, 'approved');
    assert.deepEqual(after.plan.tasks.filter(t => t.id !== task), before.plan.tasks.filter(t => t.id !== task), 'other tasks are untouched');
    assert.deepEqual({...after.plan, tasks: []}, {...before.plan, tasks: []});
  } finally {await f.dispose();}
});

test('the owner cannot narrow with bad input, a missing task, every criterion, or a running task', async () => {
  const {f, id, task, engine} = await stopped();
  try {
    await assert.rejects(engine.narrowAcceptance(id, 'nope', [1], 'why'), /No such task/);
    await assert.rejects(engine.narrowAcceptance(id, task, [], 'why'), /Name existing, distinct criteria/);
    await assert.rejects(engine.narrowAcceptance(id, task, [1, 1], 'why'), /Name existing, distinct criteria/);
    await assert.rejects(engine.narrowAcceptance(id, task, [9], 'why'), /Name existing, distinct criteria/);
    await assert.rejects(engine.narrowAcceptance(id, task, [-1], 'why'), /Name existing, distinct criteria/);
    await assert.rejects(engine.narrowAcceptance(id, task, [0, 1, 2, 3], 'why'), /At least one criterion must remain/);
    await assert.rejects(engine.narrowAcceptance(id, task, [1], '   '), /A reason is required/);
    const run = f.store.get(id); run.status = 'running'; f.store.save(run, 'fixture.running');
    await assert.rejects(engine.narrowAcceptance(id, task, [1], 'why'), /Only a task stopped for a decision/);
  } finally {await f.dispose();}
});
