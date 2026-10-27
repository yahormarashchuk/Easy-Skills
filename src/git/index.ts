import { join, resolve, dirname } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { checked, execute } from '../process.js';
import { ensureDir, isInside } from '../util.js';
import { githubRepository } from './remotes.js';

export class Git {
  constructor(public root: string, private gate?: <T>(operation: () => Promise<T>) => Promise<T>,
    private remotePolicy?: {repository: string; testRemote?: string}) {}
  run(args: string[], cwd = this.root): Promise<string> {
    const operation = async () => {
      if (['fetch', 'push', 'ls-remote'].includes(args[0]!)) await this.validateRemotes(cwd);
      return checked('git', args, cwd, undefined, !args.includes('-z') && args[0] !== 'diff');
    };
    // Worktrees share refs and FETCH_HEAD. Serialize their mutations across features.
    return this.gate && ['fetch', 'push', 'worktree', 'update-ref'].includes(args[0]!) ? this.gate(operation) : operation();
  }
  async validateRemotes(cwd = this.root) {
    if (!this.remotePolicy) throw new Error('External Git operation requires an approved repository policy');
    for (const direction of [[], ['--push']]) {
      const urls = (await checked('git', ['remote', 'get-url', ...direction, '--all', 'origin'], cwd)).split(/\r?\n/);
      if (!urls.length) throw new Error('origin has no effective destination');
      for (const url of urls) if (url.replaceAll('\\', '/') !== this.remotePolicy.testRemote?.replaceAll('\\', '/') && githubRepository(url) !== this.remotePolicy.repository.toLowerCase())
        throw new Error('Effective origin destination differs from the approved GitHub repository');
    }
  }
  async identity(): Promise<{root: string; commonDir: string}> {
    const root = realpathSync.native(await this.run(['rev-parse', '--show-toplevel']));
    const commonDir = realpathSync.native(await this.run(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    return {root, commonDir};
  }
  async validateRef(ref: string) {
    if (ref.startsWith('-')) throw new Error('Invalid branch name');
    await this.run(['check-ref-format', '--branch', ref]);
  }
  async clean(cwd: string, includeIgnored = false) {
    const args = ['status', '--porcelain=v1', '--untracked-files=all'];
    if (includeIgnored) args.push('--ignored=matching');
    if (await this.run(args, cwd)) throw new Error('Worktree contains uncommitted, untracked or ignored files: ' + cwd);
    if (existsSync(await this.run(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], cwd))) throw new Error('A merge is already in progress');
  }
  head(cwd: string) {return this.run(['rev-parse', 'HEAD'], cwd);}
  async fetch() {await this.run(['fetch', 'origin', '--prune']);}
  async remoteHead(branch: string): Promise<string | undefined> {
    await this.validateRef(branch);
    const result = await this.run(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    return result.split(/\s/)[0] || undefined;
  }
  async branchExists(branch: string): Promise<boolean> {
    const result = await execute({command: 'git', args: ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]}, {cwd: this.root});
    if (![0, 1].includes(result.code)) throw new Error(result.stderr);
    return result.code === 0;
  }
  async worktree(branch: string, base: string, path: string, owned = false): Promise<string> {
    await this.validateRef(branch);
    ensureDir(dirname(path));
    const list = await this.run(['worktree', 'list', '--porcelain', '-z']);
    const matching = list.split('\0\0').find(block => block.split('\0').includes(`branch refs/heads/${branch}`));
    if (matching) {
      const p = matching.split('\0')[0]!.slice('worktree '.length);
      if (!owned || !existsSync(path) || realpathSync.native(p) !== realpathSync.native(path)) throw new Error('Branch has an unowned worktree: ' + branch);
      return realpathSync.native(p);
    }
    if (await this.branchExists(branch)) {
      if (!owned) throw new Error('Refusing to adopt existing branch: ' + branch);
      await this.run(['worktree', 'add', path, branch]);
    } else await this.run(['worktree', 'add', '-b', branch, path, base]);
    return realpathSync.native(path);
  }
  async merge(cwd: string, ref: string): Promise<{conflicts: string[]; before: string}> {
    await this.clean(cwd);
    const before = await this.head(cwd);
    const result = await execute({command: 'git', args: ['merge', '--no-edit', '--no-ff', ref]}, {cwd});
    if (result.code === 0) return {conflicts: [], before};
    const conflicts = (await this.run(['diff', '--name-only', '--diff-filter=U'], cwd)).split(/\r?\n/).filter(Boolean);
    if (!conflicts.length) throw new Error(result.stderr || result.stdout);
    return {conflicts, before};
  }
  async commit(cwd: string, title: string): Promise<string> {
    await this.run(['add', '--all'], cwd);
    const diff = await execute({command: 'git', args: ['diff', '--cached', '--quiet']}, {cwd});
    const merging = existsSync(await this.run(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], cwd));
    if (diff.code === 1 || (diff.code === 0 && merging)) await this.run(['commit', '-m', title], cwd);
    else if (diff.code !== 0) throw new Error(diff.stderr);
    return this.head(cwd);
  }
  async push(branch: string, cwd: string) {
    if (await this.run(['symbolic-ref', '--short', 'HEAD'], cwd) !== branch) throw new Error('Worktree branch ownership changed before push');
    await this.run(['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], cwd);
  }
  async assertOwned(path: string, branch: string, allowedRoot: string) {
    if (!isInside(allowedRoot, path)) throw new Error('Worktree is outside the owned resource directory');
    const actual = await this.run(['symbolic-ref', '--short', 'HEAD'], path);
    if (actual !== branch) throw new Error('Worktree branch ownership changed');
    const identity = await new Git(path).identity();
    if (identity.commonDir !== (await this.identity()).commonDir) throw new Error('Worktree belongs to another repository');
    const registered = await this.run(['worktree', 'list', '--porcelain', '-z']);
    if (!registered.split('\0').filter(p => p.startsWith('worktree ')).some(p => realpathSync.native(p.slice(9)) === realpathSync.native(path)))
      throw new Error('Worktree is not registered');
  }
  async removeOwned(path: string, branch: string, allowedRoot: string) {
    await this.assertOwned(path, branch, allowedRoot); await this.clean(path, true);
    await this.run(['worktree', 'remove', path]);
    // Squash merges are validated through GitHub; retain branches rather than force-delete them.
  }
}
