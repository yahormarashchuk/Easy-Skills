import type { Run } from '../contracts.js';
import type { Store } from '../persistence/store.js';
import { deliveryIssues } from './issue-history.js';

/** Long task prompts make poor PR titles; the planned task title says what the PR delivers. */
export function pullRequestTitle(run: Run): string {
  const task = run.plan.tasks[0]?.title;
  const title = run.plan.workflow?.issue || run.plan.title.length <= 90 || !task ? run.plan.title : task;
  return title.length > 120 ? title.slice(0, 117).replace(/\s+\S*$/, '') + '...' : title;
}

/**
 * What the PR delivers and what was verified, ahead of the approved task specification, which was written before the
 * work existed and describes it in future tense.
 */
export function pullRequestBody(store: Store, run: Run, head: string, change: string): string {
  const task = run.plan.tasks[0];
  const issues = run.plan.workflow?.issueHistory ? deliveryIssues(store, run) : run.parentIssue ? `Implements #${run.parentIssue}; stays open until final merge.` : 'Local task; no Issue created.';
  return [
    '## Summary', '', task?.title || run.plan.title, '', change ? `Change: ${change}` : '',
    '## Delivered (acceptance criteria)', '', ...(task?.acceptance || []).map(item => '- ' + item), '',
    '## Verification', '', `Verified revision: ${head}`, '', ...run.finalEvidence.map(e => `- ${e.checkId}: passed`), '',
    `Final review: ${run.finalReviewHead}`, 'Final merge: manual.', '',
    '## Issues', '', issues, '',
    '<details><summary>Approved task specification</summary>', '', run.plan.spec, '', '</details>',
  ].join('\n');
}
