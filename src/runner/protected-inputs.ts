import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { join, isAbsolute } from 'node:path';
import { hash, rejectSymlinkPath } from '../util.js';
import type { Project } from '../contracts.js';

export function protectedManifest(root: string, project: Project, overlay: Record<string, string> = {}): Record<string, string | null> {
  const paths = new Set(project.protectedInputs || []);
  for (const check of project.checks) for (const path of [check.command, ...check.args]) {
    if (!isAbsolute(path) && !path.startsWith('-') && existsSync(join(root, path)) && lstatSync(join(root, path)).isFile()) paths.add(path.replaceAll('\\', '/'));
  }
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt',
    '.easy-skills/project.yaml', '.easy-skills/decisions/onboarding.json']) if (existsSync(join(root, path)) || path in overlay) paths.add(path);
  return Object.fromEntries([...paths].sort().map(path => {
    if (isAbsolute(path) || path.includes('..') || path.includes('\\') || path.includes(':')) throw new Error('Protected inputs must be repository-relative POSIX files');
    const file = join(root, path);
    rejectSymlinkPath(root, file);
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Protected input is a symlink: ' + path);
    const bytes = path in overlay ? Buffer.from(overlay[path]!) : existsSync(file) ? readFileSync(file) : undefined;
    return [path, bytes ? hash(bytes.includes(0) || !isUtf8(bytes)
      ? {encoding: 'binary', content: bytes.toString('base64')}
      : {encoding: 'utf8', content: bytes.toString('utf8').replaceAll('\r\n', '\n')}) : null];
  }));
}
export function assertProtected(root: string, project: Project, approved: Record<string, string | null>, overlay: Record<string, string> = {}) {
  const current = protectedManifest(root, {...project, protectedInputs: Object.keys(approved)}, overlay);
  if (hash(current) !== hash(approved)) throw new Error('Protected verification inputs changed; preserve changes and obtain approval for a replacement plan');
}
