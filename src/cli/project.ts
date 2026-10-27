import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { parse, stringify } from 'yaml';
import { Project, VERSION } from '../contracts.js';
import { Git } from '../git/index.js';
import { ensureDir, hash, rejectSymlinkPath } from '../util.js';
import { packageRoot } from '../runner/context.js';
import { skillResources } from '../skills.js';
import { draftInterview } from '../runner/onboarding.js';
import { applyProposal } from '../integrations/config.js';

export async function inspectProject(cwd: string) {
  const git = new Git(cwd), identity = await git.identity();
  const files = (await git.run(['ls-files'])).split(/\r?\n/).filter(Boolean);
  return {...identity, trackedFiles: files.length,
    manifests: files.filter(p => /(^|\/)(package.json|pyproject.toml|Cargo.toml|go.mod|.*\.csproj|pom.xml|build.gradle)$/.test(p)),
    instructions: ['AGENTS.md', 'CLAUDE.md'].filter(f => existsSync(join(identity.root, f))),
    ruleFiles: files.filter(f => f.startsWith('.easy-skills/rules/'))};
}
export async function initProject(cwd: string, config: unknown, applyHash?: string) {
  const project = Project.parse(config), inspection = await inspectProject(cwd);
  const entries: Record<string, string> = {
    '.easy-skills/project.yaml': stringify(project),
    '.easy-skills/decisions/onboarding.json': JSON.stringify(draftInterview(), null, 2) + '\n',
    '.easy-skills/context/project-map.md': `# ${project.name}\n\nDiscovered manifests:\n${inspection.manifests.map(p => '- ' + p).join('\n') || '(none)'}\n\nThis is an inventory, not an approved architecture. Read current code before each task.\n`,
    '.easy-skills/context/glossary.md': '# Glossary\n\nRecord agreed project terms here.\n',
    '.easy-skills/rules/architecture.md': '# Architecture\n\nPending interview: identify maintained examples, boundaries and deprecated patterns.\n',
    '.easy-skills/rules/coding-style.md': '# Coding style\n\nPending interview: approved patterns, dependencies, error handling and authorization.\n',
    '.easy-skills/rules/testing.md': `# Testing\n\nProposed required checks:\n${project.checks.map(c => '- ' + c.id + ': ' + JSON.stringify([c.command, ...c.args])).join('\n')}\n\nAgree acceptance coverage and an isolated data environment before approving a feature.\n`,
    '.easy-skills/rules/boundaries.md': '# Boundaries\n\nAllowed: approved implementation and checks in owned worktrees.\nForbidden: secrets in tracked content; silent model changes; destructive cleanup.\nRequires explicit approval: main-branch merge, external publication, changes to rules and shared data.\n',
  };
  const pointer = '\n<!-- easy-skills:context -->\nRead .easy-skills/project.yaml and relevant .easy-skills/rules/ files.\nRead .easy-skills/context/project-map.md and verify it against current code.\nApproved feature specifications live under .easy-skills/features/.\n';
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const before = existsSync(join(inspection.root, file)) ? readFileSync(join(inspection.root, file), 'utf8') : '';
    if (!before.includes('<!-- easy-skills:context -->')) entries[file] = before + pointer;
  }
  const changes = Object.entries(entries).map(([path, after]) => ({path,
    before: existsSync(join(inspection.root, path)) ? readFileSync(join(inspection.root, path), 'utf8') : null, after}));
  if (changes.some(c => c.path.startsWith('.easy-skills/') && c.before !== null))
    throw new Error('Project already contains Easy Skills context; use easy-rules to review updates');
  const proposal = {root: inspection.root, changes, hash: hash(changes)};
  if (!applyHash) return proposal;
  if (applyHash !== proposal.hash) throw new Error('Onboarding proposal changed since review');
  for (const change of changes) {
    const target = join(inspection.root, change.path);
    rejectSymlinkPath(inspection.root, target);
    ensureDir(join(target, '..'));
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Refusing to write through a symlink: ' + target);
    if (change.before !== null) copyFileSync(target, target + '.easy-skills-backup');
    writeFileSync(target, change.after, 'utf8');
  }
  return {...proposal, applied: true, next: 'Complete the easy-init interview; agree rules and required checks before approving a feature.'};
}
export function loadProject(root: string): Project {return Project.parse(parse(readFileSync(join(root, '.easy-skills/project.yaml'), 'utf8')));}
export async function updateProject(root: string, input: unknown, approvedHash?: string) {
  const project = Project.parse(input), path = join(root, '.easy-skills/project.yaml');
  if (project.schemaVersion !== 2) throw new Error('New configuration requires project contract v2');
  rejectSymlinkPath(root, path);
  const before = readFileSync(path, 'utf8'), after = stringify(project);
  const proposal = {path, before, after, hash: hash({path, before, after})};
  if (!approvedHash) return {...proposal, next: 'Review this configuration, then renew rules agreement and create a separately approved v2 plan; existing approvals stay unchanged'};
  const result = await applyProposal(proposal, approvedHash, async () => {loadProject(root);});
  return {...result, verified: false, configurationParsed: true, next: 'Renew rules agreement before planning; existing run JSON and approvals were preserved'};
}

