import { z } from 'zod';

export const VERSION = '0.1.0-alpha.2';
export const Stage = z.enum(['DEFINE', 'PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SHIP']);
export type Stage = z.infer<typeof Stage>;
export const Provider = z.enum(['codex', 'claude-code']);
export type Provider = z.infer<typeof Provider>;
export const Identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const Assignment = z.object({
  provider: Provider,
  model: z.string().min(1).max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
  effort: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.provider === 'claude-code' && ['default', 'best', 'sonnet', 'opus', 'haiku', 'fable', 'opusplan'].includes(value.model))
    ctx.addIssue({code: 'custom', message: 'Use an exact Claude model ID; mutable aliases and hybrid routing are not permitted'});
  if (value.provider === 'claude-code' && value.effort !== undefined)
    ctx.addIssue({code: 'custom', message: 'Reasoning effort is not supported for Claude Code assignments'});
});
export type Assignment = z.infer<typeof Assignment>;
export const Assignments = z.object({
  DEFINE: Assignment, PLAN: Assignment, BUILD: Assignment,
  VERIFY: Assignment, REVIEW: Assignment, SHIP: Assignment,
}).strict();
export const Check = z.object({
  id: Identifier, command: z.string().min(1), args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(100).max(3_600_000).default(300_000),
  resource: z.string().min(1).optional(),
}).strict();
export type Check = z.infer<typeof Check>;
export const MergePolicy = z.object({mode: z.enum(['strict', 'queue']), requiredChecks: z.array(z.object({
  name: z.string().min(1), appId: z.number().int().positive().optional(),
}).strict()).min(1)}).strict();
export type MergePolicy = z.infer<typeof MergePolicy>;
export const Project = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), name: z.string().min(1),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  mainBranch: z.string().min(1), remote: z.literal('origin').default('origin'),
  githubTransport: z.literal('gh'), checks: z.array(Check).min(1),
  mergePolicy: MergePolicy.optional(),
  setup: z.array(Check).optional(),
  protectedInputs: z.array(z.string().min(1)).optional(),
}).strict();
export type Project = z.infer<typeof Project>;
export const Task = z.object({
  id: Identifier, title: z.string().min(1), description: z.string().min(1),
  dependsOn: z.array(Identifier).default([]), acceptance: z.array(z.string().min(1)).min(1),
  scope: z.object({areas: z.array(Identifier), paths: z.array(z.string().min(1).refine(p => !p.startsWith('/') && !p.includes('..') && !p.includes(':') && !p.includes('\\'), 'Use repository-relative POSIX paths'))}).strict().optional(),
}).strict();
export type Task = z.infer<typeof Task>;
// Optional on legacy plans: adding this field must never rewrite an old approval.
export const DirectWorkflow = z.object({mode: z.literal('direct'), issue: z.number().int().positive().optional(),
  baseHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  permissions: z.object({pushBranch: z.boolean(), createPullRequest: z.boolean(), closeIssueOnMerge: z.boolean()}).strict(),
  context: z.record(z.string().regex(/^\.easy-skills\/(?:rules\/[^:]+|context\/[^:]+|project\.yaml|decisions\/onboarding\.json)$/)
    .refine(p => !p.includes('..') && !p.includes('\\')), z.string()),
}).strict();
export const Plan = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), featureId: Identifier, title: z.string().min(1),
  spec: z.string().min(1), project: Project, assignments: Assignments,
  tasks: z.array(Task).min(1), rulesHash: z.string().regex(/^[a-f0-9]{64}$/),
  rulesAgreement: z.object({version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
  runnerVersion: z.enum(['0.1.0-alpha.1', VERSION]), skillsVersion: z.enum(['0.1.0-alpha.1', VERSION]),
  repairPolicy: z.object({maxCompletedAttempts: z.number().int().min(0).max(100)}).strict().optional(),
  protectedInputs: z.record(z.string(), z.string().nullable()).optional(),
  permissions: z.object({publishIssues: z.boolean(), mergeIntermediate: z.boolean()}).strict(),
  verification: z.object({diagnostics: z.array(Identifier), browserTools: z.array(z.string().regex(/^mcp__[\w-]+__[\w-]+$/))}).strict().optional(),
  workflow: DirectWorkflow.optional(),
}).strict().superRefine((plan, ctx) => {
  if (plan.workflow && (plan.tasks.length !== 1 || plan.tasks[0]?.dependsOn.length || plan.permissions.mergeIntermediate || plan.permissions.publishIssues))
    ctx.addIssue({code: 'custom', message: 'Direct tasks require one independent task and prohibit Issue creation and intermediate merges'});
  if (plan.workflow && !plan.tasks[0]?.scope?.paths.length)
    ctx.addIssue({code: 'custom', message: 'Direct tasks require explicit implementation and test scope paths'});
  if (plan.schemaVersion === 2 && (!plan.repairPolicy || !plan.protectedInputs || plan.project.schemaVersion !== 2))
    ctx.addIssue({code: 'custom', message: 'Plan v2 requires project v2, an explicit repair policy and protected verification manifest'});
  const ids = new Set(plan.tasks.map(t => t.id));
  if (ids.size !== plan.tasks.length) ctx.addIssue({code: 'custom', message: 'Duplicate task IDs'});
  if (new Set(plan.project.checks.map(c => c.id)).size !== plan.project.checks.length)
    ctx.addIssue({code: 'custom', message: 'Duplicate check IDs'});
  for (const id of plan.verification?.diagnostics || []) if (!plan.project.checks.some(c => c.id === id)) ctx.addIssue({code: 'custom', message: 'Unknown VERIFY diagnostic: ' + id});
  const completed = new Set<string>();
  let rest = [...plan.tasks];
  while (rest.length) {
    const ready = rest.filter(t => t.dependsOn.every(id => completed.has(id)));
    if (!ready.length) {ctx.addIssue({code: 'custom', message: 'Cyclic or unknown task dependencies'}); break;}
    ready.forEach(t => completed.add(t.id));
    rest = rest.filter(t => !completed.has(t.id));
  }
});
export type Plan = z.infer<typeof Plan>;
export const StageResult = z.object({
  outcome: z.enum(['passed', 'blocked', 'failed']), summary: z.string().min(1),
  findings: z.array(z.string()),
  question: z.string().min(1).optional(),
  plan: Plan.optional(),
}).strict();
export type StageResult = z.infer<typeof StageResult>;
export interface Evidence { checkId: string; head: string; code: number; finishedAt: string; log: string }
export interface PullRequest { number: number; url: string; headRefOid: string; baseRefOid?: string; state: string; mergedAt: string | null; baseRefName: string; headRefName: string }
export type Cursor = 'BUILD' | 'REPAIR' | 'VERIFY' | 'REVIEW' | 'SHIP' | 'INTEGRATE';
export interface TaskState {
  id: string; integrated: boolean; cursor: Cursor; issue?: number; pr?: PullRequest;
  worktree?: string; branch?: string; head?: string; evidence: Evidence[];
  reviewHead?: string; sessions: Partial<Record<Stage, string>>;
}
export type Status = 'draft' | 'approved' | 'running' | 'waiting_quota' | 'waiting_resource' | 'waiting_external' | 'needs_decision' | 'paused' | 'stopped' | 'ready' | 'merged' | 'abandoned';
export interface Run {
  id: string; root: string; commonDir: string; plan: Plan; planHash: string;
  revision: number; status: Status; createdAt: string; updatedAt: string;
  approvedHash?: string; branch: string; worktree?: string; parentIssue?: number;
  tasks: TaskState[]; finalPr?: PullRequest;
  finalPhase: 'SYNC' | 'REPAIR' | 'VERIFY' | 'REVIEW' | 'SHIP'; finalEvidence: Evidence[];
  finalReviewHead?: string; syncedBase?: string; finalSessions: Partial<Record<Stage, string>>;
  childPid?: number; childStartedAt?: string; childIdentity?: string; reason?: string; retryAt?: string;
  activeResource?: string;
  stopReason?: string;
  pendingDecision?: {id: string; planHash: string; head: string; stage: Stage; taskId?: string; question: string; answer?: string};
  failures: {fingerprint: string; head: string; count: number};
  control?: 'pause' | 'stop';
}
const EvidenceSchema = z.object({checkId: Identifier, head: z.string(), code: z.number().int(), finishedAt: z.string(), log: z.string()}).strict();
const PrSchema = z.object({number: z.number().int().positive(), url: z.string(), headRefOid: z.string(), state: z.string(),
  mergedAt: z.string().nullable(), baseRefName: z.string(), headRefName: z.string(), baseRefOid: z.string().optional()}).strict();
