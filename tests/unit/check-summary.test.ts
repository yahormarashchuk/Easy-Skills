import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSummary, evidenceView } from '../../src/runner/check-summary.js';

const dir = mkdtempSync(join(tmpdir(), 'check-summary-'));
const log = (name: string, text: string) => {const path = join(dir, name); writeFileSync(path, text); return path;};

test('the totals a check printed are shown next to its exit code', () => {
  const dotnet = log('dotnet.log', ['Starting test execution', 'Passed!  - Failed:     0, Passed:   293, Skipped:     6, Total:   299, Duration: 1 m 35 s - LeistungsTesting.Application.Tests.dll (net10.0)', ''].join('\r\n'));
  assert.equal(checkSummary(dotnet), 'Passed!  - Failed:     0, Passed:   293, Skipped:     6, Total:   299, Duration: 1 m 35 s');
  const failed = log('failed.log', 'Failed!  - Failed:     9, Passed:   111, Skipped:     0, Total:   120, Duration: 1 m 5 s - X.dll (net10.0)\n');
  assert.match(checkSummary(failed)!, /^Failed!\s+- Failed:\s+9, Passed:\s+111, Skipped:\s+0, Total:\s+120/);
  const two = log('two.log', 'Passed!  - Failed: 0, Passed: 5, Skipped: 0, Total: 5 - A.dll (net10.0)\nPassed!  - Failed: 0, Passed: 7, Skipped: 1, Total: 8 - B.dll (net10.0)\n');
  assert.match(checkSummary(two)!, /Passed: 5.*; .*Passed: 7, Skipped: 1/);
  const unittest = log('unit.log', 'test_one ... ok\n\nRan 41 tests in 0.5s\n\nOK (skipped=2)\n');
  assert.equal(checkSummary(unittest), 'Ran 41 tests in 0.5s OK (skipped=2)');
});

test('a log without totals, a missing log and a huge log give no summary and never throw', () => {
  assert.equal(checkSummary(log('plain.log', 'nothing useful here\n')), undefined);
  assert.equal(checkSummary(join(dir, 'missing.log')), undefined);
  assert.equal(checkSummary(undefined), undefined);
});

test('the evidence an agent sees has the totals and no log path', () => {
  const view = evidenceView({checkId: 'efcore-checkin-tests', head: 'a'.repeat(40), code: 0, finishedAt: '2026-11-04T10:00:00.000Z',
    log: log('efcore.log', 'Passed!  - Failed: 0, Passed: 120, Skipped: 0, Total: 120 - T.dll (net10.0)\n')});
  assert.deepEqual(Object.keys(view).sort(), ['checkId', 'code', 'finishedAt', 'head', 'summary']);
  assert.equal(view.summary, 'Passed!  - Failed: 0, Passed: 120, Skipped: 0, Total: 120');
  rmSync(dir, {recursive: true, force: true});
});
