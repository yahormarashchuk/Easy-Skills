import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { stateHome } from './util.js';

export const EXECUTION_POLICY = 'trusted-execution-v1';
export type ProcessRole = 'git' | 'github' | 'client' | 'mcp' | 'project' | 'notification' | 'supervisor' | 'tool';
export interface ExecutionSettings {tools?: Record<string, string>; environment?: Partial<Record<ProcessRole, string[]>>}
function configuration(): {execution?: ExecutionSettings; smtp?: {passwordEnv?: string}} {
  const file = join(stateHome(), 'settings.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
function within(root: string, target: string) {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
function candidates(name: string, directories: string[]) {
  const suffixes = process.platform === 'win32' && !/\.(exe|com|cmd|bat)$/i.test(name) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  return directories.flatMap(dir => suffixes.map(suffix => join(dir, name + suffix))).filter(file => existsSync(file) && statSync(file).isFile());
}
/** Fixed installation directories are trusted; arbitrary PATH entries are never searched. */
export function trustedDirectories(): string[] {
  const home = homedir();
  return (process.platform === 'win32' ? [
    join(process.env.SystemRoot || 'C:/Windows', 'System32'),
    'C:/Program Files/Git/cmd', 'C:/Program Files/GitHub CLI', 'C:/Program Files/nodejs',
    join(home, 'AppData/Roaming/npm'), join(home, '.local/bin'),
  ] : ['/usr/local/bin', '/usr/bin', '/bin', join(home, '.local/bin')]).filter(p => existsSync(p));
}
export function trustedExecutable(name: string, cwd: string): string {
  if (name === 'node' || name === process.execPath) return realpathSync.native(process.execPath);
  const configured = configuration().execution?.tools?.[name];
  // `which` prepends process.cwd() on Windows even with an explicit PATH.
  // Search absolute candidates directly so a repository can never win that lookup.
  const candidate = configured || (isAbsolute(name) ? name : candidates(name, trustedDirectories())[0]);
  if (!candidate || !isAbsolute(candidate) || !existsSync(candidate) || !statSync(candidate).isFile())
    throw new Error(`Trusted executable unavailable: ${name}; configure execution.tools with a reviewed absolute installation path`);
  const file = realpathSync.native(candidate);
  if (within(cwd, file)) throw new Error('Runner tool must be outside the managed working directory: ' + name);
  if (!configured && !trustedDirectories().some(dir => within(realpathSync.native(dir), file)))
    throw new Error('Executable is outside trusted installation directories: ' + name);
  return file;
}
export function projectExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return resolve(cwd, command);
  if (command === 'node') return realpathSync.native(process.execPath);
  // Repository commands require an explicit path in the approved configuration.
  const file = candidates(command, (env.PATH || env.Path || '').split(delimiter).filter(isAbsolute))[0];
  if (!file) throw new Error('Approved project executable unavailable: ' + command);
  return file;
}
export function childEnvironment(role: ProcessRole, source: NodeJS.ProcessEnv = process.env, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const config = configuration();
  const names = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'TERM', 'NUMBER_OF_PROCESSORS'];
  if (role === 'client') names.push('CODEX_HOME', 'CLAUDE_CONFIG_DIR');
  if (role === 'github' || role === 'git') names.push('GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'SSH_AUTH_SOCK');
  if (role === 'supervisor') names.push('EASY_SKILLS_HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    ...Object.values(config.execution?.environment || {}).flat(), ...(config.smtp?.passwordEnv ? [config.smtp.passwordEnv] : []));
  names.push(...(config.execution?.environment?.[role] || []));
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name] !== undefined) env[name] = source[name];
  // Explicit values come only from approved configuration, never a repository's environment file.
  Object.assign(env, extra);
  delete env.Path; env.PATH = [...new Set([dirname(process.execPath), ...trustedDirectories()])].join(delimiter);
  if (role !== 'notification' && role !== 'supervisor' && config.smtp?.passwordEnv) delete env[config.smtp.passwordEnv];
  return env;
}
export function clientCommand(provider: 'codex' | 'claude-code', cwd: string) {
  const command = trustedExecutable(provider === 'codex' ? 'codex' : 'claude', cwd);
  if (!/\.(cmd|bat)$/i.test(command)) return {command, prefix: [] as string[]};
  const packageName = provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const base = join(dirname(command), 'node_modules', packageName);
  const entry = join(base, provider === 'codex' ? 'bin/codex.js' : 'cli.js');
  if (!existsSync(entry) || JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).name !== packageName ||
    !within(realpathSync.native(base), realpathSync.native(entry)))
    throw new Error('Unsupported client batch shim; install the official native client or a verified npm package');
  return {command: realpathSync.native(process.execPath), prefix: [realpathSync.native(entry)]};
}
