import type { Run, Status } from '../contracts.js';
import type { Store } from '../persistence/store.js';
import { stageBanner } from './presentation.js';

interface Output {write(text: string): unknown; columns?: number; rows?: number}
export interface Style {color: boolean; unicode: boolean}

/**
 * A followed run stops being watched only once nothing can change it any more. A run waiting for the owner stays on
 * screen with the command that continues it: closing the view there looked like the terminal quitting by itself.
 */
const settled: Status[] = ['draft', 'merged', 'abandoned', 'stopped'];
const attention: Status[] = ['needs_decision', 'paused'];
const finished: Status[] = ['merged', 'abandoned'];
const RECENT = 8;

export const stageOf = (run: Run) => run.tasks.find(t => !t.integrated)?.cursor || run.finalPhase;
/** The short reference that status, watch and resume accept. */
export const reference = (run: Run) => run.plan.workflow?.issue ? '#' + run.plan.workflow.issue : run.plan.featureId;

export function summary(run: Run, style: Style) {
  return `${run.plan.workflow?.issue ? 'Task #' + run.plan.workflow.issue : run.plan.title}: ${run.status}\n` +
    (run.plan.workflow?.mode === 'slices' ? `Slices merged into ${run.branch}: ${run.tasks.filter(t => t.integrated).length}/${run.tasks.length}` +
      (run.tasks.find(t => !t.integrated) ? `; current slice: ${run.tasks.find(t => !t.integrated)!.id}` : '') + '\n' : '') +
    (run.status === 'ready' ? `Ready for review: ${run.finalPr?.url}\nChecks: passed at ${run.finalReviewHead}\nReview: passed. Final merge: manual.` : stageBanner(stageOf(run), 'current', style.color, style.unicode)) +
    (run.reason ? '\n' + run.reason : '') + (run.pendingDecision ? '\nDecision: ' + run.pendingDecision.question : '') +
    (nextStep(run) ? '\n\n' + (attention.includes(run.status) ? '>>> YOUR ACTION: ' : 'Next: ') + nextStep(run) : '');
}

/** The one command that moves a run forward, or what it waits for; undefined while it works by itself. */
export function nextStep(run: Run): string | undefined {
  const ref = reference(run);
  if (run.status === 'needs_decision') {
    if (run.pendingDecision && !run.pendingDecision.answer) return `easy-skills answer ${run.id} --request ${run.pendingDecision.id} --value "your answer"`;
    if (/repair limit reached/i.test(run.reason || '')) return `easy-skills adopt-config ${ref} --extra-repairs 2  (allows two more repair attempts)`;
    return `resolve the reason above, then easy-skills resume ${ref}`;
  }
  if (run.status === 'paused') return `easy-skills resume ${ref}`;
  if (['waiting_quota', 'waiting_external', 'waiting_resource'].includes(run.status))
    return 'nothing; it retries by itself' + (run.retryAt ? ' at ' + new Date(run.retryAt).toLocaleTimeString() : '');
  if (run.status === 'ready') return 'review and merge the pull request yourself; Easy Skills never merges it';
  return undefined;
}

export function ago(time: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(time)) / 1000));
  return seconds < 60 ? seconds + 's ago' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : seconds < 86400 ? Math.floor(seconds / 3600) + 'h ago' : Math.floor(seconds / 86400) + 'd ago';
}

/** Owner-readable activity; process bookkeeping is left out. */
export function describe(type: string, data: Record<string, any>): string | undefined {
  switch (type) {
    case 'check.started': return `Check ${data.check}${data.baseline ? ' (baseline)' : ''} started`;
    case 'check.finished': return `Check ${data.checkId} ${data.code === 0 ? 'passed' : 'failed (exit ' + data.code + ')'}`;
    case 'setup.child.started': return `Setup ${data.command} started`;
    case 'client.started': return `${data.stage || 'AI'} step started${data.task ? ' for ' + data.task : ''}`;
    case 'client.exited': return 'AI step finished';
    case 'run.started': return 'Run started';
    case 'integration.created': return 'Task branch created';
    case 'direct.built': return 'BUILD finished';
    case 'feature.verified': return 'VERIFY passed';
    case 'feature.reviewed': return 'REVIEW passed';
    case 'feature.ready': return 'Pull request ready' + (data.pr?.url ? ': ' + data.pr.url : '');
    case 'task.repair': case 'feature.repair': return `Repair attempt ${data.count}${data.reason ? ': ' + data.reason : ''}`;
    case 'run.suspended': return 'Stopped: ' + (data.reason || data.status || 'see status');
    case 'decision.requested': return 'Your decision is needed: see the question and the command above';
    case 'decision.delegated': return `The delegate answered a ${data.stage || ''} question without you: ${data.question || ''}`.trim();
    case 'plan.narrowed': {
      const removed: string[] = Array.isArray(data.removed) ? data.removed : [];
      return `The delegate removed ${data.removedCount ?? removed.length} acceptance criteri${(data.removedCount ?? removed.length) === 1 ? 'on' : 'a'}${data.task ? ' of ' + data.task : ''} that the approved checks cannot verify, without you: ${removed.join('; ')}`.trim();
    }
    case 'decision.escalated': return 'The delegate left a question to you';
    case 'setup.child.exited': case 'client.session': case 'control.applied': case 'control.requested': case 'draft.created': return undefined;
    default: return type.replace(/[._]/g, ' ');
  }
}

