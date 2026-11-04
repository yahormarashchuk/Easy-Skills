import { z } from 'zod';
import { Plan, type Stage, type Task } from '../contracts.js';
import { hash } from '../util.js';

/** Decisions one run may hand to the delegate; beyond this the owner is asked. */
export const MAX_DELEGATE_DECISIONS = 12;
/** One delegate request may take this long; a call that hangs is stopped and retried once. */
export const DELEGATE_TIMEOUT_MS = 8 * 60_000;
/** Acceptance criteria one amendment may remove, and amendments one run may make; beyond this the owner is asked. */
export const MAX_NARROW_REMOVALS = 2;
export const MAX_AMENDMENTS = 3;

export const DelegateReply = z.object({
  resolution: z.enum(['answer', 'escalate', 'narrow']),
  category: z.enum(['clarification', 'technical-choice', 'environment', 'narrow-scope', 'needs-owner']),
  answer: z.string().max(4000).default(''),
  rationale: z.string().max(1500).default(''),
  /** 0-based indexes into the acceptance list of the task the stage works on; only a "narrow" resolution may name any. */
  removeAcceptance: z.array(z.number().int().nonnegative()).max(20).default([]),
}).strict();
export type DelegateReply = z.infer<typeof DelegateReply>;

/** An answer that tells the agent to do any of these always goes to the owner, whatever the delegate says. */
const FORBIDDEN_ANSWER = /(?:--no-verify|--no-gpg-sign|--force\b|force[- ]push|push (?:to|directly to) main|merge (?:the|this) (?:pr|pull request)|bypass|disable (?:the )?(?:guard|check|checks|sandbox|hook|hooks|review)|skip (?:the )?(?:checks?|tests?|review|verify)|rm -rf|drop (?:database|table|schema)|delete (?:the )?backup)/i;

/** What a "narrow" resolution may change: the acceptance list of one task, and how many amendments the run has already used. */
export interface Narrowable {taskId: string; acceptance: string[]; amendments: number}

export function delegatePrompt(plan: Plan, stage: Stage, task: Task | undefined, question: string, summary: string, findings: string[], previous: string[], narrowable?: Narrowable): string {
  // A slice question is judged against that slice's paths; a whole-feature question against every approved path.
  const paths = task ? task.scope?.paths || [] : [...new Set(plan.tasks.flatMap(t => t.scope?.paths || []))];
  const narrow = narrowable && !narrowingRejected([], narrowable.acceptance, narrowable.amendments, true);
  return `You are the owner's delegate for an autonomous engineering run. The ${stage} agent stopped with a question and nobody is available to answer it. Decide it yourself when that is safe, otherwise escalate it to the owner. This is a READ-ONLY session: do not edit files or run commands that change anything.

Approved task: ${task?.title || plan.title}
${task && plan.tasks.length > 1 ? `Slice description: ${task.description}\nSlice acceptance: ${JSON.stringify(task.acceptance)}\n` : ''}Specification, acceptance criteria and exclusions:
${plan.spec}

Approved scope paths: ${JSON.stringify(paths)}
Approved checks: ${JSON.stringify(plan.project.checks.map(check => check.id))}
Permissions: ${JSON.stringify(plan.workflow?.mode === 'slices' ? {...plan.permissions, ...plan.workflow.permissions} : plan.permissions)}

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
${narrow ? `
You MAY narrow the plan (resolution "narrow", category "narrow-scope") ONLY when BOTH hold:
- the blocker is that one or two acceptance criteria below cannot be satisfied with the approved checks (listed above) and the evidence the runner records itself, for example because they require new verification tooling, result validators, provenance or manifests, or checks that are not configured;
- removing exactly those criteria keeps the behaviour the specification asks for covered by the remaining criteria.
Name them in "removeAcceptance" as 0-based indexes. Nothing else changes: paths, checks, permissions and the other criteria stay as approved. At most ${MAX_NARROW_REMOVALS} criteria, and at least one must remain.
NEVER narrow away a criterion about product behaviour, tenant, permission or studio isolation, data protection, "never skip tests", security, or anything the specification itself requires; escalate instead, and escalate whenever you are unsure.
Acceptance criteria of task "${narrowable!.taskId}" you may narrow:
${narrowable!.acceptance.map((text, index) => `${index}: ${text}`).join('\n')}
` : ''}
Return outcome "passed" with summary containing ONLY a JSON object: {"resolution":"answer"|"escalate"${narrow ? '|"narrow"' : ''},"category":"clarification"|"technical-choice"|"environment"|"narrow-scope"|"needs-owner","answer":"the exact instruction for the agent, concrete and self-contained, empty when escalating${narrow ? ' or narrowing' : ''}","rationale":"why this is safe and inside the approved scope, or why the owner must decide"${narrow ? ',"removeAcceptance":[indexes; only with "narrow", otherwise omit]' : ''}}. All output in English.`;
}