export function skillManifest() {
  return readdirSync(join(packageRoot, 'skills'), {withFileTypes: true})
    .filter(e => e.isDirectory() && e.name.startsWith('easy-')).map(e => e.name);
}
export function installSkills(targetRoot: string, applyHash?: string) {
  const target = resolve(targetRoot);
  const changes: {path: string; before: string | null; after: string}[] = [];
  for (const skill of skillManifest()) {
    const resources = {'SKILL.md': `skills/${skill}/SKILL.md`, ...skillResources(skill)};
    for (const [name, source] of Object.entries(resources)) {
      const path = join(target, skill, name), after = readFileSync(join(packageRoot, source), 'utf8');
      rejectSymlinkPath(target, path);
      const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (before !== after) changes.push({path, before, after});
    }
  }
  const proposal = {target, version: VERSION, changes, hash: hash({target, changes})};
  if (!applyHash) return proposal;
  if (applyHash !== proposal.hash) throw new Error('Installation proposal changed since review');
  const id = Date.now().toString();
  for (const change of changes) {
    mkdirSync(join(change.path, '..'), {recursive: true});
    if (existsSync(change.path) && lstatSync(change.path).isSymbolicLink()) throw new Error('Symlink skill destination refused');
    if (change.before !== null) copyFileSync(change.path, change.path + '.backup-' + id);
    writeFileSync(change.path, change.after, 'utf8');
  }
  const manifest = {version: VERSION, files: skillManifest().flatMap(skill => ['SKILL.md', ...Object.keys(skillResources(skill))].map(name => {
    const path = join(target, skill, name); return {path, hash: hash(readFileSync(path, 'utf8'))};
  }))};
  writeFileSync(join(target, '.easy-skills-install.json'), JSON.stringify(manifest, null, 2));
  return {target, installed: manifest.files.length, backupSuffix: '.backup-' + id};
}
export function uninstallSkills(targetRoot: string, applyHash?: string) {
  const target = resolve(targetRoot);
  const manifest = JSON.parse(readFileSync(join(target, '.easy-skills-install.json'), 'utf8')) as {files: {path: string; hash: string}[]};
  const removable: string[] = [], modified: string[] = [];
  for (const file of manifest.files) {
    const rel = relative(target, resolve(file.path));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Install manifest path escapes target');
    rejectSymlinkPath(target, file.path);
    if (!existsSync(file.path)) continue;
    if (lstatSync(file.path).isSymbolicLink()) throw new Error('Installed file is a symlink');
    (hash(readFileSync(file.path, 'utf8')) === file.hash ? removable : modified).push(file.path);
  }
  const proposal = {target, removable, modified, hash: hash({target, removable, modified})};
  if (applyHash) {
    if (applyHash !== proposal.hash) throw new Error('Uninstall proposal changed since review');
    // Individual verified files only. Keep modified skills, backups, and user configuration.
    for (const path of removable) rmSync(path);
    if (!modified.length) rmSync(join(target, '.easy-skills-install.json'));
  }
  return proposal;
}
