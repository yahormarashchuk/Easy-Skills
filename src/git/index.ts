import { join, resolve, dirname } from 'node:path';
import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { checked, execute } from '../process.js';
import { ensureDir, instructionPaths, isInside } from '../util.js';
import { githubRepository } from './remotes.js';

export class Git {
  /** Used only when Git has no configured identity, so commits never depend on host-name guesses. */
  author?: {name: string; email: string};
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
  /**
   * A build server or test host that was just stopped can leave a file for a moment, so a dirty tree is looked at once more after
   * `settleMs`; what still remains is named, the owner needs the paths to act.
   */
  async clean(cwd: string, includeIgnored = false, settleMs = 4_000) {
    const args = ['status', '--porcelain=v1', '--untracked-files=all'];
    if (includeIgnored) args.push('--ignored=matching');
    let dirty = await this.run(args, cwd);
    if (dirty) {await new Promise(resolve => setTimeout(resolve, settleMs)); dirty = await this.run(args, cwd);}
    if (dirty) {
      const files = dirty.split('\n').map(line => line.slice(3).trim()).filter(Boolean);
      throw new Error('Worktree contains uncommitted, untracked or ignored files: ' + cwd + ' (' + files.slice(0, 5).join(', ') + (files.length > 5 ? ', and ' + (files.length - 5) + ' more' : '') + ')');
    }
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
  /** Task worktrees nest deep under the state directory; Git for Windows cannot check out deep paths without core.longpaths. */
  async enableLongPaths(platform: NodeJS.Platform = process.platform): Promise<boolean> {
    if (platform !== 'win32') return false;
    const current = await execute({command: 'git', args: ['config', '--local', '--type=bool', '--get', 'core.longpaths']}, {cwd: this.root});
    if (current.code === 0 && current.stdout.trim() === 'true') return false;
    if (![0, 1].includes(current.code)) throw new Error(current.stderr);
    await this.run(['config', '--local', 'core.longpaths', 'true']);
    return true;
  }
  async worktree(branch: string, base: string, path: string, owned = false): Promise<string> {
    await this.validateRef(branch);
    await this.enableLongPaths();
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
    const result = await execute({command: 'git', args: [...this.authorConfig(), 'merge', '--no-edit', '--no-ff', ref]}, {cwd});
    if (result.code === 0) return {conflicts: [], before};
    const conflicts = (await this.run(['diff', '--name-only', '--diff-filter=U'], cwd)).split(/\r?\n/).filter(Boolean);
    if (!conflicts.length) throw new Error(result.stderr || result.stdout);
    return {conflicts, before};
  }
  private authorConfig() {return this.author ? ['-c', `user.name=${this.author.name}`, '-c', `user.email=${this.author.email}`] : [];}
  async hasAuthor(): Promise<boolean> {
    return (await execute({command: 'git', args: ['var', 'GIT_AUTHOR_IDENT']}, {cwd: this.root})).code === 0;
  }
  /**
   * Copies the source checkout's uncommitted versions of in-scope files into a new task worktree, so approved inputs
   * that were never committed are available to BUILD. Ignored files and managed project knowledge are never copied.
   */
  async carryUncommitted(source: string, target: string, paths: string[]): Promise<string[]> {
    if (!paths.length) return [];
    const changed = (await this.run(['diff', '--name-only', '-z', 'HEAD', '--', ...paths], source)).split('\0');
    changed.push(...(await this.run(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], source)).split('\0'));
    const carried: string[] = [];
    for (const file of [...new Set(changed.filter(p => p && !p.startsWith('.easy-skills/')))].sort()) {
      const from = join(source, file), to = join(target, file);
      if (existsSync(from)) {
        if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
        ensureDir(dirname(to)); copyFileSync(from, to);
      } else if (existsSync(to)) rmSync(to);
      else continue;
      carried.push(file);
    }
    return carried;
  }
  /**
   * Git-ignored instruction and client-control files (generated skills, local client settings) exist only in the source
   * checkout, yet the approved rules hash binds them. Copying them keeps every stage on the same instructions; being
   * ignored, they never enter a commit.
   */
  async carryIgnoredControls(source: string, target: string): Promise<string[]> {
    const candidates = instructionPaths(source).filter(p => !p.startsWith('.easy-skills/'));
    if (!candidates.length) return [];
    const result = await execute({command: 'git', args: ['check-ignore', '-z', '--stdin']}, {cwd: source, input: candidates.join('\0') + '\0'});
    if (![0, 1].includes(result.code)) throw new Error(result.stderr);
    const carried: string[] = [];
    for (const file of result.stdout.split('\0').filter(Boolean)) {
      const from = join(source, file), to = join(target, file);
      if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
      ensureDir(dirname(to)); copyFileSync(from, to);
      carried.push(file);
    }
    return carried;
  }
  async commit(cwd: string, title: string): Promise<string> {
    await this.run(['add', '--all'], cwd);
    const diff = await execute({command: 'git', args: ['diff', '--cached', '--quiet']}, {cwd});
    const merging = existsSync(await this.run(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], cwd));
    if (diff.code === 1 || (diff.code === 0 && merging)) await this.run([...this.authorConfig(), 'commit', '-m', title], cwd);
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
