import { z } from 'zod';
import type { Plan, Stage } from '../contracts.js';
import { hash } from '../util.js';

/** Decisions one run may hand to the delegate; beyond this the owner is asked. */
export const MAX_DELEGATE_DECISIONS = 12;

export const DelegateReply = z.object({
  resolution: z.enum(['answer', 'escalate']),
  category: z.enum(['clarification', 'technical-choice', 'environment', 'narrow-scope', 'needs-owner']),
  answer: z.string().max(4000).default(''),
  rationale: z.string().max(1500).default(''),
}).strict();
export type DelegateReply = z.infer<typeof DelegateReply>;

/** An answer that tells the agent to do any of these always goes to the owner, whatever the delegate says. */
const FORBIDDEN_ANSWER = /(?:--no-verify|--no-gpg-sign|--force\b|force[- ]push|push (?:to|directly to) main|merge (?:the|this) (?:pr|pull request)|bypass|disable (?:the )?(?:guard|check|checks|sandbox|hook|hooks|review)|skip (?:the )?(?:checks?|tests?|review|verify)|rm -rf|drop (?:database|table|schema)|delete (?:the )?backup)/i;

export function delegatePrompt(plan: Plan, stage: Stage, taskTitle: string | undefined, question: string, summary: string, findings: string[], previous: string[]): string {
  const task = plan.tasks[0];
  return `You are the owner's delegate for an autonomous engineering run. The ${stage} agent stopped with a question and nobody is available to answer it. Decide it yourself when that is safe, otherwise escalate it to the owner. This is a READ-ONLY session: do not edit files or run commands that change anything.

Approved task: ${taskTitle || plan.title}
Specification, acceptance criteria and exclusions:
${plan.spec}

Approved scope paths: ${JSON.stringify(task?.scope?.paths || [])}
Approved checks: ${JSON.stringify(plan.project.checks.map(check => check.id))}
Permissions: ${JSON.stringify(plan.permissions)}

The agent's report:
Summary: ${summary}
Findings: ${JSON.stringify(findings)}
Question: ${question}
${previous.length ? 'Questions already answered in this run (never contradict them): ' + JSON.stringify(previous) : ''}

You MAY answer (resolution "answer") when the answer stays inside the approved task and rules:
- clarify a requirement, preferring what the specification and approved rules already say;
- choose between technical options the agent listed, taking the one that stays inside the plan and keeps data protection;
- tell the agent how to work around an environment limit that does not weaken any rule (for example the full path of a tool that is missing from PATH, a different shell, using a path the specification names);
- tell the agent to finish the part it can complete inside the approved scope and to record the remainder as follow-up work in its findings, instead of stopping.
You MUST escalate (resolution "escalate", category "needs-owner") when answering would:
- widen the approved paths, permissions, rules, models, checks, publication or merge rights, or change the specification or acceptance criteria;
- involve production systems, real hardware, real credentials or secrets, personal data, or any database or container other than a new disposable one;
- waive, weaken or reinterpret a data-protection, safety or approval-gate rule of the specification;
- delete or overwrite owner data, skip checks, skip review, push to main, or merge;
- need a fact only the owner has (names, identifiers, credentials, business, legal or money decisions);
- or you are not sure.
When in doubt, escalate: asking the owner is the safe default.

Return outcome "passed" with summary containing ONLY a JSON object: {"resolution":"answer"|"escalate","category":"clarification"|"technical-choice"|"environment"|"narrow-scope"|"needs-owner","answer":"the exact instruction for the agent, concrete and self-contained, empty when escalating","rationale":"why this is safe and inside the approved scope, or why the owner must decide"}. All output in English.`;
}

/** Parses the delegate's JSON and applies the rules that never depend on the model's judgment. Returns undefined to escalate. */
export function acceptDelegateReply(raw: string, asked: string[], question: string): DelegateReply | undefined {
  let parsed: unknown;
  try {parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));} catch {return undefined;}
  const reply = DelegateReply.safeParse(parsed);
  if (!reply.success) return undefined;
  const {resolution, category, answer} = reply.data;
  if (resolution !== 'answer' || category === 'needs-owner' || !answer.trim()) return undefined;
  if (FORBIDDEN_ANSWER.test(answer)) return undefined;
  if (asked.includes(hash(question))) return undefined;
  return reply.data;
}
