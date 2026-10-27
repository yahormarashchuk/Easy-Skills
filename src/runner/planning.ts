import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Assignments, Identifier, Plan, VERSION, DirectWorkflow, type Run } from '../contracts.js';
import { CliClient, type Client } from '../adapters/index.js';
import { Store } from '../persistence/store.js';
import { loadProject } from '../cli/project.js';
import { Git } from '../git/index.js';
import { hash, rulesHash, now, alive } from '../util.js';
import { context } from './context.js';
import { requireCompatibility } from './compatibility.js';
import { requireAgreement } from './onboarding.js';
import { protectedManifest } from './protected-inputs.js';
import { ownerAlive, processIdentity } from '../process-identity.js';

export const FeatureRequest = z.object({featureId: Identifier, title: z.string().min(1), spec: z.string().min(1),
  assignments: Assignments, permissions: z.object({publishIssues: z.boolean(), mergeIntermediate: z.boolean()}).strict(),
  verification: z.object({diagnostics: z.array(Identifier), browserTools: z.array(z.string().regex(/^mcp__[\w-]+__[\w-]+$/))}).strict().optional(),
  workflow: DirectWorkflow.optional(),
  repairPolicy: z.object({maxCompletedAttempts: z.number().int().min(0).max(100)}).strict().default({maxCompletedAttempts: 3})}).strict();
/** Read-only planning uses the assigned PLAN model, before approval or publication. */
export async function generatePlan(store: Store, root: string, input: unknown, client: Client = new CliClient(), previous?: {worktree: string; plan: Plan; head: string}, cacheDraft = false) {
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
${seed.workflow ? 'Direct mode: return exactly ONE independent task, with explicit repository-relative scope.paths covering implementation and regression tests. Inspect the bound workflow.baseHead with read-only git show if the source checkout differs. Do not switch branches or decompose into intermediate Issues or PRs.' : 'Advanced feature mode: decompose only when meaningful dependencies require it.'}
Preserve specification, project, exact assignments, permissions, rules hash and package versions. Return the complete plan serialized as a JSON string in planJson of the structured result. No approval is implied.`);
    const cached = cacheDraft ? store.operation<Plan>(key + ':draft') : undefined;
    const result = cached ? {outcome: 'passed', plan: cached, summary: 'Saved unapproved technical plan'} : await client.run(request.assignments.PLAN, prompt, {cwd: previous?.worktree || identity.root, projectRoot: identity.root, mode: 'read', stage: 'PLAN', session: saved?.session,
      onSpawn: pid => store.recordOperation(key, run.id, 'planning.session', {...store.operation<object>(key), pid, identity: processIdentity(pid)}),
      onSession: session => store.recordOperation(key, run.id, 'planning.session', {...store.operation<object>(key), session}),
    });
    if (result.outcome !== 'passed' || !result.plan) throw new Error('PLAN did not return a complete validated plan: ' + result.summary);
    const plan = Plan.parse(result.plan);
    for (const field of ['schemaVersion', 'featureId', 'title', 'spec', 'project', 'assignments', 'permissions', 'verification', 'workflow', 'repairPolicy', 'protectedInputs', 'rulesHash', 'rulesAgreement', 'runnerVersion', 'skillsVersion'] as const)
      if (hash(plan[field] ?? null) !== hash(seed[field] ?? null)) throw new Error('PLAN changed an agreed field: ' + field);
    if (rulesHash(root) !== seed.rulesHash) throw new Error('Project rules changed during planning; prepare a new draft');
    if (cacheDraft) store.recordOperation(key + ':draft', run.id, 'planning.draft', plan);
    store.recordOperation(key, run.id, 'planning.completed', {session: store.operation<{session?: string}>(key)?.session, completed: true});
    return plan;
  } finally {store.release(key, owner);}
}
