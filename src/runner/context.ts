import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, Stage, Task } from '../contracts.js';
import { hash, rejectSymlinkPath } from '../util.js';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export interface ContextManifest {sections: {name: string; characters: number; estimatedTokens: number; hash: string; sent: boolean}[]; estimate: string}
export function assembleContext(run: Run, stage: Stage, task?: Task, extra = '', skillOverride?: string, previous?: ContextManifest) {
  const parts: {name: string; text: string; mandatory: boolean}[] = [];
  const add = (name: string, text: string, mandatory = false) => parts.push({name, text, mandatory});
  const skills: Record<Stage, string> = {DEFINE: 'easy-feature', PLAN: 'easy-plan', BUILD: 'easy-build', VERIFY: 'easy-test', REVIEW: 'easy-review', SHIP: 'easy-ship'};
  add('core', `Easy Skills ${run.plan.runnerVersion}; run ${run.id}; ${['PLAN', 'DEFINE'].includes(stage) ? 'proposed' : 'approved'} plan ${run.planHash}.
Stage ${stage}; assignment ${JSON.stringify(run.plan.assignments[stage])}.
Work only in the provided worktree. Preserve scope, rules, checks and exact model/provider.
The runner owns commits, state, Issues, PRs, pushes, merges and notifications. Do not perform those actions.
Do not read runner-private files, credentials or other sessions. Return blocked for unresolved choices.
Return exactly one structured JSON result: outcome (passed/blocked/failed), summary, findings, optional question.
Questions may be published on the parent Issue; exclude secrets. Prose never establishes check evidence.`, true);
  add('procedure', readFileSync(join(packageRoot, 'skills', skillOverride || skills[stage], 'SKILL.md'), 'utf8'));
  add('workflow', readFileSync(join(packageRoot, 'skills/_shared/workflow.md'), 'utf8'));
  function read(path: string, mandatory = false) {
    if (!existsSync(path)) return;
    rejectSymlinkPath(run.root, path);
    add('file:' + relative(run.root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'), mandatory);
  }
  read(join(run.root, 'AGENTS.md'), true); read(join(run.root, 'CLAUDE.md'), true);
  const scopes = task?.scope ? [task.scope] : run.plan.tasks.map(t => t.scope);
  const areas = new Set(scopes.flatMap(s => s?.areas || [])), paths = scopes.flatMap(s => s?.paths || []);
  const legacyScope = scopes.some(s => !s);
  function walk(path: string) {
    if (!existsSync(path)) return;
    rejectSymlinkPath(run.root, path);
    for (const entry of readdirSync(path, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = join(path, entry.name);
      if (lstatSync(next).isSymbolicLink()) throw new Error('Symlink in rule context');
      if (entry.isDirectory()) walk(next);
      else {
        const rel = relative(join(run.root, '.easy-skills/rules'), next).replaceAll('\\', '/'), layer = rel.startsWith('layers/');
        const names = rel.replace(/\.md$/, '').split('/').slice(1);
        if (!layer || legacyScope || names.some(name => areas.has(name) || paths.some(p => p.split('/').includes(name)))) read(next, !layer);
      }
    }
  }
  walk(join(run.root, '.easy-skills/rules'));
  for (const path of paths) {
    const segments = path.split('/').filter(Boolean);
    for (let n = 1; n <= segments.length; n++) for (const file of ['AGENTS.md', 'CLAUDE.md']) read(join(run.root, ...segments.slice(0, n), file), true);
  }
  add('specification', run.plan.spec);
  add('scope', task ? JSON.stringify(task) : JSON.stringify(run.plan.tasks.map(t => ({id: t.id, acceptance: t.acceptance, scope: t.scope}))));
  const relevant = task ? run.tasks.filter(t => task.dependsOn.includes(t.id)) : run.tasks;
  add('dependency-summary', JSON.stringify(relevant.map(t => ({id: t.id, integrated: t.integrated, head: t.head, pr: t.pr?.url, checks: t.evidence.map(e => ({id: e.checkId, code: e.code}))}))));
  add('references', 'Read supplementary repository context only as needed: .easy-skills/context/project-map.md, .easy-skills/context/glossary.md and .easy-skills/features/' + run.plan.featureId + '/spec.md. Verify stale maps against current code.');
  if (stage === 'REVIEW') add('review-scope', 'Independent review: assess the supplied diff, acceptance coverage, regressions and neighboring contracts. Report findings; do not edit.', true);
  add('current-observation', extra, true);
  const manifest: ContextManifest = {estimate: 'estimatedTokens = ceil(characters/4); an approximation, not measured usage', sections: parts.map(p => ({name: p.name, characters: p.text.length, estimatedTokens: Math.ceil(p.text.length / 4), hash: hash(p.text),
    sent: p.mandatory || !previous?.sections.some(s => s.name === p.name && s.hash === hash(p.text))}))};
  const prompt = parts.map((p, i) => manifest.sections[i]!.sent ? `[${p.name}]\n${p.text}` : `[${p.name} unchanged in this exact session]`).join('\n\n') + '\n\nContext manifest: ' + JSON.stringify(manifest);
  return {prompt, manifest};
}
export function context(run: Run, stage: Stage, task?: Task, extra = '', skillOverride?: string): string {
  return assembleContext(run, stage, task, extra, skillOverride).prompt;
}
