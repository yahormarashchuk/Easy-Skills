import { checked } from '../process.js';
import type { PullRequest } from '../contracts.js';

export interface GitHub {
  issue(key: string, title: string, body: string): Promise<number>;
  pr(key: string, title: string, body: string, head: string, base: string): Promise<PullRequest>;
  viewPr(number: number): Promise<PullRequest>;
  merge(number: number, head: string): Promise<void>;
  setIssue(number: number, open: boolean, comment: string): Promise<void>;
  comments(number: number): Promise<{id: number; author: string; body: string}[]>;
  commentOnce(number: number, key: string, body: string): Promise<void>;
}
export class Gh implements GitHub {
  constructor(readonly repository: string, readonly cwd: string) {}
  async api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const args = ['api', `repos/${this.repository}/${path}`, '--method', method];
    if (body !== undefined) args.push('--input', '-');
    const output = await checked('gh', args, this.cwd, body === undefined ? undefined : JSON.stringify(body));
    return output ? JSON.parse(output) as T : undefined as T;
  }
  async issue(key: string, title: string, body: string): Promise<number> {
    const marker = `<!-- easy-skills:${key} -->`;
    for (let page = 1; ; page++) {
      const issues = await this.api<{number: number; body: string; pull_request?: unknown}[]>(`issues?state=all&per_page=100&page=${page}`);
      const match = issues.find(i => !i.pull_request && i.body?.includes(marker));
      if (match) return match.number;
      if (issues.length < 100) break;
    }
    const issue = await this.api<{number: number}>('issues', 'POST', {title, body: `${body}\n\n${marker}`});
    return issue.number;
  }
  private fromApi(pr: any): PullRequest {
    return {number: pr.number, url: pr.html_url, headRefOid: pr.head.sha,
      state: pr.merged_at ? 'MERGED' : String(pr.state).toUpperCase(), mergedAt: pr.merged_at,
      baseRefName: pr.base.ref, headRefName: pr.head.ref};
  }
  async pr(key: string, title: string, body: string, head: string, base: string): Promise<PullRequest> {
    const marker = `<!-- easy-skills:${key} -->`;
    for (let page = 1; ; page++) {
      const prs = await this.api<any[]>(`pulls?state=all&head=${encodeURIComponent(this.repository.split('/')[0] + ':' + head)}&base=${encodeURIComponent(base)}&per_page=100&page=${page}`);
      const match = prs.find(pr => pr.body?.includes(marker));
      if (match) return this.fromApi(match);
      if (prs.length < 100) break;
    }
    return this.fromApi(await this.api('pulls', 'POST', {title, body: `${body}\n\n${marker}`, head, base, draft: false}));
  }
  async viewPr(number: number) {return this.fromApi(await this.api(`pulls/${number}`));}
  async merge(number: number, head: string) {
    // GitHub branch protections, CI, and independent approval requirements still apply.
    const result = await this.api<{merged: boolean; message: string}>(`pulls/${number}/merge`, 'PUT', {sha: head, merge_method: 'merge'});
    if (!result.merged) throw new Error('GitHub refused merge: ' + result.message);
  }
  async setIssue(number: number, open: boolean, comment: string) {
    await this.commentOnce(number, `${open ? 'reopen' : 'close'}-${Buffer.from(comment).toString('base64url')}`, comment);
    await this.api(`issues/${number}`, 'PATCH', {state: open ? 'open' : 'closed'});
  }
  async comments(number: number): Promise<{id: number; author: string; body: string}[]> {
    const all: {id: number; author: string; body: string}[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.api<{id: number; body: string; user: {login: string}}[]>(`issues/${number}/comments?per_page=100&page=${page}`);
      all.push(...batch.map(c => ({id: c.id, author: c.user.login, body: c.body})));
      if (batch.length < 100) return all;
    }
  }
  async commentOnce(number: number, key: string, body: string) {
    const marker = `<!-- easy-skills:${key} -->`;
    if ((await this.comments(number)).some(c => c.body.includes(marker))) return;
    await this.api(`issues/${number}/comments`, 'POST', {body: `${body}\n\n${marker}`});
  }
}
