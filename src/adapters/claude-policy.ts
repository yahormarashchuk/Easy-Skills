import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../process.js';

export interface ClaudeAccount {loggedIn: boolean; configDirectory: string; subscriptionType?: string}
/** Policy keys that start processes before or during a session regardless of user flags. */
const ACTIVE_KEYS = ['hooks', 'enabledPlugins', 'policyHelper'] as const;
const ORGANIZATION_PLANS = new Set(['team', 'enterprise']);

export async function readClaudeAccount(resolved: {command: string; prefix: string[]}, cwd: string, runner = execute): Promise<ClaudeAccount> {
  const auth = await runner({command: resolved.command, args: [...resolved.prefix, 'auth', 'status', '--json']}, {cwd, role: 'client', timeoutMs: 15_000});
  let status: Record<string, unknown> = {};
  try {status = JSON.parse(auth.stdout);} catch {/* reported as signed out below */}
  return {loggedIn: auth.code === 0 && status.loggedIn === true,
    configDirectory: typeof status.configDirectory === 'string' && status.configDirectory ? status.configDirectory : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    subscriptionType: typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined};
}

export interface PolicySources {platform: NodeJS.Platform; directory: string; readRegistry(key: string): Promise<string | undefined>}
const systemSources: PolicySources = {platform: process.platform, readRegistry,
  directory: process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code'};

/**
 * Admin and organization policy is applied above every flag, so `--safe-mode` and
 * `disableAllHooks` cannot exclude it. Launch is allowed only when every documented
 * managed source is readable and none of them configures a process-starting key.
 * Returns the refusal reason, or undefined when no such key is configured.
 */
export async function inspectClaudePolicy(account: ClaudeAccount, sources: PolicySources = systemSources): Promise<string | undefined> {
  const documents: {source: string; text: string}[] = [];
  const directory = sources.directory;
  try {
    const file = join(directory, 'managed-settings.json');
    if (existsSync(file)) documents.push({source: file, text: readFileSync(file, 'utf8')});
    const dropIns = join(directory, 'managed-settings.d');
    if (existsSync(dropIns)) for (const name of readdirSync(dropIns).filter(name => name.endsWith('.json')).sort())
      documents.push({source: join(dropIns, name), text: readFileSync(join(dropIns, name), 'utf8')});
    if (existsSync(join(directory, 'managed-mcp.json'))) return `Managed MCP servers are configured in ${join(directory, 'managed-mcp.json')}; Easy Skills cannot exclude them from Claude Code launches.`;
  } catch {return `Managed Claude Code policy in ${directory} cannot be read; launch refused.`;}
  if (sources.platform === 'win32') for (const key of ['HKLM\\SOFTWARE\\Policies\\ClaudeCode', 'HKCU\\SOFTWARE\\Policies\\ClaudeCode']) {
    let text: string | undefined;
    try {text = await sources.readRegistry(key);} catch {return `Registry policy ${key} cannot be read; launch refused.`;}
    if (text !== undefined) documents.push({source: key, text});
  }
  if (sources.platform === 'darwin' && ['/Library/Managed Preferences/com.anthropic.claudecode.plist', join('/Library/Managed Preferences', process.env.USER || '', 'com.anthropic.claudecode.plist')].some(existsSync))
    return 'A macOS configuration profile manages Claude Code; Easy Skills cannot yet inspect it, so launch is refused.';
  const remote = join(account.configDirectory, 'remote-settings.json');
  if (existsSync(remote) && statSync(remote).isFile()) documents.push({source: 'organization settings (' + remote + ')', text: readFileSync(remote, 'utf8')});
  else if (ORGANIZATION_PLANS.has(account.subscriptionType || ''))
    return 'Organization-managed Claude Code settings have not been synced yet. Start claude once interactively, then retry.';
  for (const {source, text} of documents) {
    let policy: unknown;
    try {policy = JSON.parse(text);} catch {return `Managed Claude Code policy ${source} is not valid JSON; launch refused.`;}
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return `Managed Claude Code policy ${source} is not a JSON object; launch refused.`;
    const active = ACTIVE_KEYS.filter(key => {
      const value = (policy as Record<string, unknown>)[key];
      return value !== undefined && value !== null && !(typeof value === 'object' && Object.keys(value).length === 0);
    });
    if (active.length) return `Managed Claude Code policy ${source} configures ${active.join(', ')}, which would run outside the approved tool grants. Ask your administrator to remove it, or choose another provider.`;
  }
  return undefined;
}

async function readRegistry(key: string): Promise<string | undefined> {
  const result = await execute({command: 'reg', args: ['query', key, '/v', 'Settings']}, {cwd: homedir(), role: 'tool', timeoutMs: 15_000});
  // reg.exe exits 1 when the key or value is absent.
  if (result.code === 1 && !result.stdout.trim()) return undefined;
  if (result.code !== 0) throw new Error('Registry query failed');
  const match = /^\s*Settings\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(result.stdout);
  if (!match) throw new Error('Unsupported registry policy value');
  return match[1];
}
