import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { Guided, resolveRun, type Interaction, type ModelProfile } from '../../src/runner/guided.js';
import { discover, knowledgeSnapshot } from '../../src/runner/discovery.js';
import { requireAgreement } from '../../src/runner/onboarding.js';
import { Plan } from '../../src/contracts.js';
import { Engine } from '../../src/runner/engine.js';
import { ClientError, type Client } from '../../src/adapters/index.js';
import { hash } from '../../src/util.js';
import { TerminalInteraction } from '../../src/cli/interaction.js';

class UI implements Interaction {
  messages: string[] = []; questions: string[] = []; confirmations: string[] = [];
  denied = new Set<string>(); values: Record<string, string> = {};
  say(text: string) {this.messages.push(text);}
  async ask(id: string, question: string, fallback?: string) {this.questions.push(id); return this.values[id] || fallback || 'Reviewed owner answer';}
  async confirm(id: string) {this.confirmations.push(id); return !this.denied.has(id);}
}
async function setup() {
  const f = await fixture(), ui = new UI(); ui.denied.add('profile:customize');
  const profile: ModelProfile = {name: 'Fixture', assignments: structuredClone(f.run.plan.assignments)};
  const project = {...f.run.plan.project}; delete project.mergePolicy;
  const github = Object.assign(f.github, {async readIssue(number: number) {
    return {number, title: 'Find names in either order', body: 'Preserve existing scoping and single-token behavior.', url: `https://github.com/test/example/issues/${number}`, labels: ['bug'], state: 'open'};
  }});
  github.issues.set(909, true);
  let projectCalls = 0, taskCalls = 0, planCalls = 0;
  const client: Client = {...f.client, async run(a, prompt, options) {
    if (prompt.includes('Investigate this project progressively')) {
      projectCalls++; options.onSession?.(options.session || 'project-interview');
      return {outcome: 'passed', summary: JSON.stringify({summary: 'Use focused checks and existing conventions.',
        questions: projectCalls === 1 ? [{id: 'dependencies', question: 'Do new dependencies require approval?'}] : [],
        rules: [{text: 'Use focused tests and preserve existing boundaries.' + (projectCalls > 2 ? ' Approve dependencies.' : ''), evidence: ['AGENTS.md']}], conflicts: [], project}), findings: []};
    }
    if (prompt.includes('Investigate the task, relevant code')) {
      taskCalls++; options.onSession?.(options.session || 'task-interview');
      return {outcome: 'passed', summary: JSON.stringify({summary: 'Preserve search compatibility.', questions: [],
        specification: 'Find full names in either order. ' + (prompt.includes('Developer feedback:') ? 'Normalize repeated spaces.' : ''),
        acceptance: ['Both orders work; single-token and scoping behavior remains compatible.'], outOfScope: ['Unrelated search redesign']}), findings: []};
    }
    if (options.stage === 'PLAN') {
      planCalls++; options.onSession?.(options.session || 'planning-session');
      const seed = JSON.parse(prompt.split('small sequentially executable slices:\n')[1]!.split('\n')[0]!);
      seed.tasks = [{id: 'search', title: 'Repair name search', description: seed.spec, dependsOn: [], scope: {areas: [], paths: ['one.txt', 'two.txt', 'broken']}, acceptance: ['Search contract is preserved']}];
      return {outcome: 'passed', summary: 'Technical plan', findings: [], plan: Plan.parse(seed)};
    }
    return f.client.run(a, prompt, options);
  }};
  const wizard = new Guided(f.store, ui, {client, github, testRemote: f.remote});
  const engine = new Engine(f.store, {client, github, testRemote: f.remote});
  return {...f, client, ui, profile, project, github, wizard, engine, counts: () => ({projectCalls, taskCalls, planCalls})};
}

