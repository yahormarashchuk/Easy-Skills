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

test('a PR receives only existing matching labels and the signed-in account as assignee', async () => {
  const calls: {path: string; method: string; body?: unknown}[] = [];
  const gh = new Gh('test/example', '.', async (command, options) => {
    const path = (command.args[3] || '').replace('repos/test/example/', ''), method = command.args[command.args.indexOf('--method') + 1] || 'GET';
    calls.push({path, method, body: options.input ? JSON.parse(options.input) : undefined});
    let value: unknown = {};
    if (path.startsWith('pulls?')) value = [];
    else if (path === 'pulls') value = {number: 7, html_url: 'https://github.com/test/example/pull/7', head: {sha: 'a'.repeat(40), ref: 'h'}, base: {sha: 'b'.repeat(40), ref: 'main'}, state: 'open', merged_at: null};
    else if (path.startsWith('labels?')) value = [{name: 'Blazor'}, {name: 'Studio'}, {name: 'Unrelated'}];
    else if (command.args.includes('user')) value = {login: 'fixture-owner'};
    return {code: 0, stdout: JSON.stringify(value), stderr: '', truncated: false, timedOut: false};
  });
  assert.equal((await gh.pr('run:final', 'Title', 'Body', 'h', 'main', {labels: ['blazor', 'studio', 'missing'], assignSelf: true})).number, 7);
  assert.deepEqual(calls.find(c => c.path === 'issues/7/labels')?.body, {labels: ['Blazor', 'Studio']});
  assert.deepEqual(calls.find(c => c.path === 'issues/7/assignees')?.body, {assignees: ['fixture-owner']});
  calls.length = 0;
  await gh.pr('run:final', 'Title', 'Body', 'h', 'main');
  assert.ok(!calls.some(c => c.path.includes('labels') || c.path.includes('assignees')), 'no metadata, no extra requests');
});
