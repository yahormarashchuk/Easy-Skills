import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { fixture } from '../helpers.js';
import { generatePlan } from '../../src/runner/planning.js';
import { InvalidResult } from '../../src/adapters/index.js';

test('PLAN uses the selected model read-only and cannot expand agreed permissions', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, '.easy-skills'), {recursive: true});
    writeFileSync(join(f.root, '.easy-skills/project.yaml'), stringify(f.run.plan.project));
    const {featureId, title, spec, assignments, permissions} = f.run.plan;
    const request = {featureId, title, spec, assignments, permissions};
    let model = '', mode: string | undefined;
    const plan = await generatePlan(f.store, f.root, request, {...f.client, async run(a, p, o) {
      model = a.model; mode = o.mode; assert.match(p, /UNAPPROVED, READ-ONLY/);
      return {outcome: 'passed', summary: 'Planned', findings: [], plan: f.run.plan};
    }});
    assert.equal(model, assignments.PLAN.model); assert.equal(mode, 'read'); assert.equal(plan.tasks.length, 2);
    await assert.rejects(generatePlan(f.store, f.root, request, {...f.client, async run() {
      return {outcome: 'passed', summary: 'Unsafe draft', findings: [], plan: {...f.run.plan, permissions: {publishIssues: false, mergeIntermediate: true}}};
    }}), /changed an agreed field: permissions/);
    for (const requested of [undefined, {diagnostics: [], browserTools: []}]) {
      await assert.rejects(generatePlan(f.store, f.root, {...request, verification: requested}, {...f.client, async run() {
        return {outcome: 'passed', summary: 'Expanded grant', findings: [], plan: {...f.run.plan, verification: {diagnostics: [], browserTools: ['mcp__github__merge_pull_request']}}};
      }}), /changed an agreed field: verification/);
    }
    assert.equal(f.github.objects.size, 0);
  } finally {await f.dispose();}
});

test('PLAN asks the same session once to correct a result that failed validation', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, '.easy-skills'), {recursive: true});
    writeFileSync(join(f.root, '.easy-skills/project.yaml'), stringify(f.run.plan.project));
    const {featureId, title, spec, assignments, permissions} = f.run.plan;
    const request = {featureId, title, spec, assignments, permissions};
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
