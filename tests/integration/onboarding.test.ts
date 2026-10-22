import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { initProject } from '../../src/cli/project.js';
import { agreementProposal, applyAgreement } from '../../src/runner/onboarding.js';
import { rulesHash } from '../../src/util.js';

test('draft onboarding and unresolved conflicts cannot approve a feature', async () => {
  const f = await fixture();
  try {
    for (const file of ['project.yaml', 'decisions/onboarding.json']) rmSync(join(f.root, '.easy-skills', file));
    const preview = await initProject(f.root, f.run.plan.project);
    await initProject(f.root, f.run.plan.project, preview.hash);
    const plan = {...f.run.plan, featureId: 'interview', rulesHash: rulesHash(f.root)};
    const run = f.store.create(f.root, f.run.commonDir, plan);
    assert.throws(() => f.engine.approve(run.id, run.planHash), /onboarding|agreement/i);
    const draft = JSON.parse(readFileSync(join(f.root, '.easy-skills/decisions/onboarding.json'), 'utf8'));
    assert.throws(() => agreementProposal(f.root, {...draft, status: 'agreed'}), /unresolved/i);
    const ready = {...draft, status: 'agreed', decisions: draft.decisions.map((d: any) => ({...d, status: 'resolved', answer: 'Explicitly reviewed in fixture'})), conflicts: [], assumptions: []};
    const proposal = agreementProposal(f.root, ready);
    const agreed = applyAgreement(f.root, ready, proposal.hash);
    assert.equal(agreed.status, 'agreed');
    writeFileSync(join(f.root, '.easy-skills/rules/architecture.md'), 'Changed after agreement');
    assert.throws(() => f.engine.approve(run.id, run.planHash), /rules|agreement/i);
  } finally {await f.dispose();}
});