test('progressive discovery is read-only, bounded, caches evidence and preserves dirty Unicode paths', async () => {
  const f = await setup();
  try {
    writeFileSync(join(f.root, 'local-\u03b1-\u03b2.txt'), '1 2 3');
    writeFileSync(join(f.root, 'AGENTS.md'), 'Use focused tests.\nPreserve local edits.\n');
    const before = await f.git.run(['status', '--porcelain']);
    const first = await discover(f.root, f.store), second = await discover(f.root, f.store);
    assert.equal(first.repository, 'test/example'); assert.equal(first.baseBranch, 'trunk'); assert.ok(first.dirty);
    assert.equal(first.fingerprint, second.fingerprint); assert.ok(first.examples.length <= 40);
    assert.ok(first.examples.reduce((n, e) => n + e.content.length, 0) <= 80_000);
    assert.equal(await f.git.run(['status', '--porcelain']), before);
    writeFileSync(join(f.root, 'AGENTS.md'), 'Updated maintained instructions.');
    assert.notEqual((await discover(f.root, f.store)).fingerprint, first.fingerprint);
    writeFileSync(join(f.root, 'AGENTS.md'), '1'.repeat(8000) + '\nFirst maintained rule.');
    const long = await discover(f.root, f.store);
    writeFileSync(join(f.root, 'AGENTS.md'), '1'.repeat(8000) + '\nSecond maintained rule.');
    assert.notEqual((await discover(f.root, f.store)).fingerprint, long.fingerprint);
  } finally {await f.dispose();}
});

test('onboarding remembers answers, preserves instructions and versions approved rules without running checks', async () => {
  const f = await setup();
  try {
    rmSync(join(f.root, '.easy-skills/decisions/onboarding.json'));
    const instructions = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
    f.ui.denied.add('rules:approve');
    await assert.rejects(f.wizard.onboard(f.root, f.profile), /not approved/);
    assert.equal(existsSync(join(f.root, '.easy-skills/decisions/onboarding.json')), false);
    assert.equal(f.ui.questions.filter(q => q === 'interview:dependencies').length, 1);
    f.ui.denied.delete('rules:approve');
    await f.wizard.onboard(f.root, f.profile);
    assert.equal(requireAgreement(f.root).version, 1);
    const knowledge = JSON.parse(readFileSync(join(f.root, '.easy-skills/context/knowledge.json'), 'utf8'));
    assert.equal(knowledge.answers.dependencies.source, 'owner'); assert.deepEqual(knowledge.rules[0].evidence, ['AGENTS.md']);
    await f.wizard.onboard(f.root, f.profile);
    assert.equal(f.counts().projectCalls, 2); assert.equal(f.calls.length, 0);
    assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), instructions);
    await f.wizard.onboard(f.root, f.profile, 'Require approval for new dependencies.');
    assert.equal(requireAgreement(f.root).version, 2);
    assert.ok(knowledgeSnapshot(f.root)['.easy-skills/rules/approved-rules.md']);
    assert.ok(!f.store.events(f.run.id).some(e => String(e.type).startsWith('check.')));
  } finally {await f.dispose();}
});

test('saved profiles retain every exact assignment and Claude isolation fails closed without fallback', async () => {
  const f = await setup();
  try {
    const saved = await f.wizard.profile(f.root, true, f.profile);
    assert.deepEqual(saved.assignments, f.profile.assignments);
    assert.deepEqual(await f.wizard.profile(f.root), f.profile);
    await f.wizard.compatibility(f.root, f.profile);
    assert.equal(f.calls.length, 0);
    const restricted = new Guided(f.store, f.ui, {client: {...f.client, async diagnose(a) {
      return {installed: true, authenticated: true, isolation: a.provider !== 'claude-code', detail: 'Managed-hook exclusion cannot be proven', version: 'fixture-1', executable: '/fixture/client'};
    }}});
    await assert.rejects(restricted.compatibility(f.root, f.profile), /Managed-hook.*no fallback/);
    assert.deepEqual((await f.wizard.profile(f.root)).assignments, saved.assignments);
    assert.equal(f.calls.length, 0);
  } finally {await f.dispose();}
});

