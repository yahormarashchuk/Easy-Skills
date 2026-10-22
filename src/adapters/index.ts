import type { Assignment, StageResult, Stage } from '../contracts.js';
import { outputSchema, parseOutput } from './protocol.js';
import { execute, type Command, type ProcessOptions } from '../process.js';
import which from 'which';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assignmentMcp } from './mcp-permissions.js';

export type ErrorKind = 'quota' | 'auth' | 'network' | 'model' | 'failure' | 'protocol' | 'refusal';
export class ClientError extends Error {
  constructor(public kind: ErrorKind, message: string, public retryAt?: string) {super(message);}
}
export function classify(text: string): ErrorKind {
  if (/model[_ ]not[_ ]found|invalid model|unsupported model|model.+not (?:available|exist|supported)|unknown model/i.test(text)) return 'model';
  if (/rate.?limit|quota|usage limit|limit reached|429|insufficient_quota/i.test(text)) return 'quota';
  if (/authentication|unauthorized|not logged in|login required|please (?:log|sign) in|401|token expired/i.test(text)) return 'auth';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|network|overloaded|503|connection refused/i.test(text)) return 'network';
  if (/structured_output_retries|Corrupt JSON|structured output.*invalid/i.test(text)) return 'protocol';
  if (/refus(?:ed|al)|declined request/i.test(text)) return 'refusal';
  return 'failure';
}
export interface Capabilities {diagnostics: string[]; browserTools: string[]}
interface ProtocolOptions {schemaPath?: string; lastMessagePath?: string; planning?: boolean; capabilities?: Capabilities; mcpPath?: string; mcpOverrides?: string[]}
export function invocation(assignment: Assignment, session?: string, mode: 'read' | 'write' = 'write', settingsPath?: string, protocol: ProtocolOptions = {}): Command {
  if (assignment.provider === 'codex') {
    // Global sandbox and approval flags also apply to exec resume, whose local flags differ.
    const args = ['--ask-for-approval', 'never', '--sandbox', mode === 'read' ? 'read-only' : 'workspace-write', 'exec'];
    for (const override of protocol.mcpOverrides || []) args.unshift('--config', override);
    if (session) args.push('resume', session);
    if (protocol.schemaPath) args.push('--output-schema', protocol.schemaPath);
    if (protocol.lastMessagePath) args.push('--output-last-message', protocol.lastMessagePath);
    args.push('--model', assignment.model, '--json', '-');
    const command = executable('codex');
    const script = join(dirname(command), 'node_modules/@openai/codex/bin/codex.js');
    if (/\.cmd$/i.test(command) && existsSync(script)) return {command: process.execPath, args: [script, ...args]};
    return {command, args};
  }
  const diagnostics = protocol.capabilities?.diagnostics || [], browser = protocol.capabilities?.browserTools || [];
  if (diagnostics.some(d => !/^[\w .:/\\"'-]+$/.test(d)) || browser.some(t => !/^mcp__[\w-]+__[\w-]+$/.test(t))) throw new Error('Unsupported diagnostic command or browser tool permission');
  const allowed = mode === 'write' ? ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] : ['Read', 'Glob', 'Grep', ...diagnostics.map(d => `Bash(${d})`), ...browser];
  const args = ['-p', '--model', assignment.model, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(outputSchema(protocol.planning)),
    '--permission-mode', 'dontAsk', '--allowedTools', allowed.join(',')];
  if (session) args.push('--resume', session);
  if (settingsPath) args.push('--settings', settingsPath);
  if (protocol.mcpPath) args.push('--strict-mcp-config', '--mcp-config', protocol.mcpPath);
  if (mode === 'read') args.push('--tools', ['Read', 'Glob', 'Grep', ...(diagnostics.length ? ['Bash'] : []), ...browser].join(','));
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
  try {event = JSON.parse(line);} catch {return {error: 'Corrupt JSON protocol event'};}
  if (provider === 'codex') {
    if (event.type === 'thread.started') return {session: event.thread_id};
    if (event.type === 'turn.failed' || event.type === 'error') return {error: event.error?.message || event.message || 'Codex turn failed', retryAt: resetTime(event)};
    if (event.type === 'turn.completed') return {complete: true};
    // Agent messages are interim observations. Only --output-last-message is authoritative.
  } else {
    if (event.type === 'rate_limit_event') return {retryAt: resetTime(event)};
    if (event.type === 'system' && event.subtype === 'init') return {session: event.session_id, models: event.model ? [event.model] : undefined};
    if (event.type === 'assistant' && event.message?.model) return {models: [event.message.model]};
    if (event.type === 'result') {
      if (event.is_error || event.subtype !== 'success') return {error: JSON.stringify(event.errors || event.result || event.subtype)};
      return {session: event.session_id, result: parseResult(event.structured_output), complete: true,
        models: event.modelUsage ? Object.keys(event.modelUsage) : undefined};
    }
    if (event.error) return {error: typeof event.error === 'string' ? event.error : JSON.stringify(event.error)};
  }
  return {};
}
function parseResult(text: unknown): StageResult | undefined {
  try {
    return parseOutput(text);
  } catch {return undefined;}
}
export interface Client {
  diagnose?(assignment: Assignment, cwd: string): Promise<Diagnostic>;
  run(assignment: Assignment, prompt: string, options: ProcessOptions & {
    session?: string; mode?: 'read' | 'write'; stage?: Stage; projectRoot?: string; capabilities?: Capabilities; onSession?: (session: string) => void;
  }): Promise<StageResult>;
}
export class CliClient implements Client {
  constructor(readonly runner: typeof execute = execute) {}
  async run(assignment: Assignment, prompt: string, options: ProcessOptions & {
    session?: string; mode?: 'read' | 'write'; stage?: Stage; projectRoot?: string; capabilities?: Capabilities; onSession?: (session: string) => void;
  }): Promise<StageResult> {
    let result: StageResult | undefined, complete = false, error: string | undefined, retryAt: string | undefined;
    const temp = mkdtempSync(join(tmpdir(), 'easy-skills-client-'));
    const settingsPath = assignment.provider === 'claude-code' ? join(temp, 'settings.json') : undefined;
    const schemaPath = join(temp, 'output-schema.json'), lastMessagePath = join(temp, 'final.json');
    writeFileSync(schemaPath, JSON.stringify(outputSchema(options.stage === 'PLAN')), {mode: 0o600});
    if (settingsPath) writeFileSync(settingsPath, JSON.stringify({fallbackModel: [], switchModelsOnFlag: false}), {mode: 0o600});
    let response;
    try {
    const mcp = assignmentMcp(options.projectRoot || options.cwd, temp, assignment.provider, options.capabilities?.browserTools || []);
    response = await this.runner(invocation(assignment, options.session, options.mode, settingsPath,
      {schemaPath, lastMessagePath, planning: options.stage === 'PLAN', capabilities: options.capabilities, mcpPath: mcp.path, mcpOverrides: mcp.overrides}), {
      ...options, input: prompt, onLine(line) {
        options.onLine?.(line);
        const event = decode(assignment.provider, line);
        if (event.models?.some(model => model !== assignment.model))
          throw new ClientError('model', `Client reported ${event.models.join(', ')} instead of assigned ${assignment.model}; stopping without accepting its result`);
        if (event.session && options.session && options.session !== event.session) throw new ClientError('protocol', 'CLI resumed a different session; refusing its result');
        if (event.session) options.onSession?.(event.session);
        if (event.result) result = event.result;
        if (event.complete) complete = true;
        if (event.error) error = event.error;
        if (event.retryAt) retryAt = event.retryAt;
      },
    });
    if (assignment.provider === 'codex' && existsSync(lastMessagePath)) result = parseResult(readFileSync(lastMessagePath, 'utf8'));
    } finally {rmSync(temp, {recursive: true, force: true});}
    if (error || response.code !== 0 || response.timedOut) {
      const detail = error || response.stderr || response.stdout || (response.timedOut ? 'Client timed out' : 'Client exited without result');
      throw new ClientError(/Corrupt JSON/.test(detail) ? 'protocol' : classify(detail), detail, retryAt);
    }
    if (!complete || !result) throw new ClientError('protocol', 'Client exited without a validated structured final result; possible refusal or unsupported CLI protocol');
    return result;
  }
  async diagnose(assignment: Assignment, cwd: string): Promise<Diagnostic> {
    const command = executable(assignment.provider);
    try {
      const version = await execute({command, args: ['--version']}, {cwd, timeoutMs: 15_000});
      if (version.code !== 0) return {installed: false, authenticated: false, detail: version.stderr};
      const auth = await execute({command, args: assignment.provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json']}, {cwd, timeoutMs: 15_000});
      let authenticated = auth.code === 0;
      if (assignment.provider === 'claude-code' && authenticated) {
        try {authenticated = JSON.parse(auth.stdout).loggedIn === true;} catch {authenticated = false;}
      }
      return {installed: true, authenticated, executable: command, version: (version.stdout || version.stderr).trim()};
    } catch (e) {return {installed: false, authenticated: false, detail: (e as Error).message};}
  }
}
export interface Diagnostic {installed: boolean; authenticated: boolean; executable?: string; version?: string; detail?: string}
