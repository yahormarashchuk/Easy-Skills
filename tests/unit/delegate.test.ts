import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plan, VERSION } from '../../src/contracts.js';
import { MAX_AMENDMENTS, acceptDelegateReply, delegatePrompt, narrowedPlan, narrowingRejected, narrowingViolation } from '../../src/runner/delegate.js';
import { hash } from '../../src/util.js';

const assignments = Object.fromEntries(['DEFINE', 'PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SHIP'].map(stage => [stage, {provider: 'codex', model: 'exact-' + stage}]));
const plan = Plan.parse({schemaVersion: 2, repairPolicy: {maxCompletedAttempts: 3}, protectedInputs: {}, featureId: 'sample', title: 'Sample', spec: 'Deliver behaviors.',
  project: {schemaVersion: 2, name: 'Example', repository: 'test/example', mainBranch: 'trunk', githubTransport: 'gh', checks: [{id: 'acceptance', command: 'node', args: ['check.mjs']}]}, assignments,
  tasks: [{id: 'one', title: 'First', description: 'First step', acceptance: ['a0', 'a1', 'a2', 'a3'], scope: {areas: [], paths: ['one.txt']}},
    {id: 'two', title: 'Second', description: 'Second step', dependsOn: ['one'], acceptance: ['b0', 'b1'], scope: {areas: [], paths: ['two.txt']}}],
  rulesHash: 'a'.repeat(64), runnerVersion: VERSION, skillsVersion: VERSION, permissions: {publishIssues: false, mergeIntermediate: false}});
const narrowable = {taskId: 'one', acceptance: plan.tasks[0]!.acceptance, amendments: 0};
const reply = (extra: object = {}) => JSON.stringify({resolution: 'narrow', category: 'narrow-scope', answer: '', rationale: 'Needs tooling that is not configured.', removeAcceptance: [1], ...extra});

test('the runner limits what an amendment may remove', () => {
  const four = narrowable.acceptance;
  assert.equal(narrowingRejected([1], four, 0), undefined);
  assert.equal(narrowingRejected([1, 3], four, 2), undefined);
  assert.match(narrowingRejected([], four, 0)!, /No criterion/);
  assert.match(narrowingRejected([4], four, 0)!, /does not exist/);
  assert.match(narrowingRejected([1, 1], four, 0)!, /twice/);
  assert.match(narrowingRejected([0, 1, 2], four, 0)!, /More than 2/);
  assert.match(narrowingRejected([0, 1], ['x', 'y'], 0)!, /At least one criterion must remain/);
  assert.match(narrowingRejected([0], ['only'], 0)!, /no acceptance criterion it could lose/);
  assert.match(narrowingRejected([1], four, MAX_AMENDMENTS)!, /already used/);
  assert.equal(narrowingRejected([], four, 0, true), undefined);
  assert.ok(narrowingRejected([], four, MAX_AMENDMENTS, true));
});

test('a narrow reply is accepted only inside the limits, for a criterion list, and never carries other changes', () => {
  assert.deepEqual(acceptDelegateReply(reply(), [], 'q', narrowable)?.removeAcceptance, [1]);
  assert.equal(acceptDelegateReply(reply(), [], 'q'), undefined, 'a stage without a narrowable task escalates');
  assert.equal(acceptDelegateReply(reply(), [hash('q')], 'q', narrowable), undefined, 'the same blocker is never narrowed twice');
  assert.equal(acceptDelegateReply(reply({removeAcceptance: [9]}), [], 'q', narrowable), undefined);
  assert.equal(acceptDelegateReply(reply({removeAcceptance: [0, 1, 2]}), [], 'q', narrowable), undefined);
  assert.equal(acceptDelegateReply(reply(), [], 'q', {...narrowable, amendments: MAX_AMENDMENTS}), undefined);
  assert.equal(acceptDelegateReply(reply({category: 'technical-choice'}), [], 'q', narrowable), undefined);
  assert.equal(acceptDelegateReply(reply({rationale: ' '}), [], 'q', narrowable), undefined);
  assert.equal(acceptDelegateReply(reply({answer: 'Skip the tests.'}), [], 'q', narrowable), undefined);
  for (const extra of [{scope: {paths: ['**']}}, {description: 'x'}, {checks: []}, {permissions: {}}])
    assert.equal(acceptDelegateReply(reply(extra), [], 'q', narrowable), undefined, JSON.stringify(extra));
});

