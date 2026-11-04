import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fixture } from '../helpers.js';
import { Guided, type Interaction, type ModelProfile } from '../../src/runner/guided.js';
import { Plan } from '../../src/contracts.js';
import { Engine } from '../../src/runner/engine.js';
import { Gh } from '../../src/github/index.js';
import { ClientError, type Client } from '../../src/adapters/index.js';
import { hash } from '../../src/util.js';

// Sliced features are the default for new guided tasks; nothing here selects the direct workflow.
delete process.env.EASY_SKILLS_WORKFLOW;

class UI implements Interaction {
  messages: string[] = []; denied = new Set<string>();
  say(text: string) {this.messages.push(text);}
  async ask(_id: string, _question: string, fallback?: string) {return fallback || 'Reviewed owner answer';}
  async confirm(id: string) {return !this.denied.has(id);}
}
type Build = (slice: string, cwd: string, round: number) => {outcome: 'passed' | 'blocked'; question?: string} | void;
/**
 * Three slices listed out of order: `two` and `three` depend on `one`. BUILD writes `<slice>.txt` in its slice worktree
 * unless the test replaces it; every other stage passes.
 */
async function setup(build: Build = () => {}, config: {three?: string[]; delegate?: (prompt: string, call: number) => string; verify?: (slice: string, call: number) => string | undefined} = {}) {
  const f = await fixture(), ui = new UI(); ui.denied.add('profile:customize');
  const profile: ModelProfile = {name: 'Fixture', assignments: structuredClone(f.run.plan.assignments)};
  const project = {...f.run.plan.project}; delete project.mergePolicy;
  const builds: string[] = [], delegated: string[] = [], rounds = new Map<string, number>();
  const buildCalls: {slice: string; prompt: string; session?: string}[] = [], verifyCalls: {slice: string; prompt: string; session?: string}[] = [];
  const client: Client = {...f.client, async run(a, prompt, options) {
    if (prompt.includes('Investigate this project progressively')) {
      options.onSession?.(options.session || 'project-interview');
      return {outcome: 'passed', summary: JSON.stringify({summary: 'Use focused checks.', questions: [],
        rules: [{text: 'Use focused tests.', evidence: ['AGENTS.md']}], conflicts: [], project}), findings: []};
    }
    if (prompt.includes('Investigate the task, relevant code')) {
      options.onSession?.(options.session || 'task-interview');
      return {outcome: 'passed', summary: JSON.stringify({summary: 'Three steps.', questions: [], specification: 'Add three behaviors in order.',
        acceptance: ['All three behaviors work'], outOfScope: ['Unrelated redesign']}), findings: []};
    }
    if (options.stage === 'PLAN' && prompt.includes("owner's delegate")) {
      delegated.push(prompt);
      if (config.delegate) return {outcome: 'passed', summary: config.delegate(prompt, delegated.length), findings: []};
      return {outcome: 'passed', summary: JSON.stringify({resolution: 'answer', category: 'environment', answer: 'Use the tool by its full path C:\\tools\\tool.exe.', rationale: 'Inside the slice scope.'}), findings: []};
    }
    if (options.stage === 'PLAN') {
      assert.match(prompt, /Slices mode: decompose the feature into small sequential slices/);
      options.onSession?.(options.session || 'planning-session');
      const seed = JSON.parse(prompt.split('small sequentially executable slices:\n')[1]!.split('\n')[0]!);
      seed.tasks = [
        {id: 'two', title: 'Second behavior', description: 'Second step', dependsOn: ['one'], scope: {areas: [], paths: ['two.txt', 'broken']}, acceptance: ['Second works']},
        {id: 'one', title: 'First behavior', description: 'First step', dependsOn: [], scope: {areas: [], paths: ['one.txt']}, acceptance: ['First works']},
        {id: 'three', title: 'Third behavior', description: 'Third step', dependsOn: ['one'], scope: {areas: [], paths: ['three.txt']}, acceptance: config.three || ['Third works']}];
      return {outcome: 'passed', summary: 'Technical plan', findings: [], plan: Plan.parse(seed)};
    }
    if (a.model === 'exact-BUILD') {
      options.onSession?.(options.session || 'build-' + basename(options.cwd));
      const slice = basename(options.cwd), round = (rounds.get(slice) || 0) + 1;
      rounds.set(slice, round); builds.push(slice); buildCalls.push({slice, prompt, session: options.session});
      const custom = build(slice, options.cwd, round);
      if (custom?.outcome === 'blocked') return {outcome: 'blocked', summary: 'Blocked in ' + slice, question: custom.question, findings: []};
      if (!custom && slice !== 'integration') writeFileSync(join(options.cwd, slice + '.txt'), slice + ' behavior\n');
      return {outcome: 'passed', summary: 'Built ' + slice, findings: []};
    }
    if (a.model === 'exact-VERIFY') {
      const slice = basename(options.cwd), question = config.verify?.(slice, verifyCalls.filter(c => c.slice === slice).length + 1);
      verifyCalls.push({slice, prompt, session: options.session});
      if (question) {options.onSession?.(options.session || 'verify-' + slice); return {outcome: 'blocked', summary: 'VERIFY blocked in ' + slice, question, findings: []};}
    }
    return f.client.run(a, prompt, options);
  }};
  const wizard = new Guided(f.store, ui, {client, github: f.github, testRemote: f.remote});
  await wizard.onboard(f.root, profile, 'Merge slices without a merge policy.');
  const plan = await wizard.proposal(f.root, 'Add three behaviors', profile), run = await wizard.approve(f.root, plan);
  const engine = (delegateDecisions = false) => new Engine(f.store, {client, github: f.github, testRemote: f.remote, delegateDecisions});
  const slice = (id: string) => f.store.get(run.id).tasks.find(t => t.id === id)!;
  return {...f, ui, plan, approved: run, engine, builds, delegated, slice, buildCalls, verifyCalls};
}

