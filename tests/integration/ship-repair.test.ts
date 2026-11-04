import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.js';
import { Guided, type Interaction, type ModelProfile } from '../../src/runner/guided.js';
import { Plan } from '../../src/contracts.js';
import { Engine } from '../../src/runner/engine.js';
import type { Client } from '../../src/adapters/index.js';

class UI implements Interaction {
  messages: string[] = []; denied = new Set<string>();
  say(text: string) {this.messages.push(text);}
  async ask(_id: string, _question: string, fallback?: string) {return fallback || 'Reviewed owner answer';}
  async confirm(id: string) {return !this.denied.has(id);}
}

/** SHIP is read-only: a real defect it names must reach a repair BUILD instead of ending the run. */
test('a defect found at SHIP is repaired and the run still reaches a ready PR', async () => {
  const f = await fixture(), ui = new UI(); ui.denied.add('profile:customize');
  try {
    const profile: ModelProfile = {name: 'Fixture', assignments: structuredClone(f.run.plan.assignments)};
    const project = {...f.run.plan.project}; delete project.mergePolicy;
    const shipPrompts: string[] = [], builds: string[] = [];
    let ships = 0;
    const client: Client = {...f.client, async run(a, prompt, o) {
      if (prompt.includes('Investigate this project progressively')) {
        o.onSession?.(o.session || 'project-interview');
        return {outcome: 'passed', summary: JSON.stringify({summary: 'Use focused checks.', questions: [], rules: [{text: 'Use focused tests.', evidence: ['AGENTS.md']}], conflicts: [], project}), findings: []};
      }
      if (prompt.includes('Investigate the task, relevant code')) {
        o.onSession?.(o.session || 'task-interview');
        return {outcome: 'passed', summary: JSON.stringify({summary: 'One step.', questions: [], specification: 'Add one behavior.', acceptance: ['It works'], outOfScope: [], delivery: 'direct'}), findings: []};
      }
      if (o.stage === 'PLAN') {
        o.onSession?.(o.session || 'planning-session');
        const seed = JSON.parse(prompt.split('small sequentially executable slices:\n')[1]!.split('\n')[0]!);
        seed.tasks = [{id: 'only', title: 'Only step', description: 'Do it', dependsOn: [], scope: {areas: [], paths: ['one.txt', 'two.txt', 'broken']}, acceptance: ['Works']}];
        return {outcome: 'passed', summary: 'Plan', findings: [], plan: Plan.parse(seed)};
      }
      if (a.model === 'exact-BUILD') builds.push(prompt);
      if (a.model === 'exact-SHIP') {
        shipPrompts.push(prompt); o.onSession?.(o.session || 'ship-session');
        if (++ships === 1) return {outcome: 'failed', summary: 'The auxiliary query is not isolated', findings: ['A failure of the diagnostic query escapes and hides the real retrieval result.'], };
      }
      return f.client.run(a, prompt, o);
    }};
    const wizard = new Guided(f.store, ui, {client, github: f.github, testRemote: f.remote, workflow: 'direct'});
    await wizard.onboard(f.root, profile, 'Focused checks.');
    const plan = await wizard.proposal(f.root, 'Add one behavior', profile), run = await wizard.approve(f.root, plan);
    const ready = await new Engine(f.store, {client, github: f.github, testRemote: f.remote}).run(run.id);
    assert.equal(ready.status, 'ready', ready.reason || '');
    assert.equal(ships, 2); assert.match(shipPrompts[0]!, /SHIP cannot edit code: if you find a real defect/);
    assert.ok(builds.length >= 2, 'a repair BUILD followed the SHIP finding');
    assert.ok(builds.some(p => /auxiliary query is not isolated|diagnostic query escapes/.test(p)), 'the repair BUILD received the SHIP finding');
    const events = (f.store.events(run.id) as {type: string}[]).map(e => e.type);
    assert.ok(events.includes('feature.repair') || events.includes('task.repair'));
    assert.ok(ready.finalPr);
  } finally {await f.dispose();}
});
