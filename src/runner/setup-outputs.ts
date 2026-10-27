import { readFileSync, lstatSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Git } from '../git/index.js';
import { hash, rejectSymlinkPath } from '../util.js';

export interface SetupOutput {path: string; hash: string}
export async function ignoredOutputs(git: Git, cwd: string): Promise<SetupOutput[]> {
  const paths = (await git.run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], cwd)).split('\0').filter(Boolean);
  return paths.sort().map(path => {
    const file = join(cwd, path); rejectSymlinkPath(cwd, file);
    if (!lstatSync(file).isFile()) throw new Error('Ignored output is not a regular file: ' + path);
    return {path, hash: hash(readFileSync(file).toString('base64'))};
  });
}
export function removeSetupOutput(cwd: string, output: SetupOutput) {
  const file = join(cwd, output.path); rejectSymlinkPath(cwd, file);
  if (!existsSync(file)) return;
  if (hash(readFileSync(file).toString('base64')) !== output.hash) throw new Error('Setup output changed after cleanup review');
  unlinkSync(file);
  let directory = dirname(file);
  while (directory !== cwd) {
    try {rmdirSync(directory);} catch {break;}
    directory = dirname(directory);
  }
}
