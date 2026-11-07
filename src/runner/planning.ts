import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Assignments, Identifier, Plan, VERSION, Workflow, type Run } from '../contracts.js';
import { CliClient, InvalidResult, type Client } from '../adapters/index.js';
import { Store } from '../persistence/store.js';
import { loadProject } from '../cli/project.js';
import { Git } from '../git/index.js';
import { hash, rulesHash, now, alive } from '../util.js';
import { context } from './context.js';
import { requireCompatibility } from './compatibility.js';
import { requireAgreement } from './onboarding.js';
import { protectedManifest } from './protected-inputs.js';
import { ownerAlive, processIdentity } from '../process-identity.js';

/** Corrective BUILD attempts a task may use in total, approved once with the plan. Three proved too few on a real task whose rounds each fixed genuine findings. */
export const DEFAULT_REPAIR_ATTEMPTS = 10;
export const FeatureRequest = z.object({featureId: Identifier, title: z.string().min(1), spec: z.string().min(1),
  assignments: Assignments, permissions: z.object({publishIssues: z.boolean(), mergeIntermediate: z.boolean()}).strict(),
  verification: z.object({diagnostics: z.array(Identifier), browserTools: z.array(z.string().regex(/^mcp__[\w-]+__[\w-]+$/))}).strict().optional(),
  workflow: Workflow.optional(),
  repairPolicy: z.object({maxCompletedAttempts: z.number().int().min(0).max(100)}).strict().default({maxCompletedAttempts: DEFAULT_REPAIR_ATTEMPTS})}).strict();
