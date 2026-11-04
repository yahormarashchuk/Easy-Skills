import { readFileSync, statSync } from 'node:fs';
import type { Evidence } from '../contracts.js';
import { redact } from '../util.js';

const DOTNET = /^\s*(?:Passed|Failed)!\s+-\s+Failed:\s*\d+,\s*Passed:\s*\d+,\s*Skipped:\s*\d+,\s*Total:\s*\d+/;
const UNITTEST_RAN = /^Ran \d+ tests? in /;
const UNITTEST_END = /^(?:OK|FAILED)\b.*$/;

/**
 * The totals line a check printed: dotnet's "Passed! - Failed: 0, Passed: 120, Skipped: 0, Total: 120" (one per test assembly) or
 * unittest's "Ran N tests" with its OK or FAILED line. Reviewers are shown it next to the exit code, because the runner records
 * executed, failed and skipped counts only in the check log and an agent that cannot see them cannot confirm them.
 */
export function checkSummary(log: string | undefined): string | undefined {
  if (!log) return undefined;
  try {
    if (statSync(log).size > 8_000_000) return undefined;
    const lines = readFileSync(log, 'utf8').split(/\r?\n/).map(line => line.replace(/\s+-\s+[^\s]+\.dll\s*\([^)]*\)\s*$/i, '').trim());
    const found = [...new Set(lines.filter(line => DOTNET.test(line)))].slice(-3);
    const ran = lines.findLast(line => UNITTEST_RAN.test(line)), end = lines.findLast(line => UNITTEST_END.test(line));
    if (ran) found.push(ran + (end ? ' ' + end : ''));
    return found.length ? redact(found.join('; ')).slice(0, 400) : undefined;
  } catch {return undefined;}
}

/** Evidence as an agent may see it: no log path, but the exit code and the totals the check printed. */
export const evidenceView = (evidence: Evidence) => ({checkId: evidence.checkId, head: evidence.head, code: evidence.code, finishedAt: evidence.finishedAt, summary: checkSummary(evidence.log)});
