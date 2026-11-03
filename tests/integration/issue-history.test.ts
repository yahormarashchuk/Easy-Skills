import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.js';
import { publishRepairIssue, deliveryIssues } from '../../src/runner/issue-history.js';
import { startRepair, CodeFailure } from '../../src/runner/repairs.js';
import { Gh } from '../../src/github/index.js';

test('repair history publishes evidence before repair, survives retries and links closure to delivery', async () => {
  const f = await fixture();
  try {
    f.run.plan.workflow = {mode: 'direct', issueHistory: true, baseHead: 'a'.repeat(40), context: {},
      permissions: {pushBranch: true, createPullRequest: true, closeIssueOnMerge: true}};
    f.run.parentIssue = 50;
    const repair = startRepair(f.store, f.run, 'feature', 'VERIFY', 'b'.repeat(40), new CodeFailure('Snapshot requests overlap'));
    let calls = 0;
    const github = {...f.github, async issue(_key: string, title: string, body: string, metadata?: {labels: string[]; assignSelf: boolean}) {
      calls++; assert.match(title, /Snapshot requests overlap/); assert.match(body, /Trigger \/ current behavior/);
      assert.match(body, /Acceptance|acceptance/); assert.match(body, /Parent: #50/);
      assert.match(body, /b{40}/); assert.equal(metadata?.assignSelf, true); assert.ok(metadata?.labels.includes('bug'));
      return 51;
    }};
    // Only issue() is used by this helper; the fixture retains the complete GitHub interface.
    await publishRepairIssue(f.store, f.run, Object.assign(Object.create(f.github), github), repair);
    await publishRepairIssue(f.store, f.run, f.github, repair);
    assert.equal(calls, 1); assert.equal(deliveryIssues(f.store, f.run), 'Fixes #50\nFixes #51');
    f.run.plan.workflow.issueHistory = undefined;
    assert.equal(await publishRepairIssue(f.store, f.run, f.github, repair), undefined);
  } finally {await f.dispose();}
});

test('Issue metadata uses the authenticated author and only existing case-insensitive repository labels', async () => {
  const gh = new Gh('test/example', '.', async (command, options) => {
    const path = command.args[3];
    let value: unknown;
    if (path?.includes('issues?')) value = [];
    else if (path?.includes('labels?')) value = [{name: 'Bug'}, {name: 'Blazor'}];
    else if (path?.endsWith('issue-types')) value = [{name: 'Bug', is_enabled: true}];
    else if (command.args.includes('user')) value = {login: 'fixture-owner'};
    else {
      const body = JSON.parse(String(options.input));
      assert.deepEqual(body.labels, ['Bug', 'Blazor']); assert.deepEqual(body.assignees, ['fixture-owner']);
      assert.equal(body.type, 'Bug');
      assert.match(body.body, /easy-skills:stable/); value = {number: 42};
    }
    return {code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false};
  });
  assert.equal(await gh.issue('stable', 'Bug: snapshot', 'Reproduction and acceptance', {labels: ['bug', 'blazor', 'missing'], assignSelf: true}), 42);
});
