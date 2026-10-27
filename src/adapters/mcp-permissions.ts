import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'smol-toml';

export function assignmentMcp(root: string, temp: string, provider: 'codex' | 'claude-code', approved: string[]) {
  if (provider === 'codex' && approved.length) throw new Error('Codex named MCP grants require separately verified tool isolation; this adapter currently supports an empty grant set only');
  const selected = new Map<string, string[]>();
  for (const tool of approved) {
    const match = tool.match(/^mcp__([\w-]+)__([\w-]+)$/);
    if (!match) throw new Error('Invalid approved MCP tool');
    selected.set(match[1]!, [...(selected.get(match[1]!) || []), match[2]!]);
  }
  const servers: Record<string, any> = {};
  if (selected.size) {
    const files = provider === 'codex' ? [join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), join(root, '.codex/config.toml')] : [join(root, '.mcp.json')];
    for (const file of files) if (existsSync(file)) {
      const config: any = provider === 'codex' ? parse(readFileSync(file, 'utf8')) : JSON.parse(readFileSync(file, 'utf8'));
      Object.assign(servers, config[provider === 'codex' ? 'mcp_servers' : 'mcpServers']);
    }
  }
  const permitted: Record<string, unknown> = {};
  for (const [name, tools] of selected) {
    if (!servers[name]) throw new Error(`Approved MCP server ${name} is not configured in ${provider === 'codex' ? 'Codex TOML' : 'project .mcp.json'}; run mcp-config and verify its tools`);
    if (provider === 'codex') permitted[name] = {...servers[name], enabled: true, enabled_tools: tools};
    else {
      const path = join(temp, name + '-upstream.json');
      writeFileSync(path, JSON.stringify({server: servers[name], allowed: tools, cwd: root}), {mode: 0o600});
      const source = fileURLToPath(new URL('../integrations/mcp-proxy.js', import.meta.url));
      const script = existsSync(source) ? source : source.replace(/\.js$/, '.ts');
      const loader = script.endsWith('.ts') ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
      permitted[name] = {command: process.execPath, args: [...loader, script, path]};
    }
  }
  const path = join(temp, 'mcp.json'); writeFileSync(path, JSON.stringify({mcpServers: permitted}), {mode: 0o600});
  // JSON and TOML inline tables differ, so generate each allowed server override individually.
  const overrides: string[] = [];
  if (provider === 'codex') for (const [name, config] of Object.entries(permitted)) {
    for (const [key, value] of Object.entries(config as object)) {
      if (typeof value === 'object' && !Array.isArray(value)) throw new Error('MCP inline tables require manual native configuration; use environment-variable references');
      overrides.push(`mcp_servers.${name}.${key}=${JSON.stringify(value)}`);
    }
  }
  return {path, overrides};
}
