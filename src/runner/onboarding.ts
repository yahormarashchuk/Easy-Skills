import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureDir, hash, rejectSymlinkPath, rulesHash } from '../util.js';

export const Interview = z.object({schemaVersion: z.literal(1), version: z.number().int().positive(), status: z.enum(['draft', 'agreed']),
  rulesHash: z.string(), projectHash: z.string(), decisions: z.array(z.object({id: z.string().min(1), question: z.string().min(1),
    status: z.enum(['unresolved', 'resolved']), answer: z.string().optional(), evidence: z.array(z.string()).optional()}).strict()).min(1),
  conflicts: z.array(z.string()), assumptions: z.array(z.string()), completionCriteria: z.array(z.string().min(1)).min(1),
}).strict();
export const agreementPath = (root: string) => join(root, '.easy-skills/decisions/onboarding.json');
export function draftInterview() {
  return {schemaVersion: 1, version: 1, status: 'draft', rulesHash: '', projectHash: '',
    decisions: [
      {id: 'architecture', question: 'Which maintained examples, boundaries and deprecated patterns govern this repository?', status: 'unresolved'},
      {id: 'dependencies', question: 'Which libraries and coding patterns are allowed, forbidden or approval-required?', status: 'unresolved'},
      {id: 'checks', question: 'Which checks, fixtures, environments and acceptance criteria can be reproduced?', status: 'unresolved'},
      {id: 'conflicts', question: 'Have conflicting instructions, stale context and assumptions been resolved?', status: 'unresolved'},
    ], conflicts: [], assumptions: [], completionCriteria: ['All decisions answered with repository evidence or explicit owner choices', 'Conflicts resolved and checks reproducible', 'Owner reviewed the complete rules revision']};
}
export function agreementProposal(root: string, input: unknown) {
  const interview = Interview.parse(input), path = agreementPath(root);
  rejectSymlinkPath(root, path);
  if (interview.status !== 'agreed' || interview.conflicts.length || interview.decisions.some(d => d.status !== 'resolved' || !d.answer?.trim()))
    throw new Error('Onboarding has unresolved decisions/conflicts; complete the interview before agreement');
  if (new Set(interview.decisions.map(d => d.id)).size !== interview.decisions.length) throw new Error('Duplicate interview decision IDs');
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const previous = before ? Interview.parse(JSON.parse(before)) : undefined;
  const agreement = {...interview, version: (previous?.version || 0) + 1, rulesHash: rulesHash(root), projectHash: hash(readFileSync(join(root, '.easy-skills/project.yaml'), 'utf8'))};
  const after = JSON.stringify(agreement, null, 2) + '\n';
  return {path, before, after, agreement, hash: hash({path, before, after})};
}
export function applyAgreement(root: string, input: unknown, expectedHash: string) {
  const proposal = agreementProposal(root, input);
  if (proposal.hash !== expectedHash) throw new Error('Rules agreement changed since review');
  ensureDir(join(proposal.path, '..'));
  if (proposal.before !== null) copyFileSync(proposal.path, proposal.path + '.backup-' + proposal.agreement.version);
  const temp = proposal.path + '.tmp'; writeFileSync(temp, proposal.after, {flag: 'wx'}); renameSync(temp, proposal.path);
  return proposal.agreement;
}
export function requireAgreement(root: string, binding?: {version: number; hash: string}) {
  const path = agreementPath(root); rejectSymlinkPath(root, path);
  if (!existsSync(path)) throw new Error('Rules agreement missing: complete onboarding and review a replacement plan; existing runs are preserved');
  const agreement = Interview.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (agreement.status !== 'agreed' || agreement.conflicts.length || agreement.decisions.some(d => d.status !== 'resolved' || !d.answer?.trim())) throw new Error('Onboarding rules agreement is still a draft or unresolved');
  if (agreement.rulesHash !== rulesHash(root)) throw new Error('Rules agreement is stale after changes to project instructions or client controls; run easy-skills init to review and re-approve the rules');
  if (agreement.projectHash !== hash(readFileSync(join(root, '.easy-skills/project.yaml'), 'utf8'))) throw new Error('Project configuration changed after rules agreement');
  const current = {version: agreement.version, hash: hash(agreement)};
  if (binding && (binding.version !== current.version || binding.hash !== current.hash)) throw new Error('Plan rules agreement revision is stale');
  return current;
}
