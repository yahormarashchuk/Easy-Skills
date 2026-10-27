import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gh } from '../../src/github/index.js';

test('Issue reads preserve labels and reject PR numbers without consulting branch protection', async () => {
  const paths: string[] = [];
  const gh = new Gh('test/example', '.', async command => {
    const path = command.args.find(a => a.startsWith('repos/'))!; paths.push(path);
    return {code: 0, stdout: JSON.stringify({number: 909, title: 'Names', body: 'Preserve scope', html_url: 'https://github.com/test/example/issues/909', labels: [{name: 'bug'}, 'search'], state: 'open',
      ...(path.endsWith('/12') ? {pull_request: {}} : {})}), stderr: '', truncated: false, timedOut: false};
  });
  assert.deepEqual((await gh.readIssue(909)).labels, ['bug', 'search']);
  await assert.rejects(gh.readIssue(12), /Pull Request/);
  await assert.rejects(gh.readIssue(0), /positive/);
  assert.deepEqual(paths, ['repos/test/example/issues/909', 'repos/test/example/issues/12']);
});

test('PR revision patches the existing marked PR and refuses closed delivery without creating a replacement', async () => {
  const methods: string[] = [];
  const object = {number: 42, html_url: 'https://github.com/test/example/pull/42', head: {sha: 'a'.repeat(40), ref: 'codex/issue-909'}, base: {sha: 'b'.repeat(40), ref: 'main'},
    body: 'Original\n<!-- easy-skills:run:final -->', state: 'open', merged_at: null};
  const gh = new Gh('test/example', '.', async (command, options) => {
    const method = command.args[command.args.indexOf('--method') + 1]!; methods.push(method);
    if (method === 'PATCH') assert.equal(JSON.parse(options.input!).title, 'Updated task');
    return {code: 0, stdout: JSON.stringify(method === 'GET' ? [object] : object), stderr: '', truncated: false, timedOut: false};
  });
  assert.equal((await gh.pr('run:final', 'Updated task', 'Updated evidence', 'codex/issue-909', 'main')).number, 42);
  assert.deepEqual(methods, ['GET', 'PATCH']);
  object.state = 'closed';
  await assert.rejects(gh.pr('run:final', 'Updated task', 'Updated evidence', 'codex/issue-909', 'main'), /closed or merged/);
  assert.deepEqual(methods, ['GET', 'PATCH', 'GET']);
});