test('new profiles select current client models by number and preserve per-stage exact assignments', async () => {
  const f = await setup();
  try {
    let calls = 0;
    f.client.listModels = async provider => {
      assert.equal(provider, 'codex'); calls++;
      return [{model: 'catalog-model-b', displayName: 'Model B', isDefault: true}, {model: 'catalog-model-a', displayName: 'Model A', isDefault: false}];
    };
    Object.assign(f.ui.values, {'profile:name': 'Numbered', 'profile:provider': 'codex', 'profile:model': '2'});
    f.ui.denied.delete('profile:customize');
    for (const stage of ['DEFINE', 'PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SHIP']) {
      f.ui.values['profile:' + stage + ':provider'] = 'codex'; f.ui.values['profile:' + stage + ':model'] = stage === 'REVIEW' ? '1' : '2';
    }
    const profile = await f.wizard.profile(f.root);
    assert.equal(calls, 1); assert.equal(profile.assignments.BUILD.model, 'catalog-model-a'); assert.equal(profile.assignments.REVIEW.model, 'catalog-model-b');
    assert.ok(f.ui.messages.some(text => text.includes('1. Model B') && text.includes('2. Model A')));
    const saved = await f.wizard.profile(f.root); assert.deepEqual(saved, profile); assert.equal(calls, 1);
  } finally {await f.dispose();}
});

test('invalid interactive stage provider is explained and retried without losing earlier assignments', async () => {
  const f = await setup();
  try {
    const messages: string[] = [], questions: string[] = [];
    const ui = new TerminalInteraction();
    ui.say = text => {messages.push(text);};
    let reviewAttempts = 0;
    ui.ask = async (id, _question, fallback) => {
      questions.push(id);
      if (id === 'profile:REVIEW:provider' && reviewAttempts++ === 0) return '1';
      return fallback || 'Profile';
    };
    ui.confirm = async () => true;
    ui.select = async (_id, _question, choices) => choices[1]!.value;
    f.client.listModels = async () => [{model: 'first-model', displayName: 'First', isDefault: true}, {model: 'second-model', displayName: 'Second', isDefault: false}];
    const profile = await new Guided(f.store, ui, {client: f.client}).profile(f.root);
    assert.equal(reviewAttempts, 2);
    assert.equal(questions.filter(id => id === 'profile:BUILD:provider').length, 1);
    assert.ok(messages.some(text => /Unknown provider/.test(text) && /Model numbers/.test(text)));
    assert.equal(profile.assignments.BUILD.model, 'second-model');
    assert.equal(profile.assignments.REVIEW.model, 'second-model');
    assert.equal(profile.assignments.REVIEW.provider, 'codex');
    ui.close();
  } finally {await f.dispose();}
});

test('editing refreshes the catalog, requires an explicit replacement for an unavailable saved model and handles empty catalogs', async () => {
  const f = await setup();
  try {
    await f.wizard.profile(f.root, true, f.profile);
    let calls = 0;
    f.client.listModels = async () => {calls++; return [{model: 'new-model', displayName: 'New current model', isDefault: true}];};
    Object.assign(f.ui.values, {'profile:select': 'Fixture', 'profile:provider': 'codex', 'profile:model': '1'});
    const updated = await f.wizard.profile(f.root, true);
    assert.equal(updated.assignments.BUILD.model, 'new-model'); assert.equal(calls, 1);
    assert.ok(f.ui.messages.some(text => text.includes('saved model is not in the current catalog')));
    f.client.listModels = async () => [];
    await assert.rejects(f.wizard.profile(f.root, true), /no selectable models/);
  } finally {await f.dispose();}
});

