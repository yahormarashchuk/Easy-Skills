import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, Stage, Task } from '../contracts.js';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export function context(run: Run, stage: Stage, task?: Task, extra = '', skillOverride?: string): string {
  const skills: Record<Stage, string> = {DEFINE: 'easy-feature', PLAN: 'easy-plan', BUILD: 'easy-build', VERIFY: 'easy-test', REVIEW: 'easy-review', SHIP: 'easy-ship'};
  const skill = readFileSync(join(packageRoot, 'skills', skillOverride || skills[stage], 'SKILL.md'), 'utf8');
  const shared = readFileSync(join(packageRoot, 'skills', '_shared', 'workflow.md'), 'utf8');
  const rules: string[] = [];
  function read(path: string) {
    try {rules.push(`File: ${relative(run.root, path)}\n${readFileSync(path, 'utf8')}`);}
    catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
  }
  function walk(path: string) {
    try {
      for (const entry of readdirSync(path, {withFileTypes: true})) {
        const next = join(path, entry.name);
        if (lstatSync(next).isSymbolicLink()) throw new Error('Symlink in rule context');
        if (entry.isDirectory()) walk(next); else read(next);
      }
    } catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
  }
  read(join(run.root, 'AGENTS.md')); read(join(run.root, 'CLAUDE.md'));
  walk(join(run.root, '.easy-skills', 'rules'));
  read(join(run.root, '.easy-skills', 'context', 'project-map.md'));
  read(join(run.root, '.easy-skills', 'context', 'glossary.md'));
  const approved = stage !== 'PLAN' && stage !== 'DEFINE';
  return `Easy Skills ${run.plan.runnerVersion}; run ${run.id}; ${approved ? 'approved' : 'proposed'} plan ${run.planHash}.
Stage ${stage}; assignment ${JSON.stringify(run.plan.assignments[stage])}.
${skill}
${shared}

Project rules and context:
${rules.join('\n\n')}

${approved ? 'Approved' : 'Proposed'} specification:
${run.plan.spec}

Current task:
${task ? JSON.stringify(task, null, 2) : 'Whole-feature validation; inspect interaction of every completed task.'}

Task history:
${JSON.stringify(run.tasks)}

${extra}

Only work in the provided worktree. Do not create/merge PRs, change Issues, push,
edit Easy Skills state, approve actions, or change the approved rules/checks.
The runner owns those actions. Do not read runner-private files or credentials.
Report unresolved questions as blocked. Do not substitute another model/provider.
If a human choice is needed, add a question string to the result. Keep secrets out
of the question; the runner may publish it on the approved parent Issue.
Finish with exactly one JSON object (no code fence):
{"outcome":"passed|blocked|failed","summary":"concrete result","findings":["actionable finding"]}
This response does not replace the runner's independent check evidence.`;
}
