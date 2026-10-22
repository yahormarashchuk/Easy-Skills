import type { Check, Run } from '../contracts.js';
import { redact } from '../util.js';

export function cleanExcerpt(text: string, privateHome: string): string {
  let clean = text;
  for (const home of [privateHome.replaceAll('\\', '\\\\'), privateHome.replaceAll('\\', '/'), privateHome]) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean.replace(new RegExp(escaped, 'gi'), '<runner-private>');
  }
  for (const [key, value] of Object.entries(process.env)) if (/secret|token|password|api_?key/i.test(key) && value && value.length >= 6) clean = clean.replaceAll(value, '[REDACTED]');
  return redact(clean).replace(/\x1b\[[0-9;]*m/g, '').slice(-6000);
}
export class CheckFailure extends Error {
  constructor(readonly bundle: ReturnType<typeof failureBundle>) {super(`Required check ${bundle.checkId} ${bundle.classification} (${bundle.exitCode})`);}
}
export function failureBundle(check: Check, result: {code: number; stdout: string; stderr: string; timedOut?: boolean}, run: Run, home: string) {
  const stdout = cleanExcerpt(result.stdout, home), stderr = cleanExcerpt(result.stderr, home);
  return {checkId: check.id, command: cleanExcerpt(JSON.stringify({command: check.command, args: check.args}), home),
    exitCode: result.code, classification: result.code === -1 || result.code === 127 ? 'unavailable' : result.timedOut ? 'timed_out' : 'regression',
    tests: (stdout + '\n' + stderr).split(/\r?\n/).filter(line => /not ok|✖|FAIL(?:ED)?|AssertionError/.test(line)).slice(0, 15),
    stdout, stderr, previousUnsuccessfulAttempts: run.failures.count,
    expected: 'Make this approved check and the task acceptance criteria pass without weakening tests, changing commands, or repairing unrelated legacy behavior.'};
}