test('onboarding refuses a rule citation when its tracked source has been deleted', async () => {
  const f = await setup();
  try {
    rmSync(join(f.root, 'AGENTS.md'));
    await assert.rejects(f.wizard.onboard(f.root, f.profile, 'Review current conventions.'), /existing repository path: AGENTS.md/);
    assert.ok(!f.ui.confirmations.includes('rules:approve'));
    assert.equal(existsSync(join(f.root, 'AGENTS.md')), false);
  } finally {await f.dispose();}
});

test('one approval delivers a direct existing-Issue PR without duplicate Issues, integration PRs or merge-policy access', async () => {
  const f = await setup();
  try {
    await f.wizard.onboard(f.root, f.profile, 'Preserve focused verification.');
    writeFileSync(join(f.root, 'developer-notes.txt'), 'Uncommitted developer work');
    const original = await f.git.run(['status', '--porcelain']);
    const plan = await f.wizard.proposal(f.root, 'https://github.com/test/example/issues/909', f.profile);
    assert.equal(plan.workflow?.issue, 909); assert.equal(plan.project.mergePolicy, undefined);
    assert.equal(plan.tasks.length, 1); assert.equal(plan.permissions.publishIssues, false);
    f.ui.denied.add('task:approve');
    await assert.rejects(f.wizard.approve(f.root, plan), /not approved/);
    assert.equal(f.github.objects.size, 0); assert.equal(f.store.list().length, 1);
    f.ui.denied.delete('task:approve');
    const approved = await f.wizard.approve(f.root, plan);
    assert.equal(resolveRun(f.store, f.root, '909').id, approved.id);
    const ready = await f.engine.run(approved.id);
    assert.equal(ready.status, 'ready', ready.reason || ''); assert.equal(ready.parentIssue, 909);
    assert.equal(ready.finalPr?.baseRefName, 'trunk'); assert.equal(f.github.prs.size, 1);
    assert.equal(f.github.objects.size, 1); assert.equal(f.github.merges.length, 0); assert.equal(f.github.issues.get(909), true);
    assert.ok(ready.branch.startsWith('codex/issue-909')); assert.equal(ready.tasks[0]?.worktree, undefined);
    assert.equal((await f.git.run(['worktree', 'list', '--porcelain'])).match(/^worktree /gm)?.length, 2);
    assert.equal(await f.git.run(['status', '--porcelain']), original);
    const codeDiff = await f.git.run(['diff', '--name-only', plan.workflow!.baseHead, 'HEAD'], ready.worktree!);
    assert.ok(!codeDiff.includes('.easy-skills')); assert.ok(codeDiff.includes('two.txt'));
    assert.ok(ready.finalEvidence.every(e => e.code === 0 && e.head === ready.finalReviewHead));
    assert.ok(f.ui.messages.some(m => m.includes('Final merge: manual; no merge authorized.')));
    assert.ok(f.store.operation(`${ready.id}:review-coverage:feature:${ready.finalReviewHead}`));
    await assert.rejects(f.engine.confirmFinalMerge(ready.id, ready.finalReviewHead!), /No agreed GitHub merge policy/);
    assert.equal(f.github.merges.length, 0);
  } finally {await f.dispose();}
});

