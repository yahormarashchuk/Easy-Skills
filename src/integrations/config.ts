import { readFileSync, writeFileSync, existsSync, realpathSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '../util.js';
import { execute, type Command } from '../process.js';

export function configProposal(path: string, value: unknown) {
  const target = resolve(path), before = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Refusing to replace a symlink configuration');
  const after = JSON.stringify(value, null, 2) + '\n';
  return {path: target, before, after, hash: hash({path: target, before: before ?? null, after})};
}
/** Caller reviews the complete before/after proposal and explicitly approves its hash. */
export async function applyConfig(path: string, value: unknown, expectedHash: string, probe: Command, cwd: string) {
  const proposal = configProposal(path, value);
  return applyProposal(proposal, expectedHash, async () => {
    const result = await execute(probe, {cwd, timeoutMs: 30_000});
    if (result.code !== 0) throw new Error('Command check failed');
  }).then(result => ({...result, verified: false, commandSucceeded: true}));
}
export async function applyProposal(proposal: ReturnType<typeof configProposal>, expectedHash: string, verify: () => Promise<void>) {
  if (proposal.hash !== expectedHash) throw new Error('Configuration changed since review');
  mkdirSync(dirname(proposal.path), {recursive: true});
  realpathSync(dirname(proposal.path));
  const backup = proposal.path + '.easy-skills-backup-' + randomUUID();
  if (proposal.before !== undefined) writeFileSync(backup, proposal.before, {flag: 'wx', mode: 0o600});
  const temp = proposal.path + '.easy-skills-' + randomUUID();
  writeFileSync(temp, proposal.after, {flag: 'wx', mode: 0o600}); renameSync(temp, proposal.path);
  try {
    await verify();
  } catch (error) {
    if (readFileSync(proposal.path, 'utf8') === proposal.after) {
      if (proposal.before !== undefined) writeFileSync(proposal.path, proposal.before, {mode: 0o600});
      else rmSync(proposal.path);
    }
    throw new Error(`Connection check failed; previous configuration restored when unchanged; backup: ${proposal.before !== undefined ? backup : 'none (new file removed)'}`, {cause: error});
  }
  return {path: proposal.path, backup: proposal.before !== undefined ? backup : undefined, verified: true};
}