export type PlanDecision = {question: string; answer: string};
/** PLAN stopped on a decision only the owner can make; the caller asks it and plans again with the answer. */
export class PlanDecisionNeeded extends Error {
  constructor(readonly summary: string, readonly question: string) {super('PLAN needs an owner decision: ' + summary + '\nQuestion: ' + question);}
}
/** PLAN returned a different delivery mode than the runner seeded, which means the specification contradicts it; the caller may switch the mode when the owner did not force one. */
export class PlanModeMismatch extends Error {
  constructor(readonly mode: 'direct' | 'slices', message: string) {super(message);}
}
/** Read-only planning uses the assigned PLAN model, before approval or publication. */
export async function generatePlan(store: Store, root: string, input: unknown, client: Client = new CliClient(), previous?: {worktree: string; plan: Plan; head: string}, cacheDraft = false, onLine?: (line: string) => void, decisions: PlanDecision[] = []) {
  const request = FeatureRequest.parse(input), project = loadProject(root), identity = await new Git(root).identity();
  await requireCompatibility(store, client, request.assignments.PLAN, root);
  if (project.schemaVersion !== 2) throw new Error('Project v2 setup/protected-input configuration must be reviewed before new plans');
  const seed: Plan = {...request, project, schemaVersion: 2, runnerVersion: VERSION, skillsVersion: VERSION, protectedInputs: protectedManifest(root, project), rulesHash: rulesHash(root), rulesAgreement: requireAgreement(root),
    tasks: [{id: 'planning-only', title: 'Planning seed', description: 'Replace with the actual dependency graph', acceptance: ['Deliver the specification'], dependsOn: []}]};
  const run: Run = {id: randomUUID(), root: identity.root, commonDir: identity.commonDir, plan: seed, planHash: hash(seed), revision: 0,
    status: 'draft', createdAt: now(), updatedAt: now(), branch: `feature/${request.featureId}`, tasks: [], finalPhase: 'SYNC',
    finalEvidence: [], finalSessions: {}, failures: {fingerprint: '', head: '', count: 0}};
  const key = 'planning:' + hash({root: identity.root, seed, ...(previous ? {previous: hash(previous.plan), head: previous.head} : {})});
  const owner = store.acquire(key);
  try {
    const saved = store.operation<{session?: string; pid?: number; identity?: string}>(key);
    if (saved?.pid && ownerAlive(saved.pid, saved.identity)) throw new Error('Previous planning client is still alive; reconcile before resuming');
    const prompt = context(run, 'PLAN', undefined,
      `This is an UNAPPROVED, READ-ONLY planning session. Do not implement or publish anything.
${previous ? `You are in the existing task worktree at reviewed revision ${previous.head}. Revise the following previous approved plan for the new specification. Preserve existing behavior and cover the complete resulting diff, including earlier changed paths: ${JSON.stringify(previous.plan)}` : 'You are in the project root.'}
Build a complete Plan JSON object from this seed, replacing its placeholder tasks with small sequentially executable slices:
${JSON.stringify(seed)}
${seed.workflow?.mode === 'direct' ? 'Direct mode: return exactly ONE independent task, with explicit repository-relative scope.paths covering implementation and regression tests. Inspect the bound workflow.baseHead with read-only git show if the source checkout differs. Do not switch branches or decompose into intermediate Issues or PRs.'
  : seed.workflow?.mode === 'slices' ? `Slices mode: decompose the feature into small sequential slices, each independently reviewable and delivering a working, tested step; the runner publishes one Issue and one PR per slice and merges each into the feature branch after its checks and REVIEW. Express order with dependsOn. Every task needs explicit repository-relative scope.paths covering its implementation and regression tests, and a slice may change only its own paths, so list a path in every slice that changes it. Inspect the bound workflow.baseHead with read-only git show if the source checkout differs; do not switch branches.${previous ? ' For feedback, keep every earlier slice unchanged (same id and content) and add new slices for the change.' : ''}`
  : 'Advanced feature mode: decompose only when meaningful dependencies require it.'}
Acceptance criteria and checks may rely only on the checks that exist in the approved project configuration (${JSON.stringify(project.checks.map(c => c.id))}) and on evidence the runner records itself. A task must never require creating new verification tooling, result validators, provenance manifests or new project checks as acceptance, unless the specification explicitly demands that tool as a product deliverable. Every criterion must be verifiable by those approved checks plus independent inspection of the code and tests.
Every task needs scope with both areas (an array of identifiers, [] when none apply) and paths. Preserve specification, project, exact assignments, permissions, rules hash and package versions. The workflow object and the permissions belong to the runner: copy them unchanged and never edit them. If the specification contradicts the delivery mode they define (for example it forbids runner merges while the mode merges slices, or it asks for several reviewed PRs while the mode is one task), do not rewrite them: return outcome blocked with a question that tells the owner to restart with run --direct (one task, one PR the owner merges) or run --slices. Return the complete plan serialized as a JSON string in planJson of the structured result. No approval is implied.` +
      (decisions.length ? `\nOwner decisions on questions you asked earlier (final; apply them in the plan and never ask them again): ${JSON.stringify(decisions)}` : ''));
    const cached = cacheDraft ? store.operation<Plan>(key + ':draft') : undefined;
    const ask = (text: string, session?: string) => client.run(request.assignments.PLAN, text, {cwd: previous?.worktree || identity.root, projectRoot: identity.root, mode: 'read', stage: 'PLAN', session, onLine,
      onSpawn: pid => store.recordOperation(key, run.id, 'planning.session', {...store.operation<object>(key), pid, identity: processIdentity(pid)}),
      onSession: session => store.recordOperation(key, run.id, 'planning.session', {...store.operation<object>(key), session}),
    });
    /** A long plan can miss one required field; the same session is asked once to correct it instead of discarding the work. */
    const corrected = (error: unknown) => {
      const session = store.operation<{session?: string}>(key)?.session;
      if (!(error instanceof InvalidResult) || !session) throw error;
      return ask(`Your structured result failed validation: ${error.reason}. Return the complete corrected result in the same structured format, with the complete plan in planJson. Change only what is needed to pass validation.`, session);
    };
    const result = cached ? {outcome: 'passed', plan: cached, summary: 'Saved unapproved technical plan'} : await ask(prompt, saved?.session).catch(corrected);
    if (result.outcome === 'blocked' && 'question' in result && result.question) throw new PlanDecisionNeeded(result.summary, result.question);
    if (result.outcome !== 'passed' || !result.plan) throw new Error('PLAN did not return a complete validated plan: ' + result.summary);
    const plan = Plan.parse(result.plan);
    for (const field of ['schemaVersion', 'featureId', 'title', 'spec', 'project', 'assignments', 'permissions', 'verification', 'workflow', 'repairPolicy', 'protectedInputs', 'rulesHash', 'rulesAgreement', 'runnerVersion', 'skillsVersion'] as const)
      if (hash(plan[field] ?? null) !== hash(seed[field] ?? null)) {
        const message = 'PLAN changed an agreed field: ' + field +
          (field === 'workflow' || field === 'permissions' ? '. The delivery mode belongs to the runner, not to PLAN. If the specification needs another mode, restart with run --direct (one task, one PR you merge) or run --slices; your DEFINE answers are saved.' : '');
        const mode = plan.workflow?.mode;
        if (field === 'workflow' && (mode === 'direct' || mode === 'slices') && mode !== seed.workflow?.mode) throw new PlanModeMismatch(mode, message);
        throw new Error(message);
      }
    if (rulesHash(root) !== seed.rulesHash) throw new Error('Project rules changed during planning; prepare a new draft');
    if (cacheDraft) store.recordOperation(key + ':draft', run.id, 'planning.draft', plan);
    store.recordOperation(key, run.id, 'planning.completed', {session: store.operation<{session?: string}>(key)?.session, completed: true});
    return plan;
  } finally {store.release(key, owner);}
}
