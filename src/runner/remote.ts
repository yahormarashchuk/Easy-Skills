import { randomInt } from 'node:crypto';
import type { Run } from '../contracts.js';
import { Store } from '../persistence/store.js';
import { Gh, type GitHub } from '../github/index.js';
import { Engine } from './engine.js';
import { mailTransport, settings } from '../notifications/index.js';

export type RemoteCommand = {action: 'status' | 'pause' | 'resume' | 'stop'; runId: string; planHash: string} |
  {action: 'answer'; runId: string; planHash: string; request: string; answer: string} |
  {action: 'confirm'; runId: string; planHash: string; request: string; head: string; code: string};
export function parseCommand(body: string): RemoteCommand | undefined {
  const answer = body.trim().match(/^\/easy-skills answer ([a-f0-9-]{36}) ([a-f0-9]{64}) ([a-f0-9-]{36}) ("[^\r\n]*")$/);
  if (answer) {
    try {
      const value = JSON.parse(answer[4]!);
      if (typeof value === 'string' && value.length > 0 && value.length <= 10_000)
        return {action: 'answer', runId: answer[1]!, planHash: answer[2]!, request: answer[3]!, answer: value};
    } catch { /* Invalid JSON is not a command. */ }
  }
  const match = body.trim().match(/^\/easy-skills (status|pause|resume|stop) ([a-f0-9-]{36}) ([a-f0-9]{64})$/);
  if (match) return {action: match[1] as 'status', runId: match[2]!, planHash: match[3]!};
  const confirm = body.trim().match(/^\/easy-skills confirm ([a-f0-9-]{36}) ([a-f0-9]{64}) ([a-f0-9-]{36}) ([a-f0-9]{40,64}) ([0-9]{8})$/);
  if (confirm) return {action: 'confirm', runId: confirm[1]!, planHash: confirm[2]!, request: confirm[3]!, head: confirm[4]!, code: confirm[5]!};
  return undefined;
}
export function answerDecision(store: Store, runId: string, request: string, answer: string): void {
  if (!answer || answer.length > 10_000) throw new Error('Answer must contain 1–10000 characters');
  const owner = store.acquire('run:' + runId);
  try {
    const run = store.get(runId), pending = run.pendingDecision;
    if (run.status !== 'needs_decision' || !pending || pending.id !== request || pending.planHash !== run.planHash || pending.answer)
      throw new Error('Decision request is stale, missing, or already answered');
    pending.answer = answer;
    store.save(run, 'decision.answered', {request});
    store.recordOperation(`${run.id}:resume-request`, run.id, 'decision.resume', {resume: true});
  } finally {store.release('run:' + runId, owner);}
}
export async function requestMergeDecision(store: Store, run: Run): Promise<string> {
  if (run.status !== 'ready' || !run.finalReviewHead) throw new Error('Feature is not ready for a merge decision');
  const smtp = settings(store).smtp;
  if (!smtp) throw new Error('Configure and verify SMTP before requesting a remote merge decision');
  const code = String(randomInt(10_000_000, 100_000_000));
  const id = store.createDecision(run, run.finalReviewHead, 'final-merge', code);
  // The code is never added to agent context, state events, notification outbox, or CLI output.
  await mailTransport(smtp).sendMail({from: {name: 'Easy Skills', address: smtp.from}, to: smtp.to,
    subject: `[Easy Skills][${run.plan.project.name}][${run.plan.title}] Decision required`,
    text: `Review ${run.finalPr?.url}\n\nTo authorize this exact revision within 15 minutes, post this command to the parent Issue:\n\n/easy-skills confirm ${run.id} ${run.planHash} ${id} ${run.finalReviewHead} ${code}\n\nSingle-use request; do not share the code with an agent.`});
  return id;
}
export async function pollRemote(store: Store, run: Run, engine: Engine, github?: GitHub): Promise<void> {
  const config = settings(store).remote;
  if (!config || !run.parentIssue) return;
  const gh = github || new Gh(run.plan.project.repository, run.root);
  for (const comment of await gh.comments(run.parentIssue)) {
    const key = `${run.id}:remote:${comment.id}`;
    if (store.operation(key)) continue;
    const command = parseCommand(comment.body);
    // Ordinary discussion is never executable input.
    if (!command) continue;
    store.recordOperation(key, run.id, 'remote.received', {received: true});
    if (!config.allowedAuthors.includes(comment.author) || command.runId !== run.id || command.planHash !== run.planHash) {
      store.event(run.id, 'remote.rejected', {comment: comment.id}); continue;
    }
    try {
      if (command.action === 'pause' || command.action === 'stop') engine.requestControl(run.id, command.action);
      else if (command.action === 'resume') {
        // Resume cannot approve a draft, replace its model, or expand permissions.
        if (!['paused', 'waiting_quota', 'needs_decision'].includes(store.get(run.id).status)) throw new Error('Run is not resumable');
        store.recordOperation(`${run.id}:resume-request`, run.id, 'remote.resume', {resume: true});
      } else if (command.action === 'answer') {
        answerDecision(store, run.id, command.request, command.answer);
      } else if (command.action === 'confirm') {
        store.consumeDecision(command.request, store.get(run.id), command.head, 'final-merge', command.code);
        await engine.confirmFinalMerge(run.id, command.head);
      } else await gh.commentOnce(run.parentIssue, key + ':status', `Easy Skills state: ${store.get(run.id).status}; plan ${run.planHash}.`);
      store.event(run.id, 'remote.applied', {comment: comment.id, action: command.action});
    } catch {store.event(run.id, 'remote.rejected', {comment: comment.id, action: command.action});}
  }
}
