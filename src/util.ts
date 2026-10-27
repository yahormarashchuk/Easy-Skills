import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { mkdirSync, realpathSync, readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const now = () => new Date().toISOString();
export function stateHome(): string {
  return resolve(process.env.EASY_SKILLS_HOME || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'EasySkills'));
}
export function ensureDir(path: string): string {mkdirSync(path, {recursive: true, mode: 0o700}); return path;}
export function isInside(root: string, target: string): boolean {
  const rel = relative(realpathSync.native(root), realpathSync.native(target));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
export function rejectSymlinkPath(root: string, target: string): void {
  const base = resolve(root); let path = resolve(target);
  const rel = relative(base, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path escapes the selected directory');
  while (path !== base) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Symlink path is not an owned output: ' + path);
    path = dirname(path);
  }
}
export function rulesHash(root: string, overlay: Record<string, string> = {}): string {
  const entries: Record<string, string> = {};
  function walk(dir: string) {
    try {
      for (const entry of readdirSync(join(root, dir), {withFileTypes: true})) {
        const p = join(dir, entry.name);
        if (lstatSync(join(root, p)).isSymbolicLink()) throw new Error('Symlink in project rules: ' + p);
        if (entry.isDirectory()) walk(p); else entries[p.replaceAll('\\', '/')] = readFileSync(join(root, p), 'utf8');
      }
    } catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      if (lstatSync(join(root, name)).isSymbolicLink()) throw new Error('Symlink in project instructions: ' + name);
      entries[name] = readFileSync(join(root, name), 'utf8');
    }
    catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
  }
  walk('.easy-skills/rules');
  // Include instructions and client controls that can affect any later worktree stage.
  function instructions(dir: string) {
    for (const entry of readdirSync(join(root, dir), {withFileTypes: true})) {
      if (['.git', 'node_modules', '__pycache__', '.venv'].includes(entry.name)) continue;
      const p = join(dir, entry.name), normalized = p.replaceAll('\\', '/');
      if (entry.isSymbolicLink()) {
        if (['AGENTS.md', 'CLAUDE.md', '.codex', '.claude', '.mcp.json'].includes(entry.name)) throw new Error('Symlink in protected instructions: ' + p);
        continue;
      }
      if (entry.isDirectory()) instructions(p);
      else if (['AGENTS.md', 'CLAUDE.md', '.mcp.json'].includes(entry.name) || /(?:^|\/)\.(?:codex|claude)\//.test(normalized))
        entries[normalized] = readFileSync(join(root, p), 'utf8');
    }
  }
  instructions('');
  for (const [path, text] of Object.entries(overlay)) if (path.startsWith('.easy-skills/rules/')) entries[path] = text;
  return hash(Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, text.replaceAll('\r\n', '\n')])));
}
export function alive(pid?: number): boolean {
  if (!pid) return false;
  try {process.kill(pid, 0); return true;} catch (e) {return (e as NodeJS.ErrnoException).code === 'EPERM';}
}
export function message(error: unknown): string {return error instanceof Error ? error.message : String(error);}
export function redact(input: string): string {
  const path = join(stateHome(), 'settings.json');
  let settings: any;
  try {settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};}
  catch {return '[REDACTED: local redaction settings could not be loaded]';}
  const names = ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', settings.smtp?.passwordEnv,
    ...Object.values(settings.execution?.environment || {}).flat()] as string[];
  for (const name of names) if (name && process.env[name] && process.env[name]!.length >= 4) input = input.split(process.env[name]!).join('[REDACTED]');
  return input.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/((?:authorization|password|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
