import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { initProject, updateProject } from '../../src/cli/project.js';
import { agreementProposal, applyAgreement, requireAgreement } from '../../src/runner/onboarding.js';
import { protectedManifest } from '../../src/runner/protected-inputs.js';
import { rulesHash } from '../../src/util.js';

test('draft onboarding and unresolved conflicts cannot approve a feature', async () => {
  const f = await fixture();
  try {
    for (const file of ['project.yaml', 'decisions/onboarding.json']) rmSync(join(f.root, '.easy-skills', file));
    const preview = await initProject(f.root, f.run.plan.project);
    await initProject(f.root, f.run.plan.project, preview.hash);
    const plan = {...f.run.plan, featureId: 'interview', protectedInputs: protectedManifest(f.root, f.run.plan.project), rulesHash: rulesHash(f.root)};
    const run = f.store.create(f.root, f.run.commonDir, plan);
    assert.throws(() => f.engine.approve(run.id, run.planHash), /onboarding|agreement/i);
    const draft = JSON.parse(readFileSync(join(f.root, '.easy-skills/decisions/onboarding.json'), 'utf8'));
    assert.throws(() => agreementProposal(f.root, {...draft, status: 'agreed'}), /unresolved/i);
    const ready = {...draft, status: 'agreed', decisions: draft.decisions.map((d: any) => ({...d, status: 'resolved', answer: 'Explicitly reviewed in fixture'})), conflicts: [], assumptions: []};
    const proposal = agreementProposal(f.root, ready);
    const agreed = applyAgreement(f.root, ready, proposal.hash);
    assert.equal(agreed.status, 'agreed');
    const current = f.store.create(f.root, f.run.commonDir, {...plan, featureId: 'new-rules', protectedInputs: protectedManifest(f.root, plan.project), rulesAgreement: requireAgreement(f.root)});
    writeFileSync(join(f.root, '.easy-skills/rules/architecture.md'), 'Changed after agreement');
    assert.throws(() => f.engine.approve(current.id, current.planHash), /rules|agreement/i);
  } finally {await f.dispose();}
});

test('project v2 update backs up configuration and requires new agreement without rewriting approved plans', async () => {
  const f = await fixture();
  try {
    f.engine.approve(f.run.id, f.run.planHash);
    const original = JSON.stringify(f.store.get(f.run.id).plan), configuration = {...f.run.plan.project, setup: [{id: 'setup', command: process.execPath, args: ['--version'], timeoutMs: 1000}]};
    const proposal = await updateProject(f.root, configuration);
    assert.ok('hash' in proposal);
    await updateProject(f.root, configuration, proposal.hash);
    assert.equal(JSON.stringify(f.store.get(f.run.id).plan), original);
    assert.throws(() => requireAgreement(f.root), /configuration changed/);
  } finally {await f.dispose();}
});
