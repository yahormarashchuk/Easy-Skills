import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gh, GitHubHttpError } from '../../src/github/index.js';

class Server extends Gh {
  writes: any[] = []; state = 'success'; strict = true; base = 'base'; queued = false;
  constructor() {super('fixture/repo', '.');}
  override async api<T>(path: string, method = 'GET', body?: any): Promise<T> {
    let value: any;
    if (method !== 'GET') {
      this.writes.push({path, body});
      if (this.base === 'raced') throw new Error('Server rejected stale branch: strict status checks');
      value = {status: this.queued ? 'enqueued' : 'merged', details: {uuid: 'request-id'}};
    } else if (path === 'pulls/1') value = {number: 1, html_url: '', head: {sha: 'head', ref: 'source'}, base: {sha: this.base, ref: 'main'}, state: 'open', merged_at: null};
    else if (path.startsWith('rules/branches/')) value = [];
    else if (path.endsWith('/protection')) value = {enforce_admins: {enabled: true}, required_status_checks: {strict: this.strict, checks: [{context: 'ci', app_id: 7}]}};
    else if (path.includes('/check-runs')) value = {check_runs: this.state === 'missing' ? [] : [{id: 1, name: 'ci', app: {id: 7}, status: this.state === 'pending' ? 'in_progress' : 'completed', conclusion: this.state}]};
    else if (path.includes('/statuses')) value = [];
    else throw new Error('Unhandled fixture route ' + path);
    return value as T;
  }
}
const policy = {mode: 'strict' as const, requiredChecks: [{name: 'ci', appId: 7}]};
for (const state of ['pending', 'failure', 'missing']) test(`merge gate blocks ${state} CI`, async () => {
  const gh = new Server(); gh.state = state;
  await assert.rejects(gh.merge(1, 'head', {base: 'base', policy}), new RegExp(state === 'failure' ? 'failed' : state));
  assert.equal(gh.writes.length, 0);
});
test('merge gate requires explicit policy and server freshness, with bypass disabled', async () => {
  const gh = new Server();
  await assert.rejects(gh.merge(1, 'head'), /policy/i);
  gh.strict = false;
  await assert.rejects(gh.merge(1, 'head', {base: 'base', policy}), /strict|freshness/i);
  gh.strict = true;
  await gh.merge(1, 'head', {base: 'base', policy});
  assert.equal(gh.writes[0].body.bypass_rules, false);
  assert.equal(gh.writes[0].body.sha, 'head');
});
test('a base race is rejected by server enforcement and queued is not merged', async () => {
  const gh = new Server();
  const api = gh.api.bind(gh);
  gh.api = async <T>(path: string, method?: string, body?: any): Promise<T> => {
    const result = await api<T>(path, method, body);
    if (path.includes('/statuses')) gh.base = 'raced';
    return result;
  };
  await assert.rejects(gh.merge(1, 'head', {base: 'base', policy}), /Server rejected/);
  const queued = new Server(); queued.queued = true;
  assert.equal((await queued.merge(1, 'head', {base: 'base', policy})).state, 'enqueued');
});

test('retry after a lost asynchronous response reconciles an existing 409 operation', async () => {
  const gh = new Server(), api = gh.api.bind(gh);
  gh.api = async <T>(path: string, method?: string, body?: any): Promise<T> => {
    if (path.endsWith('/merge-async')) throw new GitHubHttpError(409, {status: 'pending', details: {uuid: 'existing-operation', expected_head_sha: 'head', bypass_rules: false, merge_action: 'direct_merge'}});
    return api<T>(path, method, body);
  };
  const result = await gh.merge(1, 'head', {base: 'base', policy});
  assert.equal(result.state, 'pending'); assert.equal(result.operationId, 'existing-operation');
});
