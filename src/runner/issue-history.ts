import type { Run } from '../contracts.js';
import type { GitHub } from '../github/index.js';
import type { Store } from '../persistence/store.js';
import { cleanExcerpt } from './check-failure.js';
import { repairKey, type Repair } from './repairs.js';

export function issueLabels(run: Run, bug: boolean): string[] {
  const paths = run.plan.tasks.flatMap(task => task.scope?.paths || []).join(' ');
  const kind = bug || /\b(?:fix|bug|regression|failure|broken)\b/i.test(run.plan.title) ? 'bug' : 'enhancement';
  return [...new Set([kind, ...(paths + ' ' + run.plan.title).split(/[^\p{L}\p{N}]+/u).filter(Boolean)])];
}
/** The feature milestone of a sliced run, created once at approval; other workflows have none. */
export const milestoneKey = (run: Run) => `${run.id}:milestone`;
export function milestone(store: Store, run: Run): number | undefined {return store.operation<number>(milestoneKey(run));}
export async function publishRepairIssue(store: Store, run: Run, github: GitHub, repair: Repair): Promise<number | undefined> {
  if (!run.plan.workflow?.issueHistory) return;
  const key = `${run.id}:repair-issue:${repair.id}`;
  const saved = store.operation<number>(key);
  if (saved) return saved;
  // A slice failure belongs to that slice: the Issue names it, links its Issue and is closed when the repaired slice merges.
  const slice = repair.scope.startsWith('task:') ? run.tasks.find(t => repair.scope === `task:${t.id}`) : undefined;
  const task = slice && run.plan.tasks.find(t => t.id === slice.id);
  const body = `## Trigger / current behavior\n\n${cleanExcerpt(repair.reason, store.home)}\n\n## Evidence\n\n` +
    `Run: ${run.id}\nStage: ${repair.failedStage}\nRevision: ${repair.head}\nParent: #${run.parentIssue}\n${slice?.issue ? `Slice: #${slice.issue}\n` : ''}\n` +
    (repair.bundle ? '```json\n' + cleanExcerpt(JSON.stringify(repair.bundle, null, 2), store.home) + '\n```' : 'See the stage findings above.') +
    `\n\n## Expected behavior / acceptance criteria\n\n- Fix the reported failure within the approved ${task ? 'slice' : 'task'} scope.\n- Pass the affected checks and independent VERIFY and REVIEW without weakening assertions.\n- Link the verified revision and ${task ? 'slice' : 'delivery'} PR before closure.\n\n## Scope\n\n${task ? task.title : run.plan.tasks.map(t => t.title).join('\n')}`;
  // The title names the stage that sent the work back to BUILD, so the Issue list reads as the task's history.
  const number = await github.issue(key, `Bug (${task ? task.id + ' ' : ''}${repair.failedStage}): ${cleanExcerpt(repair.reason, store.home).replace(/[\r\n]+/g, ' ').slice(0, 160)}`, body,
    {labels: issueLabels(run, true), assignSelf: true, ...(milestone(store, run) ? {milestone: milestone(store, run)} : {})});
  store.recordOperation(key, run.id, 'github.repair.created', number);
  return number;
}
/** Every whole-feature repair of the run, including those an owner-approved new plan moved out of the repair limit. */
export function allRepairs(store: Store, run: Run): Repair[] {
  const key = repairKey(run, 'feature'), seen = new Set<string>();
  const superseded = (store.events(run.id) as {type: string; data: string}[]).filter(event => event.type === 'plan.configuration.adopted')
    .flatMap(event => store.operation<Repair[]>(`${key}:superseded:${JSON.parse(event.data || '{}').previous}`) || []);
  return [...superseded, ...(store.operation<Repair[]>(key) || [])].filter(repair => !seen.has(repair.id) && !!seen.add(repair.id));
}
export function repairIssues(store: Store, run: Run): number[] {
  return allRepairs(store, run).map(repair =>
    store.operation<number>(`${run.id}:repair-issue:${repair.id}`)).filter((number): number is number => number !== undefined);
}
/** Bug Issues published for one slice's repairs, including repairs a new plan moved out of the limit. */
export function sliceRepairIssues(store: Store, run: Run, taskId: string): number[] {
  const key = repairKey(run, `task:${taskId}`);
  const superseded = (store.events(run.id) as {type: string; data: string}[]).filter(event => event.type === 'plan.configuration.adopted')
    .flatMap(event => store.operation<Repair[]>(`${key}:superseded:${JSON.parse(event.data || '{}').previous}`) || []);
  return [...new Set([...superseded, ...(store.operation<Repair[]>(key) || [])].map(repair =>
    store.operation<number>(`${run.id}:repair-issue:${repair.id}`)).filter((number): number is number => number !== undefined))];
}
export function deliveryIssues(store: Store, run: Run): string {
  const slices = run.plan.workflow?.mode === 'slices' ? run.tasks.flatMap(t => [t.issue, ...sliceRepairIssues(store, run, t.id)]) : [];
  return [...new Set([run.parentIssue, ...slices, ...repairIssues(store, run)].filter((number): number is number => number !== undefined))]
    .map(number => `${run.plan.workflow?.permissions.closeIssueOnMerge ? 'Fixes' : 'Refs'} #${number}`).join('\n');
}
export async function closeRepairIssues(store: Store, run: Run, github: GitHub, url: string) {
  if (!run.plan.workflow?.issueHistory || !run.plan.workflow.permissions.closeIssueOnMerge) return;
  for (const issue of repairIssues(store, run)) await github.setIssue(issue, false, `Verified delivery merged: ${url}`);
}
