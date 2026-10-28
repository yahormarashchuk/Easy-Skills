import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../process.js';

export interface ClaudeAccount {loggedIn: boolean; configDirectory: string; subscriptionType?: string}
const ORGANIZATION_PLANS = new Set(['team', 'enterprise']);
const WINDOWS_POLICY_DIRECTORY = 'C:\\Program Files\\ClaudeCode';

export async function readClaudeAccount(resolved: {command: string; prefix: string[]}, cwd: string, runner = execute): Promise<ClaudeAccount> {
  const auth = await runner({command: resolved.command, args: [...resolved.prefix, 'auth', 'status', '--json']}, {cwd, role: 'client', timeoutMs: 15_000});
  return claudeAccount(auth.code, auth.stdout);
}
/** Interprets the output of `claude auth status --json`; anything unparsable counts as signed out. */
export function claudeAccount(code: number, stdout: string): ClaudeAccount {
  let status: Record<string, unknown> = {};
  try {status = JSON.parse(stdout);} catch {/* reported as signed out below */}
  return {loggedIn: code === 0 && status.loggedIn === true,
    configDirectory: typeof status.configDirectory === 'string' && status.configDirectory ? status.configDirectory : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    subscriptionType: typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined};
}

export interface PolicySources {platform: NodeJS.Platform; directories: string[]; readRegistry(key: string): Promise<string | undefined>}
const systemSources = (): PolicySources => ({platform: process.platform, readRegistry: key => readRegistry(key),
  // WSL can inherit the Windows policy files; its registry values cannot be read from here.
  directories: process.platform === 'win32' ? [WINDOWS_POLICY_DIRECTORY] : process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode']
    : ['/etc/claude-code', ...(process.env.WSL_DISTRO_NAME ? ['/mnt/c/Program Files/ClaudeCode'] : [])]});

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/**
 * Keys that start processes or widen tool grants regardless of user flags. A value that
 * is present but inert (an empty list, a disabled plugin) is not active.
 * The cache format of organization settings is client-internal, so nested objects are
 * searched too: a wrapped policy must never hide an active key.
 */
export function activePolicyKeys(value: unknown, depth = 0): string[] {
  if (!isRecord(value) || depth > 4) return [];
  const found = new Set<string>();
  const {hooks, enabledPlugins, policyHelper, permissions} = value;
  if (isRecord(hooks) && Object.values(hooks).some(list => Array.isArray(list) ? list.length > 0 : !!list)) found.add('hooks');
  if (isRecord(enabledPlugins) && Object.values(enabledPlugins).some(enabled => enabled !== false && enabled !== null && enabled !== undefined)) found.add('enabledPlugins');
  if (typeof policyHelper === 'string' ? policyHelper.trim() !== '' : isRecord(policyHelper) && Object.keys(policyHelper).length > 0) found.add('policyHelper');
  // Managed allow rules merge with the per-stage grants and can authorize tools a stage was never given.
  if (isRecord(permissions) && Array.isArray(permissions.allow) && permissions.allow.length > 0) found.add('permissions.allow');
  for (const nested of Object.values(value)) for (const key of activePolicyKeys(nested, depth + 1)) found.add(key);
  return [...found];
}

function policyFiles(directory: string): {source: string; text: string}[] {
  const documents: {source: string; text: string}[] = [];
  const file = join(directory, 'managed-settings.json');
  if (existsSync(file)) documents.push({source: file, text: readFileSync(file, 'utf8')});
  const dropIns = join(directory, 'managed-settings.d');
  if (existsSync(dropIns)) for (const name of readdirSync(dropIns).filter(name => name.endsWith('.json')).sort())
    documents.push({source: join(dropIns, name), text: readFileSync(join(dropIns, name), 'utf8')});
  return documents;
}

/**
 * Admin and organization policy is applied above every flag, so `--safe-mode` and
 * `disableAllHooks` cannot exclude it. Launch is allowed only when every documented
 * managed source is readable and none of them configures an active key.
 * Returns the refusal reason, or undefined when no such key is configured.
 */
export async function inspectClaudePolicy(account: ClaudeAccount, sources: PolicySources = systemSources()): Promise<string | undefined> {
  const documents: {source: string; text: string}[] = [];
  for (const directory of sources.directories) {
    try {
      documents.push(...policyFiles(directory));
      const managedMcp = join(directory, 'managed-mcp.json');
      if (existsSync(managedMcp)) return `Managed MCP servers are configured in ${managedMcp}; Easy Skills cannot exclude them from Claude Code launches.`;
    } catch {return `Managed Claude Code policy in ${directory} cannot be read; launch refused.`;}
  }
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
    if (!isRecord(policy)) return `Managed Claude Code policy ${source} is not a JSON object; launch refused.`;
    const active = activePolicyKeys(policy);
    if (active.length) return `Managed Claude Code policy ${source} configures ${active.join(', ')}, which would run outside the approved tool grants. Ask your administrator to remove it, or choose another provider.`;
  }
  return undefined;
}

/**
 * reg.exe exits 1 both when a key is absent and when it cannot be read, and its message is
 * localized. Existence is therefore established from the parent's listing, so an existing
 * key that cannot be queried is an error instead of an absent policy.
 */
export async function readRegistry(key: string, runner: typeof execute = execute): Promise<string | undefined> {
  const split = key.lastIndexOf('\\'), parent = key.slice(0, split), name = key.slice(split + 1).toLowerCase();
  const query = (path: string) => runner({command: 'reg', args: ['query', path]}, {cwd: homedir(), role: 'tool', timeoutMs: 15_000});
  const listing = await query(parent);
  if (listing.code !== 0 || !listing.stdout.split(/\r?\n/).some(line => line.trim().toLowerCase().endsWith('\\' + name))) return undefined;
  const result = await query(key);
  if (result.code !== 0 || result.truncated) throw new Error('Registry query failed');
  const match = /^\s*Settings\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(result.stdout);
  if (match) return match[1];
  if (/^\s*Settings\s+REG_/m.test(result.stdout)) throw new Error('Unsupported registry policy value');
  return undefined;
}
