import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from '../git/index.js';
import { githubRepository } from '../git/remotes.js';
import { hash, redact, rejectSymlinkPath } from '../util.js';
import type { Store } from '../persistence/store.js';

export interface Discovery {
  root: string; commonDir: string; repository: string; branch: string; baseBranch: string;
  head: string; baseHead: string; trackedFiles: number; manifests: string[]; instructions: string[]; skills: string[];
  examples: {path: string; content: string; sourceHash: string}[]; fingerprint: string; dirty: boolean;
}
/** Bounded, read-only inventory. This never installs dependencies or executes project code. */
export async function discover(root: string, store?: Store, topic = '', targetBranch?: string): Promise<Discovery> {
  const git = new Git(root), identity = await git.identity();
  const files = (await git.run(['ls-files', '-z'])).split('\0').filter(Boolean).sort();
  const repository = githubRepository(await git.run(['config', '--get', 'remote.origin.url']));
  if (!repository) throw new Error('Configure origin as the intended github.com repository before onboarding');
  const branch = await git.run(['branch', '--show-current']);
  let baseBranch: string;
  try {baseBranch = (await git.run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '');}
  catch {
    const branches = (await git.run(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])).split(/\r?\n/);
    baseBranch = ['main', 'master', 'trunk'].find(b => branches.includes('origin/' + b)) || branch;
  }
  if (!baseBranch) throw new Error('Cannot determine the base branch; configure origin/HEAD');
  baseBranch = targetBranch || baseBranch;
  const manifests = files.filter(p => /(?:^|\/)(?:package.json|pyproject.toml|requirements.*\.txt|go.mod|Cargo.toml|pom.xml|build.gradle(?:.kts)?|.*\.(?:csproj|sln|slnx))$/.test(p));
  const instructions = files.filter(p => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(p));
  const skills = files.filter(p => /(?:^|\/)SKILL\.md$/.test(p));
  const terms = topic.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3);
  const candidates = [...new Set([...['AGENTS.md', 'CLAUDE.md', 'README.md'].filter(p => existsSync(join(root, p))),
    ...instructions.slice(0, 8), ...manifests.slice(0, 10), ...skills.slice(0, 6),
    ...files.filter(p => terms.some(t => p.toLowerCase().includes(t))).slice(0, 12),
    ...files.filter(p => /^docs\//.test(p) && /architect|convention|test|secur/i.test(p)).slice(0, 6),
    ...files.filter(p => /(?:^|\/)(?:src|test|tests)\//.test(p)).slice(0, 4)])].slice(0, 40);
  const examples: Discovery['examples'] = [];
  let remaining = 80_000;
  for (const path of candidates) {
    // Inventory names can contain secrets or binary assets: sample only maintained text.
    if (!/\.(?:md|json|toml|txt|xml|csproj|slnx?|kts|gradle|ts|tsx|js|mjs|py|cs|razor|go|java|rs|ya?ml)$/.test(path) || /(?:^|\/)(?:\.env|credentials|secrets)(?:\.|\/|$)/i.test(path)) continue;
    rejectSymlinkPath(root, join(root, path));
    if (!existsSync(join(root, path)) || !lstatSync(join(root, path)).isFile() || lstatSync(join(root, path)).size > 256_000) continue;
    const bytes = readFileSync(join(root, path));
    if (bytes.includes(0)) continue;
    const content = redact(bytes.toString('utf8').slice(0, Math.min(8000, remaining)));
    examples.push({path, content, sourceHash: hash({bytes: bytes.toString('base64')})}); remaining -= content.length;
    if (remaining <= 0) break;
  }
  const head = await git.head(root), dirty = !!await git.run(['status', '--porcelain', '--untracked-files=no']);
  let baseHead: string;
  try {baseHead = await git.run(['rev-parse', 'refs/remotes/origin/' + baseBranch]);} catch {baseHead = head;}
  const fingerprint = hash({files, examples, head, baseHead, topic});
  const key = 'discovery:' + hash({root: identity.root, topic});
  const saved = store?.operation<Discovery>(key);
  if (saved?.fingerprint === fingerprint) return {...saved, dirty};
  const result = {...identity, repository, branch, baseBranch, head, baseHead, trackedFiles: files.length, manifests, instructions, skills, examples, fingerprint, dirty};
  store?.recordOperation(key, 'project:' + hash(identity.root), 'discovery.cached', result);
  return result;
}

export function knowledgeSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function read(path: string) {
    const target = join(root, path); rejectSymlinkPath(root, target);
    if (existsSync(target)) {
      if (lstatSync(target).size > 256_000) throw new Error('Project knowledge file is too large: ' + path);
      result[path] = readFileSync(target, 'utf8');
    }
  }
  // The complete rules set is approval-bound, including locally generated rules.
  function walk(path: string) {
    const target = join(root, path); rejectSymlinkPath(root, target);
    if (!existsSync(target)) return;
    for (const entry of readdirSync(target, {withFileTypes: true})) {
      const next = path + '/' + entry.name;
      if (entry.isDirectory()) walk(next); else read(next);
    }
  }
  walk('.easy-skills/rules');
  for (const path of ['.easy-skills/project.yaml', '.easy-skills/decisions/onboarding.json', '.easy-skills/context/project-map.md', '.easy-skills/context/knowledge.json']) read(path);
  if (JSON.stringify(result).length > 500_000) throw new Error('Project knowledge exceeds the bounded plan context; reduce duplicated rules');
  return result;
}
