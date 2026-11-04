import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { fixture } from '../helpers.js';
import { generatePlan, PlanDecisionNeeded } from '../../src/runner/planning.js';
import { InvalidResult } from '../../src/adapters/index.js';

test('PLAN uses the selected model read-only and cannot expand agreed permissions', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, '.easy-skills'), {recursive: true});
    writeFileSync(join(f.root, '.easy-skills/project.yaml'), stringify(f.run.plan.project));
    const {featureId, title, spec, assignments, permissions, repairPolicy} = f.run.plan;
    const request = {featureId, title, spec, assignments, permissions, repairPolicy};
    let model = '', mode: string | undefined;
    const plan = await generatePlan(f.store, f.root, request, {...f.client, async run(a, p, o) {
      model = a.model; mode = o.mode; assert.match(p, /UNAPPROVED, READ-ONLY/);
      // Criteria may only rely on approved checks and runner evidence; PLAN must not invent verification tooling.
      assert.match(p, /may rely only on the checks that exist in the approved project configuration \(\["acceptance"\]\)/);
      assert.match(p, /never require creating new verification tooling, result validators, provenance manifests or new project checks as acceptance, unless the specification explicitly demands that tool as a product deliverable/);
      return {outcome: 'passed', summary: 'Planned', findings: [], plan: f.run.plan};
    }});
    assert.equal(model, assignments.PLAN.model); assert.equal(mode, 'read'); assert.equal(plan.tasks.length, 2);
    await assert.rejects(generatePlan(f.store, f.root, request, {...f.client, async run() {
      return {outcome: 'passed', summary: 'Unsafe draft', findings: [], plan: {...f.run.plan, permissions: {publishIssues: false, mergeIntermediate: true}}};
    }}), /changed an agreed field: permissions\. The delivery mode belongs to the runner.*run --direct.*run --slices/);
    for (const requested of [undefined, {diagnostics: [], browserTools: []}]) {
      await assert.rejects(generatePlan(f.store, f.root, {...request, verification: requested}, {...f.client, async run() {
        return {outcome: 'passed', summary: 'Expanded grant', findings: [], plan: {...f.run.plan, verification: {diagnostics: [], browserTools: ['mcp__github__merge_pull_request']}}};
      }}), /changed an agreed field: verification/);
    }
    assert.equal(f.github.objects.size, 0);
  } finally {await f.dispose();}
});

test('PLAN returns its blocking question and resumes the same session with the owner decision', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, '.easy-skills'), {recursive: true});
    writeFileSync(join(f.root, '.easy-skills/project.yaml'), stringify(f.run.plan.project));
    const {featureId, title, spec, assignments, permissions, repairPolicy} = f.run.plan;
    const request = {featureId, title, spec, assignments, permissions, repairPolicy};
    const question = 'May the plan add a journal table to the legacy database?';
    const calls: {prompt: string; session?: string}[] = [];
    const client = {...f.client, async run(_a: unknown, prompt: string, o: {session?: string; onSession?: (s: string) => void}) {
      calls.push({prompt, session: o.session}); o.onSession?.('plan-session');
      return calls.length === 1 ? {outcome: 'blocked' as const, summary: 'One persistence decision is needed', question, findings: []}
        : {outcome: 'passed' as const, summary: 'Planned', findings: [], plan: f.run.plan};
    }};
    const blocked = await generatePlan(f.store, f.root, request, client).then(() => undefined, (error: unknown) => error);
    assert.ok(blocked instanceof PlanDecisionNeeded);
    assert.equal(blocked.question, question); assert.match(blocked.message, /Question: May the plan add a journal table/);
    const plan = await generatePlan(f.store, f.root, request, client, undefined, false, undefined, [{question, answer: 'Yes, additive only.'}]);
    assert.equal(plan.tasks.length, 2);
    assert.equal(calls[1]!.session, 'plan-session');
    assert.ok(calls[1]!.prompt.includes('Owner decisions on questions you asked earlier'));
    assert.ok(calls[1]!.prompt.includes('Yes, additive only.'));
    assert.ok(!calls[0]!.prompt.includes('Owner decisions'));
  } finally {await f.dispose();}
});

test('PLAN asks the same session once to correct a result that failed validation', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, '.easy-skills'), {recursive: true});
    writeFileSync(join(f.root, '.easy-skills/project.yaml'), stringify(f.run.plan.project));
    const {featureId, title, spec, assignments, permissions, repairPolicy} = f.run.plan;
    const request = {featureId, title, spec, assignments, permissions, repairPolicy};
    const calls: {prompt: string; session?: string}[] = [];
    const plan = await generatePlan(f.store, f.root, request, {...f.client, async run(_a, prompt, o) {
      calls.push({prompt, session: o.session});
      if (calls.length === 1) {o.onSession?.('plan-session'); throw new InvalidResult('tasks.0.scope.areas: Invalid input: expected array, received undefined');}
      return {outcome: 'passed', summary: 'Corrected', findings: [], plan: f.run.plan};
    }});
    assert.equal(plan.tasks.length, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.session, 'plan-session');
    assert.match(calls[1]!.prompt, /failed validation: tasks\.0\.scope\.areas/);
    assert.match(calls[0]!.prompt, /areas \(an array of identifiers, \[\] when none apply\)/);
    const again = {...request, title: title + ' again'};
    let attempts = 0;
    await assert.rejects(generatePlan(f.store, f.root, again, {...f.client, async run(_a, _p, o) {
      attempts++; o.onSession?.('second-session'); throw new InvalidResult('tasks.0.id: Required');
    }}), /failed validation \(tasks\.0\.id: Required\)/);
    assert.equal(attempts, 2);
  } finally {await f.dispose();}
});