/** Why criteria may not be removed, or undefined when the runner's limits allow it. `probe` only asks whether any amendment is still possible. */
export function narrowingRejected(remove: number[], acceptance: string[], amendments: number, probe = false): string | undefined {
  if (amendments >= MAX_AMENDMENTS) return `The run already used its ${MAX_AMENDMENTS} plan amendments`;
  if (acceptance.length < 2) return 'The task has no acceptance criterion it could lose';
  if (probe) return undefined;
  if (!remove.length) return 'No criterion named';
  if (new Set(remove).size !== remove.length) return 'A criterion is named twice';
  if (remove.some(index => index >= acceptance.length)) return 'A named criterion does not exist';
  if (remove.length > MAX_NARROW_REMOVALS) return `More than ${MAX_NARROW_REMOVALS} criteria named`;
  if (remove.length >= acceptance.length) return 'At least one criterion must remain';
  return undefined;
}

/** The plan an amendment produces: the named criteria of one task disappear, and only the owner may also give that task a shorter description. */
export function narrowedPlan(plan: Plan, taskId: string, remove: number[], description?: string): Plan {
  return Plan.parse({...plan, tasks: plan.tasks.map(t => t.id === taskId ? {...t, acceptance: t.acceptance.filter((_, index) => !remove.includes(index)), ...(description === undefined ? {} : {description})} : t)});
}

/** Proof, independent of how the amended plan was built, that nothing but the named criteria (and a shorter description, when given) of one task changed. */
export function narrowingViolation(before: Plan, after: Plan, taskId: string, remove: number[], description?: string): string | undefined {
  const target = before.tasks.find(t => t.id === taskId);
  if (!target) return 'The task is not in the approved plan';
  const strip = (plan: Plan) => ({...plan, tasks: plan.tasks.map(t => t.id === taskId ? {...t, acceptance: [], description: ''} : t)});
  if (hash(strip(before)) !== hash(strip(after))) return 'The amendment changes more than acceptance criteria';
  const amended = after.tasks.find(t => t.id === taskId);
  if (hash(amended?.acceptance ?? null) !== hash(target.acceptance.filter((_, index) => !remove.includes(index))))
    return 'The amended criteria are not the approved ones minus the named';
  if (description === undefined ? amended?.description !== target.description : amended?.description !== description || !description.trim() || description.length > target.description.length)
    return 'The amended description is not the approved one, or a non-empty shorter replacement';
  return undefined;
}

/**
 * Parses the delegate's JSON and applies the rules that never depend on the model's judgment. Returns undefined to escalate.
 * A "narrow" resolution is accepted only when `narrowable` is given and the runner's limits on criteria and amendments hold.
 */
export function acceptDelegateReply(raw: string, asked: string[], question: string, narrowable?: Narrowable): DelegateReply | undefined {
  let parsed: unknown;
  try {parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));} catch {return undefined;}
  const reply = DelegateReply.safeParse(parsed);
  if (!reply.success) return undefined;
  const {resolution, category, answer, rationale, removeAcceptance} = reply.data;
  if (resolution === 'escalate' || category === 'needs-owner') return undefined;
  if (asked.includes(hash(question))) return undefined;
  if (resolution === 'narrow') {
    if (!narrowable || category !== 'narrow-scope' || !rationale.trim() || FORBIDDEN_ANSWER.test(answer)) return undefined;
    return narrowingRejected(removeAcceptance, narrowable.acceptance, narrowable.amendments) ? undefined : reply.data;
  }
  if (removeAcceptance.length || !answer.trim() || FORBIDDEN_ANSWER.test(answer)) return undefined;
  return reply.data;
}