test('feedback replaces approval with retained history and reuses the branch and PR', async () => {
  const f = await setup();
  try {
    const plan = await f.wizard.proposal(f.root, '909', f.profile), run = await f.wizard.approve(f.root, plan);
    const ready = await f.engine.run(run.id); assert.equal(ready.status, 'ready', ready.reason || '');
    const revised = await f.wizard.proposal(f.root, 'Normalize repeated spaces.', f.profile, ready);
    assert.notEqual(hash(revised), ready.planHash);
    await assert.rejects(f.engine.revise(ready.id, revised, hash(revised), 'stale', ready.finalReviewHead!), /stale/);
    const approved = await f.wizard.approve(f.root, revised, ready);
    assert.equal(approved.id, ready.id); assert.equal(approved.branch, ready.branch);
    assert.equal(approved.finalReviewHead, undefined); assert.deepEqual(approved.finalEvidence, []);
    const history = f.store.operation<{plan: Plan; head: string}>(`${run.id}:approval:${ready.planHash}`)!;
    assert.equal(history.plan.spec, ready.plan.spec); assert.equal(history.head, ready.finalReviewHead);
    const updated = await f.engine.run(approved.id);
    assert.equal(updated.status, 'ready', updated.reason || ''); assert.equal(updated.finalPr?.number, ready.finalPr?.number);
    assert.equal(f.github.prs.size, 1); assert.equal(f.github.issues.size, 1); assert.equal(f.github.merges.length, 0);
    assert.equal(updated.approvedHash, hash(revised));
  } finally {await f.dispose();}
});

test('direct tasks preserve sessions across quota waits, repair failing code, and reconcile manual merges', async () => {
  const f = await setup();
  try {
    const plan = await f.wizard.proposal(f.root, '909', f.profile), run = await f.wizard.approve(f.root, plan);
    let builds = 0; const sessions: (string | undefined)[] = [];
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-BUILD') {
        builds++; sessions.push(o.session); o.onSession?.('direct-session');
        if (builds === 1) throw new ClientError('quota', 'usage limit reached');
        if (builds === 2) writeFileSync(join(o.cwd, 'broken'), '0');
        if (builds === 3) rmSync(join(o.cwd, 'broken'));
      }
      return f.client.run(a, p, o);
    }}});
    const waiting = await engine.run(run.id);
    assert.equal(waiting.status, 'waiting_quota'); assert.equal(waiting.finalSessions.BUILD, 'direct-session');
    const ready = await engine.run(run.id); assert.equal(ready.status, 'ready', ready.reason || '');
    assert.equal(builds, 3); assert.equal(sessions[1], 'direct-session');
    assert.ok(f.store.operation<{state: string}[]>(`${run.id}:repair:feature`)?.some(r => r.state === 'completed'));
    await f.github.merge(ready.finalPr!.number, ready.finalReviewHead!);
    const merged = await engine.reconcileFinalMerge(run.id);
    assert.equal(merged.status, 'merged'); assert.equal(f.github.issues.get(909), false);
  } finally {await f.dispose();}
});

test('task inputs reject foreign Issue URLs, support local specifications, and keep natural language out of shells', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.wizard.source(f.root, 'https://github.com/other/project/issues/909'), /configured GitHub/);
    await assert.rejects(f.wizard.source(f.root, 'https://github.com/test/example/issues/909?other=x'), /configured GitHub/);
    await assert.rejects(f.wizard.source(f.root, '0'), /positive|Issue/); // Transport validation below also checks CLI inputs.
    writeFileSync(join(f.root, 'task \u03b1.md'), '# Local specification\n\nPreserve behavior.\n');
    assert.match((await f.wizard.source(f.root, 'task \u03b1.md')).spec, /Preserve behavior/);
    const text = 'Fix names; echo $(anything) & preserve scope';
    assert.equal((await f.wizard.source(f.root, text)).spec, text);
  } finally {await f.dispose();}
});

test('noninteractive operation requires explicit consent and never defaults missing answers to yes', async () => {
  const ui = new TerminalInteraction({nonInteractive: true});
  await assert.rejects(ui.confirm('task:approve', 'Start?'), /Input required.*task:approve/);
  await assert.rejects(ui.ask('profile:model', 'Exact model?', 'default-value'), /Input required/);
  ui.close();
});

