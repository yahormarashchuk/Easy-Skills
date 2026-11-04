import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.js';
import { Guided, type Interaction, type ModelProfile } from '../../src/runner/guided.js';
import { Plan } from '../../src/contracts.js';
import { Engine } from '../../src/runner/engine.js';
import { DELEGATE_TIMEOUT_MS } from '../../src/runner/delegate.js';
import type { Client } from '../../src/adapters/index.js';

class UI implements Interaction {
  messages: string[] = []; denied = new Set<string>();
  say(text: string) {this.messages.push(text);}
  async ask(_id: string, _question: string, fallback?: string) {return fallback || 'Reviewed owner answer';}
  async confirm(id: string) {return !this.denied.has(id);}
}

/** BUILD blocks once with a question; `delegate` decides what each delegate attempt does. */
async function blockedRun(delegate: (attempt: number) => Promise<{outcome: 'passed'; summary: string; findings: string[]}>) {
  const f = await fixture(), ui = new UI(); ui.denied.add('profile:customize');
  try {
    const profile: ModelProfile = {name: 'Fixture', assignments: structuredClone(f.run.plan.assignments)};
    const project = {...f.run.plan.project}; delete project.mergePolicy;
    const timeouts: (number | undefined)[] = [];
    let builds = 0, attempts = 0;
    const client: Client = {...f.client, async run(a, prompt, o) {
      if (prompt.includes('Investigate this project progressively')) {
        o.onSession?.(o.session || 'project-interview');
        return {outcome: 'passed', summary: JSON.stringify({summary: 'Use focused checks.', questions: [], rules: [{text: 'Use focused tests.', evidence: ['AGENTS.md']}], conflicts: [], project}), findings: []};
      }
      if (prompt.includes('Investigate the task, relevant code')) {
        o.onSession?.(o.session || 'task-interview');
        return {outcome: 'passed', summary: JSON.stringify({summary: 'One step.', questions: [], specification: 'Add one behavior.', acceptance: ['It works'], outOfScope: [], delivery: 'direct'}), findings: []};
      }
      if (o.stage === 'PLAN' && prompt.includes("owner's delegate")) {timeouts.push(o.timeoutMs); return delegate(++attempts);}
      if (o.stage === 'PLAN') {
        o.onSession?.(o.session || 'planning-session');
        const seed = JSON.parse(prompt.split('small sequentially executable slices:\n')[1]!.split('\n')[0]!);
        seed.tasks = [{id: 'only', title: 'Only step', description: 'Do it', dependsOn: [], scope: {areas: [], paths: ['one.txt', 'two.txt', 'broken']}, acceptance: ['Works', 'Also works']}];
        return {outcome: 'passed', summary: 'Plan', findings: [], plan: Plan.parse(seed)};
      }
      if (a.model === 'exact-BUILD' && ++builds === 1) {o.onSession?.(o.session || 'build'); return {outcome: 'blocked', summary: 'The tool is not on PATH', question: 'Which path should I use?', findings: []};}
      return f.client.run(a, prompt, o);
    }};
    const wizard = new Guided(f.store, ui, {client, github: f.github, testRemote: f.remote, workflow: 'direct'});
    await wizard.onboard(f.root, profile, 'Focused checks.');
    const plan = await wizard.proposal(f.root, 'Add one behavior', profile), run = await wizard.approve(f.root, plan);
    const final = await new Engine(f.store, {client, github: f.github, testRemote: f.remote, delegateDecisions: true}).run(run.id);
    return {final, timeouts, attempts, events: (f.store.events(run.id) as {type: string}[]).map(e => e.type)};
  } finally {await f.dispose();}
}

test('a delegate call that hangs is retried once with a time limit, then the question goes to the owner', async () => {
  const out = await blockedRun(async () => {throw new Error('The client timed out');});
  assert.equal(out.final.status, 'needs_decision'); assert.ok(out.final.pendingDecision); assert.equal(out.final.pendingDecision!.answer, undefined);
  assert.equal(out.attempts, 2); assert.deepEqual(out.timeouts, [DELEGATE_TIMEOUT_MS, DELEGATE_TIMEOUT_MS]);
  assert.equal(out.events.filter(e => e === 'delegate.failed').length, 2); assert.ok(out.events.includes('decision.requested'));
});

test('a delegate call that fails once is retried and its answer is used', async () => {
  const out = await blockedRun(async attempt => {
    if (attempt === 1) throw new Error('The client timed out');
    return {outcome: 'passed', summary: JSON.stringify({resolution: 'answer', category: 'environment', answer: 'Use the full path C:\\tools\\tool.exe.', rationale: 'Inside the approved scope.'}), findings: []};
  });
  assert.equal(out.final.status, 'ready', out.final.reason || '');
  assert.equal(out.attempts, 2); assert.equal(out.events.filter(e => e === 'delegate.failed').length, 1); assert.ok(out.events.includes('decision.delegated'));
});