test('approval publishes a milestone, a parent and one labelled, assigned Issue per slice; each slice PR is merged by the runner before its Issue closes', async () => {
  const f = await setup();
  try {
    assert.equal(f.plan.workflow?.mode, 'slices'); assert.equal(f.plan.project.mergePolicy, undefined);
    assert.equal(f.plan.tasks.length, 3); assert.deepEqual(f.plan.permissions, {publishIssues: false, mergeIntermediate: false});
    assert.ok(f.approved.branch.startsWith('feature/'));
    const shown = f.ui.messages.join('\n');
    assert.match(shown, /Slices in order \(3\)/); assert.match(shown, /3 slice Issue\(s\)/);
    assert.match(shown, /Slice merges: automatic/); assert.match(shown, /Final merge to trunk: manual by you; never automatic/);

    const ready = await f.engine().run(f.approved.id);
    assert.equal(ready.status, 'ready', ready.reason || '');
    assert.deepEqual(f.builds, ['one', 'two', 'three'], 'slices run in dependency order, not listing order');
    assert.deepEqual([...f.github.milestones], [[f.plan.title, 1]]);
    const parent = f.github.published.get(ready.parentIssue!)!;
    assert.deepEqual(parent.labels, ['enhancement']); assert.equal(parent.assignee, 'fixture-owner'); assert.equal(parent.milestone, 1);
    // Every Issue exists before the first BUILD: published right after approval.
    assert.ok(f.github.log.indexOf('issue #' + ready.tasks.find(t => t.id === 'three')!.issue) < f.github.log.findIndex(e => e.startsWith('pr #')));
    for (const id of ['one', 'two', 'three']) {
      const state = ready.tasks.find(t => t.id === id)!, issue = f.github.published.get(state.issue!)!, pr = f.github.published.get(state.pr!.number)!;
      assert.deepEqual(issue.labels, ['enhancement']); assert.equal(issue.assignee, 'fixture-owner'); assert.equal(issue.milestone, 1);
      assert.match(issue.body, new RegExp(`Parent: #${ready.parentIssue}`));
      assert.equal(state.pr!.baseRefName, ready.branch); assert.equal(state.pr!.state, 'MERGED'); assert.ok(state.integrated);
      assert.match(pr.body, new RegExp(`Fixes #${state.issue}\\b`)); assert.deepEqual(pr.labels, ['enhancement']); assert.equal(pr.assignee, 'fixture-owner');
      assert.equal(f.github.issues.get(state.issue!), false);
      assert.ok(f.github.log.indexOf('merge #' + state.pr!.number) < f.github.log.indexOf('close #' + state.issue), id + ' closes only after its merge');
    }
    assert.match(f.github.published.get(ready.tasks.find(t => t.id === 'two')!.issue!)!.body, /Dependencies: one \(#\d+\)/);
    assert.deepEqual(f.github.sliceMerges, ['one', 'two', 'three'].map(id => ready.tasks.find(t => t.id === id)!.pr!.number));

    const final = ready.finalPr!, body = f.github.published.get(final.number)!.body;
    assert.equal(final.baseRefName, 'trunk'); assert.equal(final.headRefName, ready.branch); assert.equal(final.state, 'OPEN');
    assert.ok(!f.github.merges.includes(final.number), 'the PR to main is never merged by the runner');
    for (const issue of [ready.parentIssue, ...ready.tasks.map(t => t.issue)]) assert.match(body, new RegExp(`Fixes #${issue}\\b`));
    assert.match(body, /## Slices/); assert.equal(f.github.issues.get(ready.parentIssue!), true);
    for (const file of ['one.txt', 'two.txt', 'three.txt']) assert.ok(existsSync(join(ready.worktree!, file)), file);
    assert.equal(ready.finalReviewHead, await f.git.run(['rev-parse', 'HEAD'], ready.worktree!));

    // The owner merges the final PR; only then does the parent Issue close.
    await f.github.merge(final.number, ready.finalReviewHead!);
    const merged = await f.engine().reconcileFinalMerge(ready.id);
    assert.equal(merged.status, 'merged'); assert.equal(f.github.issues.get(ready.parentIssue!), false);
  } finally {await f.dispose();}
});

test('a failing check in a slice publishes a bug Issue before the repair and closes it after the repaired slice merges', async () => {
  const f = await setup((slice, cwd, round) => {
    if (slice !== 'two') return;
    writeFileSync(join(cwd, 'two.txt'), 'two behavior\n');
    if (round === 1) writeFileSync(join(cwd, 'broken'), 'fails the acceptance check');
    else {
      assert.ok([...f.github.objects.keys()].some(key => key.includes(':repair-issue:')), 'the bug Issue precedes the corrective BUILD');
      rmSync(join(cwd, 'broken'));
    }
    return {outcome: 'passed'};
  });
  try {
    const ready = await f.engine().run(f.approved.id);
    assert.equal(ready.status, 'ready', ready.reason || '');
    assert.deepEqual(f.builds, ['one', 'two', 'two', 'three']);
    const two = ready.tasks.find(t => t.id === 'two')!;
    const [bug, published] = [...f.github.published].find(([, item]) => item.key.includes(':repair-issue:'))!;
    assert.deepEqual(published.labels, ['bug']); assert.equal(published.assignee, 'fixture-owner'); assert.equal(published.milestone, 1);
    assert.match(published.title, /^Bug \(two VERIFY\)/); assert.match(published.body, new RegExp(`Slice: #${two.issue}\\b`));
    assert.match(f.github.published.get(two.pr!.number)!.body, new RegExp(`Fixes #${bug}\\b`));
    assert.equal(f.github.issues.get(bug), false);
    assert.ok(f.github.log.indexOf('merge #' + two.pr!.number) < f.github.log.indexOf('close #' + bug), 'the bug Issue closes only after the repaired slice merged');
    assert.ok(f.github.log.includes(`comment #${two.issue} repair:` + f.store.operation<{id: string}[]>(`${ready.id}:repair:task:two`)![0]!.id));
    assert.match(f.github.published.get(ready.finalPr!.number)!.body, new RegExp(`Fixes #${bug}\\b`));
  } finally {await f.dispose();}
});

test('a slice question is answered by the delegate inside that slice, and the answer is recorded on the slice Issue', async () => {
  const f = await setup((slice, _cwd, round) => slice === 'three' && round === 1 ? {outcome: 'blocked', question: 'Which path should I use for the tool?'} : undefined);
  try {
    const ready = await f.engine(true).run(f.approved.id);
    assert.equal(ready.status, 'ready', ready.reason || ''); assert.equal(ready.pendingDecision, undefined);
    assert.equal(f.delegated.length, 1);
    assert.match(f.delegated[0]!, /Approved task: Third behavior/); assert.match(f.delegated[0]!, /Approved scope paths: \["three\.txt"\]/);
    assert.match(f.delegated[0]!, /"mergeSlices":true/);
    assert.ok(f.github.log.some(entry => entry.startsWith(`comment #${f.slice('three').issue} delegate:`)));
    assert.deepEqual(f.builds, ['one', 'two', 'three', 'three']);
  } finally {await f.dispose();}
});

const THREE = ['Third works', 'Third is proven by a new provenance manifest', 'Third rejects stale results with a new validator', 'Third keeps studio isolation'];
const narrow = (remove: number[], extra: object = {}) => JSON.stringify({resolution: 'narrow', category: 'narrow-scope', answer: '', removeAcceptance: remove,
  rationale: 'The project configures no provenance tooling; the remaining criteria still cover the behavior.', ...extra});
/** VERIFY of slice three stops with `question` on its first `blocks` runs. */
const blockVerify = (blocks: number, question = (call: number) => 'Which manifest proves the run? ' + call) => (slice: string, call: number) => slice === 'three' && call <= blocks ? question(call) : undefined;
type Fixture = Awaited<ReturnType<typeof setup>>;
const planOf = (f: Fixture) => f.store.get(f.approved.id).plan;
const events = (f: Fixture, type: string) => (f.store.events(f.approved.id) as {type: string; data: string}[]).filter(e => e.type === type).map(e => JSON.parse(e.data));

test('a delegate narrows the slice plan: the stage continues in its session with the amended plan, and nobody is asked', async () => {
  const f = await setup(undefined, {three: THREE, delegate: () => narrow([1, 2]), verify: blockVerify(1)});
  try {
    const before = planOf(f), beforeHash = f.store.get(f.approved.id).planHash;
    const ready = await f.engine(true).run(f.approved.id);
    assert.equal(ready.status, 'ready', ready.reason || ''); assert.equal(ready.pendingDecision, undefined);
    const three = ready.plan.tasks.find(t => t.id === 'three')!;
    assert.deepEqual(three.acceptance, [THREE[0], THREE[3]]);
    // Nothing but those criteria changed: paths, checks, permissions, workflow, assignments and repairPolicy are byte-identical.
    const strip = (plan: Plan) => hash({...plan, tasks: plan.tasks.map(t => t.id === 'three' ? {...t, acceptance: []} : t)});
    assert.equal(strip(ready.plan), strip(before)); assert.deepEqual(three.scope, before.tasks.find(t => t.id === 'three')!.scope);
    assert.equal(hash(ready.plan.project.checks), hash(before.project.checks)); assert.equal(hash(ready.plan.permissions), hash(before.permissions));
    assert.equal(ready.planHash, hash(ready.plan)); assert.equal(ready.approvedHash, ready.planHash); assert.notEqual(ready.planHash, beforeHash);
    const history = f.store.operation<{plan: Plan; planHash: string; approvedHash: string}>(`${ready.id}:approval:${beforeHash}`)!;
    assert.equal(history.planHash, beforeHash); assert.equal(hash(history.plan), beforeHash); assert.deepEqual(history.plan.tasks.find(t => t.id === 'three')!.acceptance, THREE);
    assert.equal(f.store.operation<{amendments: number}>(`${ready.id}:delegate-decisions`)!.amendments, 1);

    // The same VERIFY session continued; its prompt shows the amended criteria and says what happened.
    const verifies = f.verifyCalls.filter(c => c.slice === 'three');
    assert.equal(verifies.length, 2); assert.equal(verifies[0]!.session, undefined); assert.equal(verifies[1]!.session, 'verify-three');
    const scope = /\[scope\]\n([^\n]*)/.exec(verifies[1]!.prompt)![1]!;
    assert.match(scope, /Third works/); assert.match(scope, /studio isolation/); assert.doesNotMatch(scope, /provenance manifest/);
    assert.match(verifies[1]!.prompt, /delegate narrowed the approved plan/); assert.match(verifies[1]!.prompt, /no longer required/);
    assert.match(verifies[1]!.prompt, /Third rejects stale results with a new validator/);
    assert.match(verifies[0]!.prompt, /never demand checks, manifests or provenance that are not in the approved configuration/);
    assert.match(verifies[0]!.prompt, /\["acceptance"\]/); assert.match(verifies[0]!.prompt, /naming the criterion by its number/);
    assert.match(verifies[0]!.prompt, /Standard of proof: read the diff, the documents and the tests/); assert.match(verifies[0]!.prompt, /never block because evidence is not independent/);
    assert.match(f.delegated[0]!, /Acceptance criteria of task "three" you may narrow:\n0: Third works\n1: Third is proven/);

    // The event and the Issue comment record it; the slice PR lists only the amended criteria.
    const [event] = events(f, 'plan.narrowed');
    assert.equal(events(f, 'plan.narrowed').length, 1); assert.equal(event.task, 'three'); assert.equal(event.stage, 'VERIFY');
    assert.deepEqual(event.removed, [THREE[1], THREE[2]]); assert.equal(event.removedCount, 2); assert.equal(event.remaining, 2); assert.match(event.rationale, /no provenance tooling/);
    const issue = f.slice('three').issue!;
    assert.ok(f.github.log.some(entry => entry.startsWith(`comment #${issue} narrow:`)));
    const comment = f.github.commentsWritten.find(c => c.includes('Autonomous plan change (no owner was asked)'))!;
    assert.match(comment, /Third is proven by a new provenance manifest/); assert.match(comment, /only removed requirements/); assert.match(comment, /no provenance tooling/);
    assert.ok(!(events(f, 'decision.requested').length));
    assert.doesNotMatch(f.github.published.get(f.slice('three').pr!.number)!.body, /provenance manifest/);
    assert.doesNotMatch(f.github.published.get(ready.finalPr!.number)!.body, /provenance manifest/);
    assert.match(f.github.published.get(ready.finalPr!.number)!.body, /Third keeps studio isolation/);
  } finally {await f.dispose();}
});

test('a narrow reply the runner cannot accept is escalated to the owner and changes nothing', async () => {
  const cases: {name: string; three: string[]; reply: string}[] = [
    {name: 'index out of range', three: THREE, reply: narrow([7])},
    {name: 'three removals', three: THREE, reply: narrow([0, 1, 2])},
    {name: 'every criterion', three: ['Third works', 'Third needs a validator'], reply: narrow([0, 1])},
    {name: 'scope paths added', three: THREE, reply: narrow([1], {scope: {areas: [], paths: ['**']}})},
    {name: 'an answer carrying a removal', three: THREE, reply: JSON.stringify({resolution: 'answer', category: 'environment', answer: 'Carry on.', rationale: 'Fine.', removeAcceptance: [1]})},
    {name: 'an explicit escalation', three: THREE, reply: JSON.stringify({resolution: 'escalate', category: 'needs-owner', answer: '', rationale: 'Owner decides.'})},
  ];
  for (const {name, three, reply} of cases) {
    const f = await setup(undefined, {three, delegate: () => reply, verify: blockVerify(1)});
    try {
      const before = f.store.get(f.approved.id), stopped = await f.engine(true).run(f.approved.id);
      assert.equal(stopped.status, 'needs_decision', name); assert.ok(stopped.pendingDecision && !stopped.pendingDecision.answer, name);
      assert.equal(hash(stopped.plan), hash(before.plan), name); assert.equal(stopped.planHash, before.planHash, name);
      assert.equal(f.delegated.length, 1, name); assert.equal(f.verifyCalls.filter(c => c.slice === 'three').length, 1, name);
      assert.equal(events(f, 'plan.narrowed').length, 0, name); assert.equal(events(f, 'decision.requested').length, 1, name);
      assert.ok(!f.github.commentsWritten.some(c => c.includes('Autonomous plan change')), name);
    } finally {await f.dispose();}
  }
});

test('a run may be amended three times, never twice for one blocker, and a fourth amendment goes to the owner', async () => {
  const six = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'].map(text => text + ' needs tooling');
  const f = await setup(undefined, {three: six, delegate: () => narrow([0]), verify: blockVerify(4)});
  try {
    const stopped = await f.engine(true).run(f.approved.id);
    assert.equal(stopped.status, 'needs_decision'); assert.ok(stopped.pendingDecision && !stopped.pendingDecision.answer);
    assert.deepEqual(stopped.plan.tasks.find(t => t.id === 'three')!.acceptance, six.slice(3));
    assert.equal(f.delegated.length, 4); assert.equal(events(f, 'plan.narrowed').length, 3);
    assert.match(f.delegated[0]!, /You MAY narrow the plan/); assert.match(f.delegated[2]!, /You MAY narrow the plan/);
    assert.doesNotMatch(f.delegated[3]!, /You MAY narrow the plan/, 'the prompt stops offering what the runner would refuse');
    assert.equal(f.store.operation<{amendments: number}>(`${stopped.id}:delegate-decisions`)!.amendments, 3);
    assert.equal(stopped.planHash, hash(stopped.plan)); assert.equal(stopped.approvedHash, stopped.planHash);
    // Each amendment left the plan it replaced in the approval history.
    assert.equal(events(f, 'plan.narrowed').filter(e => f.store.operation(`${stopped.id}:approval:${e.previous}`)).length, 3);
  } finally {await f.dispose();}

  const repeat = await setup(undefined, {three: THREE, delegate: () => narrow([1]), verify: blockVerify(2, () => 'Which manifest proves the run?')});
  try {
    const stopped = await repeat.engine(true).run(repeat.approved.id);
    assert.equal(stopped.status, 'needs_decision'); assert.equal(repeat.delegated.length, 1, 'the delegate is not asked the same blocker twice');
    assert.equal(stopped.plan.tasks.find(t => t.id === 'three')!.acceptance.length, 3); assert.equal(events(repeat, 'plan.narrowed').length, 1);
  } finally {await repeat.dispose();}
});

test('nothing is narrowed unless delegated decisions are on', async () => {
  const f = await setup(undefined, {three: THREE, delegate: () => narrow([1, 2]), verify: blockVerify(1)});
  try {
    const before = f.store.get(f.approved.id), stopped = await f.engine(false).run(f.approved.id);
    assert.equal(stopped.status, 'needs_decision'); assert.equal(f.delegated.length, 0); assert.equal(stopped.planHash, before.planHash); assert.equal(hash(stopped.plan), hash(before.plan));
    assert.equal(events(f, 'plan.narrowed').length, 0);
  } finally {await f.dispose();}
});

test('a blocked BUILD question narrows the slice plan too, and the BUILD session continues', async () => {
  const f = await setup((slice, _cwd, round) => slice === 'three' && round === 1 ? {outcome: 'blocked', question: 'Which validator should I add?'} : undefined,
    {three: THREE, delegate: () => narrow([2])});
  try {
    const ready = await f.engine(true).run(f.approved.id);
    assert.equal(ready.status, 'ready', ready.reason || '');
    assert.deepEqual(ready.plan.tasks.find(t => t.id === 'three')!.acceptance, [THREE[0], THREE[1], THREE[3]]);
    const builds = f.buildCalls.filter(c => c.slice === 'three');
    assert.equal(builds.length, 2); assert.equal(builds[1]!.session, 'build-three'); assert.match(builds[1]!.prompt, /delegate narrowed the approved plan/);
    assert.doesNotMatch(/\[scope\]\n([^\n]*)/.exec(builds[1]!.prompt)![1]!, /new validator/);
  } finally {await f.dispose();}
});

test('a slice may change only its own paths, even when another slice owns the path', async () => {
  const f = await setup(slice => {if (slice === 'one') writeFileSync(join(f.slice('one').worktree!, 'two.txt'), 'belongs to slice two\n'); return slice === 'one' ? {outcome: 'passed'} : undefined;});
  try {
    const stopped = await f.engine().run(f.approved.id);
    assert.equal(stopped.status, 'needs_decision'); assert.match(stopped.reason!, /exceed the approved task paths: two\.txt/);
    assert.equal(f.github.prs.size, 0); assert.deepEqual(f.github.sliceMerges, []);
  } finally {await f.dispose();}
});

test('slice contracts require scoped tasks and the slice grant, and leave direct plans and their hashes unchanged', async () => {
  const f = await setup();
  try {
    const plan = f.plan;
    assert.equal(Plan.safeParse({...plan, tasks: [...plan.tasks, {id: 'four', title: 'Unscoped', description: 'No paths', dependsOn: [], acceptance: ['x']}]}).success, false);
    assert.equal(Plan.safeParse({...plan, permissions: {publishIssues: false, mergeIntermediate: true}}).success, false);
    assert.equal(Plan.safeParse({...plan, workflow: {...plan.workflow, issueHistory: false}}).success, false);
    const direct = {...plan, tasks: [plan.tasks[1]!], workflow: {...plan.workflow, mode: 'direct', permissions: {pushBranch: true, createPullRequest: true, closeIssueOnMerge: true}}};
    assert.equal(hash(Plan.parse(direct)), hash(direct), 'parsing never rewrites an approved direct plan');
    assert.equal(Plan.safeParse({...direct, tasks: plan.tasks}).success, false, 'direct still means exactly one task');
  } finally {await f.dispose();}
});

test('the GitHub transport reuses a milestone by title and never merges a slice PR into the default branch', async () => {
  const requests: string[] = [];
  let base = 'feature/x';
  const gh = new Gh('test/example', '.', async (command, options) => {
    const path = command.args[3] || '', method = command.args[command.args.indexOf('--method') + 1];
    requests.push(`${method} ${path}`);
    let value: unknown;
    if (path.startsWith('repos/test/example/milestones?')) value = path.includes('page=1') ? [{number: 4, title: 'Other'}] : [];
    else if (path === 'repos/test/example/milestones') value = {number: 5};
    else if (path === 'repos/test/example/pulls/7') value = {number: 7, html_url: 'u', head: {sha: 'h', ref: 'issue/x'}, base: {sha: 'b', ref: base}, state: 'open', merged_at: null};
    else if (path === 'repos/test/example') value = {default_branch: 'trunk'};
    else if (path === 'repos/test/example/pulls/7/merge') {assert.deepEqual(JSON.parse(String(options.input)), {sha: 'h', merge_method: 'merge'}); value = {merged: true};}
    return {code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false};
  });
  assert.equal(await gh.milestone('Feature', 'Slices'), 5);
  assert.ok(requests.includes('POST repos/test/example/milestones'));
  assert.deepEqual(await gh.mergeSlice(7, 'h', 'b'), {state: 'merged'});
  await assert.rejects(gh.mergeSlice(7, 'other', 'b'), /head changed/);
  await assert.rejects(gh.mergeSlice(7, 'h', 'moved'), /Feature branch changed/);
  base = 'trunk'; requests.length = 0;
  await assert.rejects(gh.mergeSlice(7, 'h', 'b'), /never the default branch/);
  assert.ok(!requests.some(r => r.includes('/merge')));
});

test('a cut-off GitHub response is a temporary network failure, not an owner decision', async () => {
  for (const stderr of ['unexpected end of JSON input\n', 'unexpected EOF']) {
    const gh = new Gh('test/example', '.', async () => ({code: 1, stdout: '', stderr, timedOut: false, truncated: false}));
    await assert.rejects(gh.api('issues'), (error: unknown) => error instanceof ClientError && error.kind === 'network');
  }
  const refused = new Gh('test/example', '.', async () => ({code: 1, stdout: '', stderr: 'something else failed', timedOut: false, truncated: false}));
  await assert.rejects(refused.api('issues'), (error: unknown) => error instanceof ClientError && error.kind === 'protocol');
});
