import { execute } from '../process.js';
import { CliClient } from '../adapters/index.js';
import type { Provider } from '../contracts.js';
import { installSkills } from './project.js';
import { hash } from '../util.js';

export async function bootstrap(cwd: string, provider: Provider, target: string, applyHash?: string,
  dependencies = {execute, diagnose: new CliClient().diagnose.bind(new CliClient())}) {
  const checks: {name: string; ok: boolean; detail?: string}[] = [{name: 'Node.js 24+', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version}];
  for (const [name, command, args] of [['Git', 'git', ['--version']], ['GitHub CLI', 'gh', ['--version']], ['GitHub authentication', 'gh', ['auth', 'status']]] as const) {
    try {const result = await dependencies.execute({command, args: [...args]}, {cwd, timeoutMs: 15_000}); checks.push({name, ok: result.code === 0, detail: result.code === 0 ? result.stdout.trim().slice(0, 180) : 'Install/sign in using the official CLI'});}
    catch {checks.push({name, ok: false, detail: 'Executable not available'});}
  }
  const diagnostic = await dependencies.diagnose({provider, model: 'diagnostic-only'}, cwd);
  checks.push({name: provider, ok: diagnostic.installed && diagnostic.authenticated && diagnostic.isolation !== false, detail: diagnostic.detail || diagnostic.version});
  const installation = installSkills(target), ready = checks.every(c => c.ok);
  if (!('hash' in installation)) throw new Error('Expected a skill installation preview');
  const preview = {checks, ready, installation, hash: hash({checks, installationHash: installation.hash}), next: ready
    ? ['Review and apply the skill installation hash.', 'Run easy-init in your project and complete agree-rules.', 'Approve exact model launch/resume probes before feature planning.']
    : ['Install the missing prerequisites or sign in through git/gh/the official AI client, then rerun bootstrap.']};
  if (applyHash) {
    if (applyHash !== preview.hash) throw new Error('Bootstrap diagnostics or skill proposal changed; review again');
    if (!ready) throw new Error('Bootstrap prerequisites are incomplete; see diagnostics');
    installSkills(target, installation.hash);
  }
  return {...preview, applied: !!applyHash};
}
