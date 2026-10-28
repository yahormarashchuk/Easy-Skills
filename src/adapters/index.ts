import type { Assignment, StageResult, Stage } from '../contracts.js';
import { outputSchema, parseOutput } from './protocol.js';
import { execute, type Command, type ProcessOptions } from '../process.js';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assignmentMcp } from './mcp-permissions.js';
import { clientCommand, childEnvironment } from '../execution.js';
import { readCodexModels, type ModelOption } from './model-catalog.js';

export type ErrorKind = 'quota' | 'auth' | 'network' | 'model' | 'failure' | 'protocol' | 'refusal' | 'prerequisite' | 'review_input' | 'waiting_ci' | 'waiting_merge';
export class ClientError extends Error {
  constructor(public kind: ErrorKind, message: string, public retryAt?: string) {super(message);}
}
export function classify(text: string): ErrorKind {
  if (/model[_ ]not[_ ]found|invalid model|unsupported model|model.+not (?:available|exist|supported)|unknown model/i.test(text)) return 'model';
  if (/^(?:429 rate_limit\b|rate_limit_exceeded|insufficient_quota|quota_exceeded|usage_limit_reached|rate limit exceeded|usage limit reached)(?:\b|:)/i.test(text.trim())) return 'quota';
  if (/^(?:authentication failed|unauthorized|not logged in|login required|please (?:log|sign) in|token expired)(?:\b|:)/i.test(text.trim())) return 'auth';
  if (/^(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|connection refused|network error|network unavailable)(?:\b|:)/i.test(text.trim())) return 'network';
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
    args.unshift(...(protocol.mcpOverrides || []).flatMap(override => ['--config', override]));
    if (assignment.effort) args.unshift('--config', `model_reasoning_effort="${assignment.effort}"`);
    if (session) args.push('resume', session);
    if (protocol.schemaPath) args.push('--output-schema', protocol.schemaPath);
    if (protocol.lastMessagePath) args.push('--output-last-message', protocol.lastMessagePath);
    args.push('--model', assignment.model, '--json', '-');
    return {command: 'codex', args};
  }
  const diagnostics = protocol.capabilities?.diagnostics || [], browser = protocol.capabilities?.browserTools || [];
  if (diagnostics.some(d => /[\r\n\0]/.test(d)) || browser.some(t => !/^mcp__[\w-]+__[\w-]+$/.test(t))) throw new Error('Unsupported diagnostic command or browser tool permission');
  const allowed = mode === 'write' ? ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] : ['Read', 'Glob', 'Grep', ...diagnostics.map(d => `Bash(${d})`), ...browser];
  const args = ['--safe-mode', '--setting-sources', '', '-p', '--model', assignment.model, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(outputSchema(protocol.planning)),
    '--permission-mode', 'dontAsk', '--allowedTools', ...allowed];
  if (session) args.push('--resume', session);
  if (settingsPath) args.push('--settings', settingsPath);
  if (protocol.mcpPath) args.push('--strict-mcp-config', '--mcp-config', protocol.mcpPath);
  if (mode === 'read') args.push('--tools', ['Read', 'Glob', 'Grep', ...(diagnostics.length ? ['Bash'] : []), ...browser].join(','));
  return {command: 'claude', args};
}
export interface ClientEvent {session?: string; result?: StageResult; complete?: boolean; error?: string; kind?: ErrorKind; fatal?: boolean; models?: string[]; retryAt?: string}
function structuredError(event: Record<string, any>): Pick<ClientEvent, 'error' | 'kind' | 'retryAt'> {
  const detail = event.error || event;
  const code = detail.code || detail.type || event.error_code;
  const status = detail.status || detail.status_code;
  const kind: ErrorKind | undefined = status === 429 || ['rate_limit_exceeded', 'insufficient_quota', 'usage_limit_reached'].includes(code) ? 'quota'
    : status === 401 || ['authentication_error', 'unauthorized'].includes(code) ? 'auth'
    : [500, 502, 503, 504].includes(status) || ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code) ? 'network' : undefined;
  return {error: detail.message || event.message || 'Client request failed', kind, retryAt: resetTime(event)};
}
function resetTime(event: Record<string, any>): string | undefined {
  const error = event.error || event.rate_limit_info || event;
  const value = error.retry_at ?? error.reset_at ?? error.resets_at ?? error.resetsAt;
  const time = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > Date.now() && time < Date.now() + 365 * 24 * 60 * 60_000 ? new Date(time).toISOString() : undefined;
}
export function decode(provider: Assignment['provider'], line: string): ClientEvent {
  let event: Record<string, any>;
  try {event = JSON.parse(line);} catch {return {error: 'Corrupt JSON protocol event', kind: 'protocol', fatal: true};}
  if (provider === 'codex') {
    if (event.type === 'thread.started') return {session: event.thread_id};
    if (event.type === 'turn.failed' || event.type === 'error') return {...structuredError(event), fatal: event.type === 'turn.failed'};
    if (event.type === 'turn.completed') return {complete: true};
    // Agent messages are interim observations. Only --output-last-message is authoritative.
  } else {
    if (event.type === 'rate_limit_event') return {retryAt: resetTime(event)};
    if (event.type === 'system' && event.subtype === 'init') return {session: event.session_id, models: event.model ? [event.model] : undefined};
    if (event.type === 'assistant' && event.message?.model) return {models: [event.message.model]};
    if (event.type === 'result') {
      if (event.is_error || event.subtype !== 'success') return {...structuredError(event), error: typeof event.result === 'string' ? event.result : JSON.stringify(event.errors || event.subtype), fatal: true};
      return {session: event.session_id, result: parseResult(event.structured_output), complete: true,
        models: event.modelUsage ? Object.keys(event.modelUsage) : undefined};
    }
    if (event.error) return typeof event.error === 'string' ? {error: event.error} : structuredError(event);
  }
  return {};
}
function parseResult(text: unknown): StageResult | undefined {
  try {
    return parseOutput(text);
  } catch {return undefined;}
}
export interface Client {
  listProviders?(cwd: string): Promise<ProviderOption[]>;
  listModels?(provider: Assignment['provider'], cwd: string): Promise<ModelOption[]>;
  diagnose?(assignment: Assignment, cwd: string): Promise<Diagnostic>;
  run(assignment: Assignment, prompt: string, options: ProcessOptions & {
    session?: string; mode?: 'read' | 'write'; stage?: Stage; projectRoot?: string; capabilities?: Capabilities; onSession?: (session: string) => void;
  }): Promise<StageResult>;
}
export interface ProviderOption {provider: Assignment['provider']; available: boolean; reason?: string}
export class CliClient implements Client {
  constructor(readonly runner: typeof execute = execute) {}
  async listProviders(cwd: string): Promise<ProviderOption[]> {
    if (this.runner !== execute) throw new Error('Injected clients must supply their own provider availability');
    let codex: ProviderOption;
    try {clientCommand('codex', cwd); codex = {provider: 'codex', available: true};}
    catch {codex = {provider: 'codex', available: false, reason: 'Official Codex CLI could not be found or verified. Install or configure it and retry.'};}
    return [codex, {provider: 'claude-code', available: false,
      reason: 'Claude Code is temporarily unavailable: managed hook isolation cannot yet be verified.'}];
  }
  async listModels(provider: Assignment['provider'], cwd: string): Promise<ModelOption[]> {
    if (provider === 'claude-code') throw new ClientError('prerequisite', CLAUDE_ISOLATION_LIMIT + ' Select Codex explicitly to use the model picker.');
    if (this.runner !== execute) throw new Error('Injected clients must supply their own model catalog; real model discovery was not launched');
    const resolved = clientCommand(provider, cwd);
    const auth = await execute({command: resolved.command, args: [...resolved.prefix, 'login', 'status']}, {cwd, role: 'client', timeoutMs: 15_000});
    if (auth.code !== 0) throw new ClientError('auth', 'Sign in with codex login before choosing a model');
    const restrictions = await restrictCodex(resolved, cwd);
    return readCodexModels(resolved, cwd, restrictions);
  }
  async run(assignment: Assignment, prompt: string, options: ProcessOptions & {
    session?: string; mode?: 'read' | 'write'; stage?: Stage; projectRoot?: string; capabilities?: Capabilities; onSession?: (session: string) => void;
  }): Promise<StageResult> {
    let result: StageResult | undefined, complete = false, error: string | undefined, kind: ErrorKind | undefined, fatal = false, retryAt: string | undefined;
    const temp = mkdtempSync(join(tmpdir(), 'easy-skills-client-'));
    const settingsPath = assignment.provider === 'claude-code' ? join(temp, 'settings.json') : undefined;
    const schemaPath = join(temp, 'output-schema.json'), lastMessagePath = join(temp, 'final.json');
    writeFileSync(schemaPath, JSON.stringify(outputSchema(options.stage === 'PLAN')), {mode: 0o600});
    if (settingsPath) writeFileSync(settingsPath, JSON.stringify({fallbackModel: [], switchModelsOnFlag: false, disableAllHooks: true}), {mode: 0o600});
    let response;
    try {
    const mcp = assignmentMcp(options.projectRoot || options.cwd, temp, assignment.provider, options.capabilities?.browserTools || []);
    const command = invocation(assignment, options.session, options.mode, settingsPath,
      {schemaPath, lastMessagePath, planning: options.stage === 'PLAN', capabilities: options.capabilities, mcpPath: mcp.path, mcpOverrides: mcp.overrides});
    // An injected executor is a fixture boundary: never discover or launch a real client from a protocol test.
    if (this.runner === execute) {
      const resolved = clientCommand(assignment.provider, options.cwd);
      if (assignment.provider === 'codex') {
        const overrides = await restrictCodex(resolved, options.cwd);
        command.args.unshift(...overrides.flatMap(value => ['--config', value]));
      } else {
        // --safe-mode retains managed hooks. Neither file inspection nor a post-init
        // tool list can establish their exclusion before a SessionStart hook runs.
        throw new ClientError('prerequisite', CLAUDE_ISOLATION_LIMIT);
      }
      command.command = resolved.command; command.args.unshift(...resolved.prefix);
    }
    response = await this.runner(command, {
      ...options, role: 'client', env: childEnvironment('client'), input: prompt, onLine(line) {
        options.onLine?.(line);
        const event = decode(assignment.provider, line);
        if (event.models?.some(model => model !== assignment.model))
          throw new ClientError('model', `Client reported ${event.models.join(', ')} instead of assigned ${assignment.model}; stopping without accepting its result`);
        if (event.session && options.session && options.session !== event.session) throw new ClientError('protocol', 'CLI resumed a different session; refusing its result');
        if (event.session) options.onSession?.(event.session);
        if (event.result) result = event.result;
        if (event.complete) {complete = true; if (!fatal) {error = undefined; kind = undefined;}}
        if (event.error) {error = event.error; kind = event.kind; fatal ||= event.fatal === true;}
        if (event.retryAt) retryAt = event.retryAt;
      },
    });
    if (assignment.provider === 'codex' && existsSync(lastMessagePath)) result = parseResult(readFileSync(lastMessagePath, 'utf8'));
    } finally {rmSync(temp, {recursive: true, force: true});}
    if (error || response.code !== 0 || response.timedOut) {
      const detail = error || response.stderr || response.stdout || (response.timedOut ? 'Client timed out' : 'Client exited without result');
      throw new ClientError(kind || (/Corrupt JSON/.test(detail) ? 'protocol' : classify(detail)), detail, retryAt);
    }
    if (!complete || !result) throw new ClientError('protocol', 'Client exited without a validated structured final result; possible refusal or unsupported CLI protocol');
    return result;
  }
  async diagnose(assignment: Assignment, cwd: string): Promise<Diagnostic> {
    try {
      const resolved = clientCommand(assignment.provider, cwd), command = resolved.command;
      const version = await execute({command, args: [...resolved.prefix, '--version']}, {cwd, role: 'client', timeoutMs: 15_000});
      if (version.code !== 0) return {installed: false, authenticated: false, detail: version.stderr};
      const auth = await execute({command, args: [...resolved.prefix, ...(assignment.provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'])]}, {cwd, role: 'client', timeoutMs: 15_000});
      let authenticated = auth.code === 0;
      if (assignment.provider === 'claude-code' && authenticated) {
        try {authenticated = JSON.parse(auth.stdout).loggedIn === true;} catch {authenticated = false;}
      }
      let isolation = false, detail: string | undefined;
      if (assignment.provider === 'claude-code') detail = CLAUDE_ISOLATION_LIMIT;
      else try {await restrictCodex(resolved, cwd); isolation = true;} catch (error) {detail = (error as Error).message;}
      return {installed: true, authenticated, isolation, detail, executable: command, version: (version.stdout || version.stderr).trim()};
    } catch (e) {return {installed: false, authenticated: false, detail: (e as Error).message};}
  }
}
export async function restrictCodex(resolved: {command: string; prefix: string[]}, cwd: string, runner = execute): Promise<string[]> {
  const base = ['features.hooks=false', 'features.apps=false', 'features.multi_agent=false', 'notify=[]', 'web_search="disabled"',
    'shell_environment_policy.inherit="none"', 'shell_environment_policy.set.PATH=' + JSON.stringify(childEnvironment('project').PATH)];
  const run = async (overrides: string[], args: string[]) => {
    const result = await runner({command: resolved.command, args: [...resolved.prefix, ...overrides.flatMap(v => ['--config', v]), ...args]}, {cwd, role: 'client', timeoutMs: 15_000});
    if (result.code || result.truncated) throw new ClientError('prerequisite', 'Cannot verify effective Codex capability restrictions');
    return result.stdout;
  };
  const features = await run(base, ['features', 'list']);
  if (!/^hooks\s+.*\sfalse\s*$/m.test(features) || !/^apps\s+.*\sfalse\s*$/m.test(features)) throw new ClientError('prerequisite', 'Cannot verify disabled Codex hooks and apps');
  const initial: {name: string; enabled: boolean}[] = JSON.parse(await run(base, ['mcp', 'list', '--json']));
  if (!Array.isArray(initial) || initial.some(s => !/^[\w-]+$/.test(s.name))) throw new ClientError('prerequisite', 'Unsupported effective MCP server identity');
  // Some layers replace a whole server table when a dotted override is applied.
  // Use a complete, inert, disabled definition; never copy upstream credentials.
  const overrides = [...base, ...initial.map(s => `mcp_servers.${s.name}={command=${JSON.stringify(process.execPath)},args=[],enabled=false}`)];
  const effective: {name: string; enabled: boolean}[] = JSON.parse(await run(overrides, ['mcp', 'list', '--json']));
  if (!Array.isArray(effective) || effective.some(s => s.enabled !== false)) throw new ClientError('prerequisite', 'Unauthorized MCP servers remain enabled; launch refused');
  return overrides;
}
export const CLAUDE_ISOLATION_LIMIT = 'Claude Code launch refused: managed/remote hook exclusion cannot be verified before execution with the supported configuration-only interface. Safe-mode retains managed hooks. A separately authorized isolation investigation is required; no provider fallback is allowed.';
export interface Diagnostic {installed: boolean; authenticated: boolean; isolation?: boolean; executable?: string; version?: string; detail?: string}
