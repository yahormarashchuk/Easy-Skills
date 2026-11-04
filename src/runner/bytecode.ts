import { rmSync, rmdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BYTECODE = /(^|\/)__pycache__\/[^/]+\.pyc$/;

/**
 * Python writes bytecode caches next to any script an agent runs. They are never part of a change, so the untracked ones are
 * deleted (with their then-empty cache folders) and the remaining paths are returned for the scope check.
 */
export function dropBytecode(cwd: string, untracked: string[]): string[] {
  const folders = new Set<string>();
  for (const path of untracked.filter(p => BYTECODE.test(p))) {
    rmSync(join(cwd, path), {force: true});
    folders.add(join(cwd, dirname(path)));
  }
  for (const folder of folders) {
    try {if (!readdirSync(folder).length) rmdirSync(folder);} catch { /* already gone */ }
  }
  return untracked.filter(p => !BYTECODE.test(p));
}
