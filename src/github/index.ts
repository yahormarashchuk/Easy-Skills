import { execute } from '../process.js';
import type { PullRequest, MergePolicy } from '../contracts.js';
import { ClientError } from '../adapters/index.js';
import { redact } from '../util.js';

export interface MergeOptions {base: string; policy?: MergePolicy; operationId?: string}
export interface MergeResult {state: 'merged' | 'pending' | 'enqueued'; operationId?: string}
export interface Issue {number: number; title: string; body: string; url: string; labels: string[]; state: string}
export class GitHubHttpError extends Error {
  constructor(readonly status: number, readonly body: any) {super(`GitHub HTTP ${status}: ${redact(body?.message || body?.details?.message || 'request failed')}`);}
}
export class MergeTerminalError extends Error {
  constructor(readonly state: 'failed' | 'expired', detail: string) {super(detail);}
}

export interface GitHub {
  readIssue?(number: number): Promise<Issue>;
  issue(key: string, title: string, body: string): Promise<number>;
  pr(key: string, title: string, body: string, head: string, base: string): Promise<PullRequest>;
  viewPr(number: number): Promise<PullRequest>;
  merge(number: number, head: string, options?: MergeOptions): Promise<MergeResult>;
  setIssue(number: number, open: boolean, comment: string): Promise<void>;
  comments(number: number, since?: string): Promise<{id: number; author: string; body: string; updatedAt?: string}[]>;
  commentOnce(number: number, key: string, body: string): Promise<void>;
  queueEntry?(number: number): Promise<boolean>;
  observeMerge?(number: number, head: string, operationId: string): Promise<MergeResult>;
}
export class Gh implements GitHub {
  constructor(readonly repository: string, readonly cwd: string, readonly runner = execute) {}
  async api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const args = ['api', '--hostname', 'github.com', `repos/${this.repository}/${path}`, '--method', method, '-H', 'X-GitHub-Api-Version: 2026-03-10'];
    if (body !== undefined) args.push('--input', '-');
    return this.request<T>(args, body);
  }
  private async request<T>(args: string[], body?: unknown): Promise<T> {
    const result = await this.runner({command: 'gh', args}, {cwd: this.cwd, role: 'github', input: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 120_000});
    if (result.truncated) throw new Error('GitHub response exceeded capture limit; refusing incomplete data');
    if (result.code === 4) throw new ClientError('auth', 'GitHub authentication required; run gh auth login');
    let value: any;
    try {value = result.stdout ? JSON.parse(result.stdout) : undefined;} catch {
      throw new Error('Invalid GitHub JSON response: ' + redact(result.stderr));
    }
    if (result.code !== 0) {
      const status = Number(result.stderr.match(/HTTP\s+(\d{3})|\((\d{3})\)/)?.slice(1).find(Boolean) || 0);
      if (status === 403 && /^(?:API rate limit exceeded\b|You have exceeded a secondary rate limit\b)/i.test(value?.message || ''))
        throw new ClientError('quota', 'GitHub rate limit exceeded');
      if ([401, 403].includes(status)) throw new ClientError('auth', 'GitHub authentication or authorization required');
      if (status === 429) throw new ClientError('quota', 'GitHub rate limit exceeded');
      if ([500, 502, 503, 504].includes(status)) throw new ClientError('network', 'GitHub temporarily unavailable');
      if (status) throw new GitHubHttpError(status, value);
      if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|connection refused|unable to connect/i.test(result.stderr)) throw new ClientError('network', redact(result.stderr));
      throw new ClientError('protocol', redact(result.stderr || 'GitHub transport failed without a structured status'));
    }
    return value as T;
  }
  async queueEntry(number: number): Promise<boolean> {
    const [owner, name] = this.repository.split('/');
    const result = await this.request<any>(['api', '--hostname', 'github.com', 'graphql', '--input', '-'], {
      query: 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{id}}}}',
      variables: {owner, name, number}});
    if (result.errors || !result.data?.repository?.pullRequest) throw new Error('Cannot establish merge queue membership');
    const entry = result.data.repository.pullRequest.mergeQueueEntry;
    if (entry === null) return false;
    if (!entry || typeof entry.id !== 'string') throw new Error('Incomplete merge queue membership response');
    return true;
  }
  async readIssue(number: number): Promise<Issue> {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Use a positive Issue number');
    const issue = await this.api<any>(`issues/${number}`);
    if (issue.pull_request) throw new Error('The supplied number identifies a Pull Request, not an Issue');
    if (issue.number !== number || typeof issue.title !== 'string' || issue.body != null && typeof issue.body !== 'string' || typeof issue.state !== 'string' || !Array.isArray(issue.labels || []))
      throw new Error('GitHub returned an incomplete or mismatched Issue');
    return {number, title: redact(issue.title), body: redact(issue.body || ''), url: `https://github.com/${this.repository}/issues/${number}`,
      labels: (issue.labels || []).map((label: any) => redact(typeof label === 'string' ? label : String(label.name))), state: issue.state};
  }
  async issue(key: string, title: string, body: string): Promise<number> {
    const marker = `<!-- easy-skills:${key} -->`;
    for (let page = 1; ; page++) {
      const issues = await this.api<{number: number; body: string; pull_request?: unknown}[]>(`issues?state=all&per_page=100&page=${page}`);
      const match = issues.find(i => !i.pull_request && i.body?.includes(marker));
      if (match) return match.number;
      if (issues.length < 100) break;
    }
    const issue = await this.api<{number: number}>('issues', 'POST', {title: redact(title), body: `${redact(body)}\n\n${marker}`});
    return issue.number;
  }
  private fromApi(pr: any): PullRequest {
    return {number: pr.number, url: pr.html_url, headRefOid: pr.head.sha,
      state: pr.merged_at ? 'MERGED' : String(pr.state).toUpperCase(), mergedAt: pr.merged_at,
      baseRefName: pr.base.ref, headRefName: pr.head.ref, baseRefOid: pr.base.sha};
  }
  async pr(key: string, title: string, body: string, head: string, base: string): Promise<PullRequest> {
    const marker = `<!-- easy-skills:${key} -->`;
    for (let page = 1; ; page++) {
      const prs = await this.api<any[]>(`pulls?state=all&head=${encodeURIComponent(this.repository.split('/')[0] + ':' + head)}&base=${encodeURIComponent(base)}&per_page=100&page=${page}`);
      const match = prs.find(pr => pr.body?.includes(marker));
      if (match) {
        if (match.state !== 'open' || match.merged_at) throw new Error('Existing task PR is closed or merged; reconcile before publishing');
        // Refresh the same PR after feedback; the stable marker also recovers PATCH interruptions.
        return this.fromApi(await this.api(`pulls/${match.number}`, 'PATCH', {title: redact(title), body: `${redact(body)}\n\n${marker}`}));
      }
      if (prs.length < 100) break;
    }
    return this.fromApi(await this.api('pulls', 'POST', {title: redact(title), body: `${redact(body)}\n\n${marker}`, head, base, draft: false}));
  }
  async viewPr(number: number) {return this.fromApi(await this.api(`pulls/${number}`));}
  async observeMerge(number: number, head: string, operationId: string): Promise<MergeResult> {
    const pr = await this.viewPr(number);
    if (pr.headRefOid !== head) throw new Error('PR head changed after review');
    if (pr.state === 'MERGED' && pr.mergedAt) return {state: 'merged', operationId};
    let observed: any;
    try {observed = await this.api<any>(`pulls/${number}/merge-async/${encodeURIComponent(operationId)}`);}
    catch (error) {if (error instanceof GitHubHttpError && error.status === 404) throw new MergeTerminalError('expired', 'GitHub merge request expired (HTTP 404)'); throw error;}
    if (!['merged', 'pending', 'enqueued'].includes(observed.status)) throw new MergeTerminalError('failed', 'GitHub merge failed: ' + (observed.details?.message || observed.status));
    return {state: observed.status, operationId};
  }
  async merge(number: number, head: string, options?: MergeOptions): Promise<MergeResult> {
    if (!options?.policy) throw new Error('No agreed GitHub merge policy; review project.mergePolicy in a new approved plan');
    if (options.operationId) return this.observeMerge(number, head, options.operationId);
    const pr = await this.viewPr(number);
    if (pr.headRefOid !== head) throw new Error('PR head changed after review');
    if (pr.state === 'MERGED' && pr.mergedAt) return {state: 'merged'};
    if (pr.baseRefOid !== options.base) throw new Error('PR base changed; sync and validate again');
    const branch = encodeURIComponent(pr.baseRefName), policy = options.policy;
    const rules = await this.api<any[]>(`rules/branches/${branch}?per_page=100`);
    // Refuse incomplete discovery rather than silently ignoring another page of effective rules.
    if (rules.length >= 100) throw new Error('Effective branch rules exceed supported discovery limit; merge stopped');
    let classic: any;
    try {classic = await this.api(`branches/${branch}/protection`);} catch (e) {
      if (!(e instanceof GitHubHttpError && e.status === 404) && !/HTTP 404|\(404\)/.test(String(e))) throw e;
    }
    const strictRules = rules.filter(r => r.type === 'required_status_checks' && r.parameters?.strict_required_status_checks_policy === true);
    const classicStrict = classic?.required_status_checks?.strict === true && classic?.enforce_admins?.enabled === true;
    const queue = rules.some(r => r.type === 'merge_queue');
    if (policy.mode === 'queue' ? !queue : !classicStrict && !strictRules.length)
      throw new Error(`Cannot prove server freshness: ${policy.mode === 'queue' ? 'an effective merge queue' : 'strict required checks enforced for administrators or an active strict ruleset'} is required; branch settings were not changed`);
    const enforced = [...(classic?.required_status_checks?.checks || []).map((c: any) => ({name: c.context, appId: c.app_id})),
      ...rules.filter(r => r.type === 'required_status_checks').flatMap(r => (r.parameters?.required_status_checks || []).map((c: any) => ({name: c.context, appId: c.integration_id})))];
    for (const check of policy.requiredChecks) if (!enforced.some(c => c.name === check.name && (!check.appId || c.appId === check.appId)))
      throw new Error('Agreed check is not server-required for target branch: ' + check.name);
    const runs = await this.api<{check_runs: any[]}>(`commits/${head}/check-runs?per_page=100&filter=latest`);
    const statuses = await this.api<any[]>(`commits/${head}/statuses?per_page=100`);
    if (runs.check_runs.length >= 100 || statuses.length >= 100) throw new Error('Check discovery limit reached; merge stopped');
    for (const check of policy.requiredChecks) {
      const matches = runs.check_runs.filter(c => c.name === check.name && (!check.appId || c.app?.id === check.appId));
      const legacy = check.appId ? undefined : statuses.find(c => c.context === check.name);
      if (!matches.length && !legacy) throw new Error('Required GitHub check missing: ' + check.name);
      if (matches.some(c => c.status !== 'completed') || legacy?.state === 'pending') throw new ClientError('waiting_ci', 'Required GitHub check pending: ' + check.name);
      if (matches.some(c => c.conclusion !== 'success') || (legacy && legacy.state !== 'success')) throw new Error('Required GitHub check failed: ' + check.name);
    }
    const path = `pulls/${number}/merge-async`;
    const result = options.operationId ? await this.api<any>(`${path}/${encodeURIComponent(options.operationId)}`)
      : await this.api<any>(path, 'PUT', {sha: head, merge_method: policy.mode === 'strict' ? 'merge' : undefined,
        merge_action: policy.mode === 'queue' ? 'merge_queue' : 'direct_merge', bypass_rules: false}).catch(error => {
          if (!(error instanceof GitHubHttpError) || error.status !== 409) throw error;
          const existing = error.body;
          if (existing?.status !== 'pending' || !existing.details?.uuid || existing.details.expected_head_sha !== head || existing.details.bypass_rules !== false ||
            existing.details.merge_action !== (policy.mode === 'queue' ? 'merge_queue' : 'direct_merge')) throw new Error('Existing GitHub merge request does not match the approved intent');
          return existing;
        });
    if (result.status === 'failed') throw new MergeTerminalError('failed', 'GitHub merge failed: ' + (result.details?.message || result.status));
    if (!['merged', 'pending', 'enqueued'].includes(result.status)) throw new Error('Unknown GitHub merge response: ' + result.status);
    return {state: result.status, operationId: result.details?.uuid};
  }
  async setIssue(number: number, open: boolean, comment: string) {
    await this.commentOnce(number, `${open ? 'reopen' : 'close'}-${Buffer.from(comment).toString('base64url')}`, comment);
    await this.api(`issues/${number}`, 'PATCH', {state: open ? 'open' : 'closed'});
  }
  async comments(number: number, since?: string): Promise<{id: number; author: string; body: string; updatedAt?: string}[]> {
    const all: {id: number; author: string; body: string; updatedAt?: string}[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.api<{id: number; body: string; updated_at: string; user: {login: string}}[]>(`issues/${number}/comments?per_page=100&page=${page}${since ? '&since=' + encodeURIComponent(since) : ''}`);
      all.push(...batch.map(c => ({id: c.id, author: c.user.login, body: c.body, updatedAt: c.updated_at})));
      if (batch.length < 100) return all;
    }
  }
  async commentOnce(number: number, key: string, body: string) {
    const marker = `<!-- easy-skills:${key} -->`;
    if ((await this.comments(number)).some(c => c.body.includes(marker))) return;
    await this.api(`issues/${number}/comments`, 'POST', {body: `${redact(body)}\n\n${marker}`});
  }
}