const Sessions = z.object({DEFINE: z.string().optional(), PLAN: z.string().optional(), BUILD: z.string().optional(),
  VERIFY: z.string().optional(), REVIEW: z.string().optional(), SHIP: z.string().optional()}).strict();
export const RunSchema = z.object({
  id: z.uuid(), root: z.string(), commonDir: z.string(), plan: Plan, planHash: z.string(), revision: z.number().int().nonnegative(),
  status: z.enum(['draft', 'approved', 'running', 'waiting_quota', 'waiting_resource', 'waiting_external', 'needs_decision', 'paused', 'stopped', 'ready', 'merged', 'abandoned']),
  createdAt: z.string(), updatedAt: z.string(), approvedHash: z.string().optional(), branch: z.string(), worktree: z.string().optional(),
  parentIssue: z.number().int().optional(), finalPr: PrSchema.optional(),
  tasks: z.array(z.object({id: Identifier, integrated: z.boolean(), cursor: z.enum(['BUILD', 'REPAIR', 'VERIFY', 'REVIEW', 'SHIP', 'INTEGRATE']),
    issue: z.number().int().optional(), pr: PrSchema.optional(), worktree: z.string().optional(), branch: z.string().optional(), head: z.string().optional(),
    evidence: z.array(EvidenceSchema), reviewHead: z.string().optional(), sessions: Sessions}).strict()),
  finalPhase: z.enum(['SYNC', 'REPAIR', 'VERIFY', 'REVIEW', 'SHIP']), finalEvidence: z.array(EvidenceSchema), finalReviewHead: z.string().optional(),
  syncedBase: z.string().optional(), finalSessions: Sessions, childPid: z.number().int().positive().optional(), childStartedAt: z.string().optional(),
  childIdentity: z.string().optional(), activeResource: z.string().optional(), reason: z.string().optional(), retryAt: z.string().optional(),
  stopReason: z.enum(['quota', 'auth', 'network', 'model', 'failure', 'protocol', 'refusal', 'prerequisite', 'review_input', 'waiting_ci', 'waiting_merge', 'resource_busy', 'decision']).optional(),
  pendingDecision: z.object({id: z.uuid(), planHash: z.string(), head: z.string(), stage: Stage,
    taskId: z.string().optional(), question: z.string(), answer: z.string().optional()}).strict().optional(),
  failures: z.object({fingerprint: z.string(), head: z.string(), count: z.number().int().nonnegative()}).strict(),
  control: z.enum(['pause', 'stop']).optional(),
}).strict();
