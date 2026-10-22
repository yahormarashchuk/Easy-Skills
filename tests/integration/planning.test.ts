import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { fixture } from '../helpers.js';
import { generatePlan } from '../../src/runner/planning.js';

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
    assert.equal(f.github.objects.size, 0);
  } finally {await f.dispose();}
});
