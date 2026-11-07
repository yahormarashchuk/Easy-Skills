import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.js';
import { Guided, type Interaction, type ModelProfile } from '../../src/runner/guided.js';
import { Plan } from '../../src/contracts.js';
import type { Client } from '../../src/adapters/index.js';

delete process.env.EASY_SKILLS_WORKFLOW;

class UI implements Interaction {
  messages: string[] = []; denied = new Set<string>();
  say(text: string) {this.messages.push(text);}
  async ask(_id: string, _question: string, fallback?: string) {return fallback || 'Reviewed owner answer';}
  async confirm(id: string) {return !this.denied.has(id);}
}
/** DEFINE picks `direct`; PLAN reads the same specification and returns a sliced plan, the way a specification that asks for one PR per slice does. */
async function setup(options: {workflow?: 'direct' | 'slices'} = {}) {
  const f = await fixture(), ui = new UI(); ui.denied.add('profile:customize');
  const profile: ModelProfile = {name: 'Fixture', assignments: structuredClone(f.run.plan.assignments)};
  const project = {...f.run.plan.project}; delete project.mergePolicy;
  const seen: string[] = [];
  const client: Client = {...f.client, async run(a, prompt, o) {
    if (prompt.includes('Investigate this project progressively')) {
      o.onSession?.(o.session || 'project-interview');
      return {outcome: 'passed', summary: JSON.stringify({summary: 'Use focused checks.', questions: [], rules: [{text: 'Use focused tests.', evidence: ['AGENTS.md']}], conflicts: [], project}), findings: []};
    }
    if (prompt.includes('Investigate the task, relevant code')) {
      o.onSession?.(o.session || 'task-interview');
      return {outcome: 'passed', summary: JSON.stringify({summary: 'Two steps.', questions: [], specification: 'Deliver one PR per slice.', acceptance: ['Both slices work'], outOfScope: [], delivery: 'direct', deliveryReason: 'Specification lists its own PRs'}), findings: []};
    }
    if (o.stage === 'PLAN') {
      o.onSession?.(o.session || 'planning-session');
      const seed = JSON.parse(prompt.split('small sequentially executable slices:\n')[1]!.split('\n')[0]!);
      seen.push(seed.workflow.mode);
      seed.workflow = {...seed.workflow, mode: 'slices', permissions: {pushBranch: true, createPullRequest: true, closeIssueOnMerge: true, mergeSlices: true}};
      seed.tasks = [
        {id: 'one', title: 'First', description: 'First step', dependsOn: [], scope: {areas: [], paths: ['one.txt']}, acceptance: ['First works']},
        {id: 'two', title: 'Second', description: 'Second step', dependsOn: ['one'], scope: {areas: [], paths: ['two.txt']}, acceptance: ['Second works']}];
      // The runner's own mode, when it already is slices, is returned untouched.
      return {outcome: 'passed', summary: 'Technical plan', findings: [], plan: Plan.parse(seed)};
    }
    return f.client.run(a, prompt, o);
  }};
  const wizard = new Guided(f.store, ui, {client, github: f.github, testRemote: f.remote, ...options});
  await wizard.onboard(f.root, profile, 'Plan the delivery mode.');
  return {...f, ui, profile, wizard, seen};
}

test('PLAN needing the other delivery mode than DEFINE guessed plans again once with it', async () => {
  const f = await setup();
  try {
    const plan = await f.wizard.proposal(f.root, 'Two slices', f.profile);
    assert.equal(plan.workflow?.mode, 'slices'); assert.equal(plan.tasks.length, 2);
    assert.deepEqual(f.seen, ['direct', 'slices']);
    assert.match(f.ui.messages.join('\n'), /PLAN found that the specification needs slices/);
  } finally {await f.dispose();}
});

test('a delivery mode the owner forced is never switched by PLAN', async () => {
  const f = await setup({workflow: 'direct'});
  try {
    await assert.rejects(f.wizard.proposal(f.root, 'Two slices', f.profile), /changed an agreed field: workflow\. The delivery mode belongs to the runner.*run --direct.*run --slices/);
    assert.deepEqual(f.seen, ['direct']);
  } finally {await f.dispose();}
});
