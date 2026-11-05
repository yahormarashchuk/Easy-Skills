import { rmSync, rmdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Files that tools write by themselves into the working folder, never part of a change. */
const TOOL_FILES = [
  /(^|\/)__pycache__\/[^/]+\.pyc$/,
  // NuGet records its first-run migration here when a sandbox gives it no user data folder, so it lands in the worktree root.
  /^NuGet\/Migrations\/[^/]+$/,
];
const isToolFile = (path: string) => TOOL_FILES.some(pattern => pattern.test(path));

/**
 * Python bytecode caches and NuGet's first-run marker appear in a worktree whenever an agent runs a script or a build. The
 * untracked ones are deleted (with the folders they leave empty) and the remaining paths are returned for the scope check.
 */
export function dropBytecode(cwd: string, untracked: string[]): string[] {
  const folders = new Set<string>();
  for (const path of untracked.filter(isToolFile)) {
    rmSync(join(cwd, path), {force: true});
    folders.add(dirname(path));
  }
  for (let folder of folders) {
    for (; folder && folder !== '.'; folder = dirname(folder)) {
      try {if (readdirSync(join(cwd, folder)).length) break; rmdirSync(join(cwd, folder));} catch {break;}
    }
  }
  return untracked.filter(path => !isToolFile(path));
}