test('answer and escalate replies behave as before, and an answer cannot smuggle a removal', () => {
  const answer = JSON.stringify({resolution: 'answer', category: 'environment', answer: 'Use the full tool path.', rationale: 'Inside scope.'});
  assert.equal(acceptDelegateReply(answer, [], 'q', narrowable)?.answer, 'Use the full tool path.');
  assert.equal(acceptDelegateReply(answer, [], 'q')?.removeAcceptance.length, 0);
  assert.equal(acceptDelegateReply(JSON.stringify({resolution: 'answer', category: 'environment', answer: 'Go on.', removeAcceptance: [1]}), [], 'q', narrowable), undefined);
  assert.equal(acceptDelegateReply(JSON.stringify({resolution: 'escalate', category: 'needs-owner', rationale: 'Owner decides.'}), [], 'q', narrowable), undefined);
  assert.equal(acceptDelegateReply(JSON.stringify({resolution: 'answer', category: 'needs-owner', answer: 'x'}), [], 'q'), undefined);
  assert.equal(acceptDelegateReply(answer, [hash('q')], 'q'), undefined);
  assert.equal(acceptDelegateReply('not json', [], 'q', narrowable), undefined);
});

test('an amendment removes only the named criteria of one task and is proven to change nothing else', () => {
  const after = narrowedPlan(plan, 'one', [1, 2]);
  assert.deepEqual(after.tasks[0]!.acceptance, ['a0', 'a3']); assert.deepEqual(after.tasks[1], plan.tasks[1]);
  assert.notEqual(hash(after), hash(plan)); assert.equal(narrowingViolation(plan, after, 'one', [1, 2]), undefined);
  assert.match(narrowingViolation(plan, after, 'one', [1])!, /not the approved ones minus/);
  assert.match(narrowingViolation(plan, after, 'zzz', [1])!, /not in the approved plan/);
  const tamper = (change: (copy: Plan) => void) => {const copy = structuredClone(after); change(copy); return narrowingViolation(plan, copy, 'one', [1, 2]);};
  assert.match(tamper(p => {p.tasks[0]!.scope!.paths.push('extra.txt');})!, /more than acceptance/);
  assert.match(tamper(p => {p.tasks[0]!.description = 'changed';})!, /description is not the approved one/);
  assert.match(tamper(p => {p.project.checks.pop();})!, /more than acceptance/);
  assert.match(tamper(p => {p.permissions.publishIssues = true;})!, /more than acceptance/);
  assert.match(tamper(p => {p.repairPolicy!.maxCompletedAttempts = 9;})!, /more than acceptance/);
  assert.match(tamper(p => {p.tasks[1]!.acceptance.pop();})!, /more than acceptance/);
  assert.match(tamper(p => {p.tasks[0]!.acceptance.push('new');})!, /not the approved ones minus/);
});

test('the delegate prompt offers narrowing only while the runner would accept it', () => {
  const ask = (n?: typeof narrowable) => delegatePrompt(plan, 'VERIFY', plan.tasks[0], 'Which manifest?', 'blocked', [], [], n);
  const offered = ask(narrowable);
  assert.match(offered, /You MAY narrow the plan \(resolution "narrow"/); assert.match(offered, /\n1: a1\n/); assert.match(offered, /checks that are not configured/);
  assert.match(offered, /NEVER narrow away a criterion about product behaviour, tenant, permission or studio isolation, data protection, "never skip tests", security/);
  assert.match(offered, /"removeAcceptance"/);
  for (const prompt of [ask(), ask({...narrowable, amendments: MAX_AMENDMENTS}), ask({...narrowable, acceptance: ['only']})]) {
    assert.doesNotMatch(prompt, /You MAY narrow/); assert.doesNotMatch(prompt, /removeAcceptance/);
  }
});
