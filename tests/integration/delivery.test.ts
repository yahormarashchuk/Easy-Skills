import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.js';
import { Guided, type Interaction, type ModelProfile } from '../../src/runner/guided.js';
import { Plan } from '../../src/contracts.js';
import type { Client } from '../../src/adapters/index.js';

class UI implements Interaction {
  messages: string[] = []; denied = new Set<string>();
  say(text: string) {this.messages.push(text);}
  async ask(_id: string, _question: string, fallback?: string) {return fallback || 'Reviewed owner answer';}
  async confirm(id: string) {return !this.denied.has(id);}
}

/** DEFINE reads the specification and names the delivery; PLAN returns one task that is valid in either mode. */
async function propose(options: {delivery?: 'slices' | 'direct'; reason?: string; workflow?: 'direct' | 'slices'; env?: string}) {
  const saved = process.env.EASY_SKILLS_WORKFLOW;
  if (options.env) process.env.EASY_SKILLS_WORKFLOW = options.env; else delete process.env.EASY_SKILLS_WORKFLOW;
  const f = await fixture(), ui = new UI(); ui.denied.add('profile:customize');
  try {
    const profile: ModelProfile = {name: 'Fixture', assignments: structuredClone(f.run.plan.assignments)};
    const project = {...f.run.plan.project}; delete project.mergePolicy;
    const prompts: string[] = [];
    const client: Client = {...f.client, async run(a, prompt, o) {
      if (prompt.includes('Investigate this project progressively')) {
        o.onSession?.(o.session || 'project-interview');
        return {outcome: 'passed', summary: JSON.stringify({summary: 'Use focused checks.', questions: [], rules: [{text: 'Use focused tests.', evidence: ['AGENTS.md']}], conflicts: [], project}), findings: []};
      }
      if (prompt.includes('Investigate the task, relevant code')) {
        prompts.push(prompt); o.onSession?.(o.session || 'task-interview');
        return {outcome: 'passed', summary: JSON.stringify({summary: 'One step.', questions: [], specification: 'Add one behavior.', acceptance: ['It works'], outOfScope: [],
          ...(options.delivery ? {delivery: options.delivery, deliveryReason: options.reason || 'because'} : {})}), findings: []};
      }
      if (o.stage === 'PLAN') {
        o.onSession?.(o.session || 'planning-session');
        const seed = JSON.parse(prompt.split('small sequentially executable slices:\n')[1]!.split('\n')[0]!);
        seed.tasks = [{id: 'only', title: 'Only step', description: 'Do it', dependsOn: [], scope: {areas: [], paths: ['one.txt']}, acceptance: ['Works']}];
        return {outcome: 'passed', summary: 'Plan', findings: [], plan: Plan.parse(seed)};
      }
      return f.client.run(a, prompt, o);
    }};
    const wizard = new Guided(f.store, ui, {client, github: f.github, testRemote: f.remote, ...(options.workflow ? {workflow: options.workflow} : {})});
    await wizard.onboard(f.root, profile, 'Focused checks.');
    const plan = await wizard.proposal(f.root, 'Add one behavior', profile);
    return {mode: plan.workflow?.mode, messages: ui.messages.join('\n'), prompts};
  } finally {
    await f.dispose();
    if (saved === undefined) delete process.env.EASY_SKILLS_WORKFLOW; else process.env.EASY_SKILLS_WORKFLOW = saved;
  }
}

test('DEFINE chooses the delivery from the specification and shows why', async () => {
  const direct = await propose({delivery: 'direct', reason: 'The specification forbids automatic merges.'});
  assert.equal(direct.mode, 'direct');
  assert.match(direct.messages, /Delivery: one task, one PR you merge \(The specification forbids automatic merges\.\)\. Change it with run --direct or run --slices/);
  assert.match(direct.prompts[0]!, /Also choose "delivery"/);
  const slices = await propose({delivery: 'slices', reason: 'Large feature in ordered steps.'});
  assert.equal(slices.mode, 'slices'); assert.match(slices.messages, /Delivery: slices, each with its own Issue and PR/);
});

test('without a choice from anyone a new task is sliced', async () => {
  assert.equal((await propose({})).mode, 'slices');
});

test('the owner flag or environment beats DEFINE, in both directions', async () => {
  const flagged = await propose({delivery: 'direct', workflow: 'slices'});
  assert.equal(flagged.mode, 'slices'); assert.match(flagged.messages, /\(chosen by you\)/);
  assert.equal((await propose({delivery: 'slices', workflow: 'direct'})).mode, 'direct');
  assert.equal((await propose({delivery: 'slices', env: 'direct'})).mode, 'direct');
  assert.equal((await propose({delivery: 'direct', env: 'slices'})).mode, 'slices');
});