test('scripted approvals bind the displayed proposal and reject a prefilled boolean or stale digest', async () => {
  const f = await setup();
  try {
    const file = join(f.dir, 'consent.json');
    writeFileSync(file, JSON.stringify({'task:approve': true}));
    await assert.rejects(new TerminalInteraction({answers: file, nonInteractive: true}).confirm('task:approve', 'Start?', 'a'.repeat(64)), /boolean cannot approve/);
    writeFileSync(file, JSON.stringify({'task:approve': 'approve:' + 'b'.repeat(64)}));
    const ui = new TerminalInteraction({answers: file, nonInteractive: true});
    await assert.rejects(ui.confirm('task:approve', 'Start?', 'a'.repeat(64)), /does not match/);
    assert.equal(await ui.confirm('task:approve', 'Start?', 'b'.repeat(64)), true);
  } finally {await f.dispose();}
});

test('unapproved text-task drafts keep their exact identity and plan across a review interruption', async () => {
  const f = await setup();
  try {
    const first = await f.wizard.proposal(f.root, 'Fix names with focused tests', f.profile);
    const second = await f.wizard.proposal(f.root, 'Fix names with focused tests', f.profile);
    assert.equal(hash(first), hash(second)); assert.equal(f.counts().planCalls, 1);
    assert.equal(f.counts().taskCalls, 1); assert.equal(f.github.prs.size, 0);
    const approved = await f.wizard.approve(f.root, second), ready = await f.engine.run(approved.id);
    assert.equal(ready.status, 'ready', ready.reason || ''); assert.equal(ready.parentIssue, undefined);
    assert.equal(f.github.objects.size, 1); assert.equal(f.github.prs.size, 1);
    assert.equal(resolveRun(f.store, f.root, 'latest').id, ready.id);
    assert.equal(resolveRun(f.store, f.root, ready.plan.title).id, ready.id);
  } finally {await f.dispose();}
});

test('owner refinements replace an unapproved Issue proposal without changing Issue identity or publishing', async () => {
  const f = await setup();
  try {
    const first = await f.wizard.proposal(f.root, '909', f.profile);
    const revised = await f.wizard.proposal(f.root, '909', f.profile, undefined, 'Preserve selection behavior and normalize spaces.');
    assert.notEqual(hash(first), hash(revised)); assert.equal(revised.workflow?.issue, 909);
    assert.equal(revised.featureId, first.featureId); assert.match(revised.spec, /Preserve selection behavior/);
    assert.equal(f.github.objects.size, 0);
  } finally {await f.dispose();}
});

test('rule-save intents recover partial writes and refuse intervening owner edits', async () => {
  const f = await setup();
  try {
    await f.wizard.onboard(f.root, f.profile, 'Approve new dependency rules.');
    const key = 'knowledge:' + hash(f.root);
    const intent = f.store.operation<{approved: boolean; completed: boolean; changes: {path: string; before: string | null; after: string}[]}>(key)!;
    const change = intent.changes[0]!;
    if (change.before === null) rmSync(join(f.root, change.path)); else writeFileSync(join(f.root, change.path), change.before);
    f.store.recordOperation(key, key, 'fixture.interrupted', {...intent, completed: false});
    const counts = f.counts(); await f.wizard.onboard(f.root, f.profile);
    assert.deepEqual(f.counts(), counts); assert.equal(requireAgreement(f.root).version, 2);
    f.store.recordOperation(key, key, 'fixture.interrupted', {...intent, completed: false});
    writeFileSync(join(f.root, change.path), 'Owner changes must survive');
    await assert.rejects(f.wizard.onboard(f.root, f.profile), /changed during recovery/);
    assert.equal(readFileSync(join(f.root, change.path), 'utf8'), 'Owner changes must survive');
  } finally {await f.dispose();}
});

