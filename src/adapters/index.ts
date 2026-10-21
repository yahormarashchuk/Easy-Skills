import type { Assignment, StageResult } from '../contracts.js';
import { StageResult as ResultSchema } from '../contracts.js';
import { execute, type Command, type ProcessOptions } from '../process.js';
import which from 'which';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type ErrorKind = 'quota' | 'auth' | 'network' | 'model' | 'failure';
export class ClientError extends Error {
  constructor(public kind: ErrorKind, message: string, public retryAt?: string) {super(message);}
}
export function classify(text: string): ErrorKind {
  if (/model[_ ]not[_ ]found|invalid model|unsupported model|model.+not (?:available|exist)|unknown model/i.test(text)) return 'model';
  if (/rate.?limit|quota|usage limit|limit reached|429|insufficient_quota/i.test(text)) return 'quota';
  if (/authentication|unauthorized|not logged in|login required|please (?:log|sign) in|401|token expired/i.test(text)) return 'auth';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|network|overloaded|503|connection refused/i.test(text)) return 'network';
  return 'failure';
}
export function invocation(assignment: Assignment, session?: string, mode: 'read' | 'write' = 'write', settingsPath?: string): Command {
  if (assignment.provider === 'codex') {
    // Global sandbox and approval flags also apply to exec resume, whose local flags differ.
    const args = ['--ask-for-approval', 'never', '--sandbox', mode === 'read' ? 'read-only' : 'workspace-write', 'exec'];
    if (session) args.push('resume', session);
    args.push('--model', assignment.model, '--json', '-');
    return {command: executable('codex'), args};
  }
  const args = ['-p', '--model', assignment.model, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--allowedTools', mode === 'write' ? 'Read,Glob,Grep,Edit,Write,Bash' : 'Read,Glob,Grep'];
  if (session) args.push('--resume', session);
  if (settingsPath) args.push('--settings', settingsPath);
  if (mode === 'read') args.push('--tools', 'Read,Glob,Grep');
  return {command: executable('claude-code'), args};
}
function executable(provider: Assignment['provider']): string {
  const name = provider === 'codex' ? 'codex' : 'claude';
  const path = which.sync(name, {nothrow: true});
  if (path) return path;
  // Native Claude installers may update the user's PATH after the host app started.
  const native = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return provider === 'claude-code' && existsSync(native) ? native : name;
}
export interface ClientEvent {session?: string; result?: StageResult; complete?: boolean; error?: string; models?: string[]; retryAt?: string}
function resetTime(event: Record<string, any>): string | undefined {
  const error = event.error || event.rate_limit_info || event;
  const value = error.retry_at ?? error.reset_at ?? error.resets_at ?? error.resetsAt;
  const time = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > Date.now() && time < Date.now() + 365 * 24 * 60 * 60_000 ? new Date(time).toISOString() : undefined;
}
export function decode(provider: Assignment['provider'], line: string): ClientEvent {
  let event: Record<string, any>;
  try {event = JSON.parse(line);} catch {return {};}
  if (provider === 'codex') {
    if (event.type === 'thread.started') return {session: event.thread_id};
    if (event.type === 'turn.failed' || event.type === 'error') return {error: event.error?.message || event.message || 'Codex turn failed', retryAt: resetTime(event)};
    if (event.type === 'turn.completed') return {complete: true};
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') return {result: parseResult(event.item.text)};
  } else {
    if (event.type === 'rate_limit_event') return {retryAt: resetTime(event)};
    if (event.type === 'system' && event.subtype === 'init') return {session: event.session_id, models: event.model ? [event.model] : undefined};
    if (event.type === 'assistant' && event.message?.model) return {models: [event.message.model]};
    if (event.type === 'result') {
      if (event.is_error || event.subtype !== 'success') return {error: JSON.stringify(event.errors || event.result || event.subtype)};
      return {session: event.session_id, result: parseResult(event.structured_output || event.result), complete: true,
        models: event.modelUsage ? Object.keys(event.modelUsage) : undefined};
    }
    if (event.error) return {error: typeof event.error === 'string' ? event.error : JSON.stringify(event.error)};
  }
  return {};
}
function parseResult(text: unknown): StageResult | undefined {
  try {
    const value = typeof text === 'string' ? JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) : text;
    const parsed = ResultSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {return undefined;}
}
export interface Client {
  run(assignment: Assignment, prompt: string, options: ProcessOptions & {
    session?: string; mode?: 'read' | 'write'; onSession?: (session: string) => void;
  }): Promise<StageResult>;
}
export class CliClient implements Client {
  async run(assignment: Assignment, prompt: string, options: ProcessOptions & {
    session?: string; mode?: 'read' | 'write'; onSession?: (session: string) => void;
  }): Promise<StageResult> {
    let result: StageResult | undefined, complete = false, error: string | undefined, retryAt: string | undefined;
    const temp = assignment.provider === 'claude-code' ? mkdtempSync(join(tmpdir(), 'easy-skills-client-')) : undefined;
    const settingsPath = temp ? join(temp, 'settings.json') : undefined;
    if (settingsPath) writeFileSync(settingsPath, JSON.stringify({fallbackModel: [], switchModelsOnFlag: false}), {mode: 0o600});
    const response = await execute(invocation(assignment, options.session, options.mode, settingsPath), {
      ...options, input: prompt, onLine(line) {
        options.onLine?.(line);
        const event = decode(assignment.provider, line);
        if (event.models?.some(model => model !== assignment.model))
          throw new ClientError('model', `Client reported ${event.models.join(', ')} instead of assigned ${assignment.model}; stopping without accepting its result`);
        if (event.session) options.onSession?.(event.session);
        if (event.result) result = event.result;
        if (event.complete) complete = true;
        if (event.error) error = event.error;
        if (event.retryAt) retryAt = event.retryAt;
      },
    }).finally(() => {if (temp) rmSync(temp, {recursive: true, force: true});});
    if (error || response.code !== 0 || response.timedOut) {
      const detail = error || response.stderr || response.stdout || (response.timedOut ? 'Client timed out' : 'Client exited without result');
      throw new ClientError(classify(detail), detail, retryAt);
    }
    if (!complete || !result) throw new ClientError('failure', 'Client exited without a validated final result');
    return result;
  }
  async diagnose(assignment: Assignment, cwd: string): Promise<{installed: boolean; authenticated: boolean; version?: string; detail?: string}> {
    const command = executable(assignment.provider);
    try {
      const version = await execute({command, args: ['--version']}, {cwd, timeoutMs: 15_000});
      if (version.code !== 0) return {installed: false, authenticated: false, detail: version.stderr};
      const auth = await execute({command, args: assignment.provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json']}, {cwd, timeoutMs: 15_000});
      let authenticated = auth.code === 0;
      if (assignment.provider === 'claude-code' && authenticated) {
        try {authenticated = JSON.parse(auth.stdout).loggedIn === true;} catch {authenticated = false;}
      }
      return {installed: true, authenticated, version: (version.stdout || version.stderr).trim()};
    } catch (e) {return {installed: false, authenticated: false, detail: (e as Error).message};}
  }
}