export function activity(store: Store, id: string, limit = RECENT): string[] {
  const lines: string[] = [];
  for (const event of store.events(id) as {time: string; type: string; data: string}[]) {
    const text = describe(event.type, JSON.parse(event.data || '{}'));
    if (text) lines.push(`${new Date(event.time).toLocaleTimeString()}  ${text}`);
  }
  return lines.slice(-limit);
}

/** Every task of the repository: those waiting for the owner first, then active, then finished. */
export function taskTable(runs: Run[], now = Date.now()): string {
  if (!runs.length) return 'No tasks in this repository. Use easy-skills run to create one.';
  const rank = (run: Run) => attention.includes(run.status) ? 0 : finished.includes(run.status) ? 2 : 1;
  const rows = [...runs].sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map(run => [reference(run), run.id.slice(0, 8), stageOf(run), run.status, ago(run.updatedAt, now), run.plan.title]);
  const header = ['ID', 'RUN', 'STAGE', 'STATUS', 'UPDATED', 'TASK'];
  const widths = header.slice(0, -1).map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  return [header, ...rows].map(row => row.map((cell, i) => i < widths.length ? cell.padEnd(widths[i]!) : cell).join('  ')).join('\n');
}

/** Redraws a block in place, the way ActivityView does, so a terminal shows one current view instead of a scrolling log. */
class Screen {
  private drawn = 0;
  constructor(private readonly out: Output) {}
  draw(text: string) {
    const width = Math.max(20, (this.out.columns || 100) - 1), height = Math.max(5, (this.out.rows || 40) - 1);
    // Lines must never wrap or exceed the window, or moving the cursor up would not reach the top of the block. A long plain
    // line (a reason, a question) is split into several lines instead of cut: the owner needs all of it to decide.
    const fit = (block: string) => block.split('\n').flatMap(line => visible(line) <= width ? [line]
      : line.includes('\u001b') ? [line.slice(0, width - 3) + '...'] : wrap(line, width));
    // The status block with the owner's action stays on screen; only the oldest recent activity is dropped when the window is short.
    const split = text.indexOf('\n\nRecent activity:'), head = fit(split < 0 ? text : text.slice(0, split)), tail = split < 0 ? [] : fit(text.slice(split));
    const lines = head.length >= height ? head.slice(-height) : [...head, ...tail.slice(-(height - head.length))];
    this.out.write((this.drawn > 1 ? `\u001b[${this.drawn - 1}A` : '') + '\r' + lines.map(line => '\u001b[2K' + line).join('\n') + '\u001b[J');
    this.drawn = lines.length;
  }
  end(text = '') {this.out.write('\n' + (text ? text + '\n' : '')); this.drawn = 0;}
}
const visible = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '').length;
/** Splits a plain line at spaces where possible, so no piece is longer than the window. */
function wrap(line: string, width: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > width) {
    // Break at the last space so a word stays whole; only a word longer than the window is cut.
    const cut = rest.lastIndexOf(' ', width), at = cut > 0 ? cut : width;
    pieces.push(rest.slice(0, at).trimEnd()); rest = rest.slice(at).trimStart();
  }
  return [...pieces, rest.trimEnd()];
}

export interface WatchOptions {style: Style; out?: Output; intervalMs?: number; signal?: AbortSignal; now?: () => number}

/**
 * Follows one run until it finishes for good, also while it waits for the owner. Ctrl+C only stops watching: the detached worker owns the run,
 * so closing this terminal never stops it.
 */
export async function watchRun(store: Store, id: string, options: WatchOptions): Promise<Run> {
  return follow(options, () => {
    const run = store.get(id);
    const view = summary(run, options.style) + '\n\nRecent activity:\n' + (activity(store, id).map(line => '  ' + line).join('\n') || '  (none yet)') +
      `\n\nUpdated ${new Date(options.now?.() ?? Date.now()).toLocaleTimeString()}. Ctrl+C stops watching; the task keeps running.`;
    return {view, done: settled.includes(run.status), result: run, hint: `Watch again: easy-skills status ${reference(run)}`};
  });
}

/** Follows every task of the repository until Ctrl+C, or until all of them have finished for good. */
export async function watchTasks(store: Store, root: string, options: WatchOptions): Promise<Run[]> {
  return follow(options, () => {
    const runs = store.list().filter(run => run.root === root && !finished.includes(run.status));
    const view = taskTable(runs, options.now?.()) + '\n\nDetails of one task: easy-skills status ID. Ctrl+C stops watching; tasks keep running.';
    return {view, done: runs.every(run => settled.includes(run.status)), result: runs, hint: 'Watch again: easy-skills status'};
  });
}

async function follow<T>(options: WatchOptions, read: () => {view: string; done: boolean; result: T; hint: string}): Promise<T> {
  const screen = new Screen(options.out || process.stdout), controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop);
  process.once('SIGINT', stop);
  try {
    for (;;) {
      const state = read();
      screen.draw(state.view);
      if (state.done) {screen.end(); return state.result;}
      if (controller.signal.aborted) {screen.end('Stopped watching. ' + state.hint); return state.result;}
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, options.intervalMs ?? 2000);
        controller.signal.addEventListener('abort', () => {clearTimeout(timer); resolve();}, {once: true});
      });
    }
  } finally {process.removeListener('SIGINT', stop); options.signal?.removeEventListener('abort', stop);}
}