test('probe interruption resumes its exact saved session without substituting assignments', async () => {
  const f = await setup();
  try {
    f.store.db.prepare('DELETE FROM probes WHERE key=?').run(f.store.probeKey(f.profile.assignments.DEFINE));
    const sessions: (string | undefined)[] = []; let first = true;
    const wizard = new Guided(f.store, f.ui, {client: {...f.client, async run(a, p, o) {
      sessions.push(o.session); o.onSession?.('saved-probe-session');
      if (first) {first = false; throw new ClientError('quota', 'usage limit reached');}
      return {outcome: 'passed', summary: 'Probe', findings: []};
    }}});
    await assert.rejects(wizard.compatibility(f.root, f.profile), /usage limit/);
    await wizard.compatibility(f.root, f.profile);
    assert.deepEqual(sessions, [undefined, 'saved-probe-session', 'saved-probe-session']);
    assert.ok(f.store.hasProbe(f.profile.assignments.DEFINE, {version: 'fixture-1', executable: '/fixture/client'}));
  } finally {await f.dispose();}
});

test('onboarding resolves reported contradictions through the saved conversation', async () => {
  const f = await setup();
  try {
    let first = true;
    const client: Client = {...f.client, async run(a, p, o) {
      const result = await f.client.run(a, p, o);
      if (first && o.stage === 'DEFINE') {
        first = false;
        const reply = JSON.parse(result.summary); reply.questions = []; reply.conflicts = ['Two maintained examples disagree about dependency approvals.'];
        result.summary = JSON.stringify(reply);
      }
      return result;
    }};
    const wizard = new Guided(f.store, f.ui, {client, github: f.github});
    await wizard.onboard(f.root, f.profile, 'Resolve maintained dependency conventions.');
    assert.ok(f.ui.questions.some(id => id.startsWith('interview:conflict-')));
    assert.equal(requireAgreement(f.root).version, 2);
  } finally {await f.dispose();}
});

test('direct scope guards preserve unexpected edits and never publish unapproved paths', async () => {
  const f = await setup();
  try {
    const plan = await f.wizard.proposal(f.root, '909', f.profile), run = await f.wizard.approve(f.root, plan);
    assert.equal(Plan.safeParse({...plan, tasks: [...plan.tasks, {...plan.tasks[0], id: 'other'}]}).success, false);
    assert.equal(Plan.safeParse({...plan, permissions: {publishIssues: true, mergeIntermediate: false}}).success, false);
    const engine = new Engine(f.store, {testRemote: f.remote, github: f.github, client: {...f.client, async run(a, p, o) {
      if (a.model === 'exact-BUILD') writeFileSync(join(o.cwd, 'outside-scope.txt'), 'Preserve for inspection');
      return f.client.run(a, p, o);
    }}});
    const stopped = await engine.run(run.id);
    assert.equal(stopped.status, 'needs_decision'); assert.match(stopped.reason!, /exceed.*approved task paths/);
    assert.equal(readFileSync(join(stopped.worktree!, 'outside-scope.txt'), 'utf8'), 'Preserve for inspection');
    assert.equal(f.github.prs.size, 0); assert.equal(f.github.objects.size, 0);
  } finally {await f.dispose();}
});

test('lost direct PR response reconciles the same PR and prevents a second executor for its Issue', async () => {
  const f = await setup();
  try {
    const plan = await f.wizard.proposal(f.root, '909', f.profile), run = await f.wizard.approve(f.root, plan);
    assert.throws(() => f.store.create(run.root, run.commonDir, {...plan, featureId: 'renamed-issue'}), /already uses this Issue/);
    const publish = f.github.pr.bind(f.github); let once = false;
    f.github.pr = async (...args) => {
      const pr = await publish(...args);
      if (!once) {once = true; throw new ClientError('network', 'Lost publication acknowledgement');}
      return pr;
    };
    const waiting = await f.engine.run(run.id); assert.equal(waiting.status, 'waiting_external');
    const ready = await f.engine.run(run.id); assert.equal(ready.status, 'ready', ready.reason || '');
    assert.equal(f.github.prs.size, 1); assert.equal(f.github.issues.size, 1);
    assert.equal(f.calls.filter(c => c.startsWith('exact-BUILD:')).length, 1);
  } finally {await f.dispose();}
});
