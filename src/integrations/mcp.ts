import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parse, stringify } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { configProposal, applyProposal } from './config.js';
import { hash } from '../util.js';

const ServerConfig = z.union([
  z.object({command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).optional()}).strict(),
  z.object({url: z.url(), bearerTokenEnv: z.string().optional()}).strict(),
]);
export const McpSetup = z.object({client: z.enum(['codex', 'claude-code']), name: z.string().regex(/^[\w-]+$/), server: ServerConfig,
  requiredTools: z.array(z.string().min(1)).min(1), testCall: z.object({tool: z.string(), arguments: z.record(z.string(), z.unknown()), expectedText: z.string().optional()}).strict().optional(),
}).strict();
export type McpSetup = z.infer<typeof McpSetup>;
export function mcpProposal(path: string, input: unknown) {
  const setup = McpSetup.parse(input), target = resolve(path), before = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  const config: any = before ? setup.client === 'codex' ? parse(before) : JSON.parse(before) : {};
  const key = setup.client === 'codex' ? 'mcp_servers' : 'mcpServers', server: any = {...setup.server};
  if ('url' in server && server.bearerTokenEnv) {
    if (setup.client === 'codex') {server.bearer_token_env_var = server.bearerTokenEnv; delete server.bearerTokenEnv;}
    else throw new Error('Configure Claude HTTP authentication using its official MCP login; inline tokens are not generated');
  }
  config[key] = {...config[key], [setup.name]: server};
  const base = configProposal(target, config), after = setup.client === 'codex' ? stringify(config) : base.after;
  return {...base, after, setup, hash: hash({path: target, before: before ?? null, after, setup})};
}
export async function connectMcp(server: McpSetup['server'], cwd: string) {
  const client = new Client({name: 'easy-skills', version: '0.1.0-alpha.1'}, {capabilities: {}});
  const transport = 'command' in server ? new StdioClientTransport({command: server.command, args: server.args, cwd,
    env: {...getDefaultEnvironment(), ...server.env}, stderr: 'pipe'})
    : new StreamableHTTPClientTransport(new URL(server.url), {requestInit: server.bearerTokenEnv ? {headers: {Authorization: 'Bearer ' + (process.env[server.bearerTokenEnv] || '')}} : undefined});
  try {await client.connect(transport, {timeout: 15_000}); return client;}
  catch (error) {await client.close().catch(() => {}); throw error;}
}
export async function verifyMcp(setup: McpSetup, cwd: string) {
  const client = await connectMcp(setup.server, cwd);
  try {
    const tools: string[] = []; let cursor: string | undefined;
    do {const page = await client.listTools(cursor ? {cursor} : {}, {timeout: 15_000}); tools.push(...page.tools.map(t => t.name)); cursor = page.nextCursor;} while (cursor);
    for (const required of setup.requiredTools) if (!tools.includes(required)) throw new Error('Required MCP tool missing: ' + required);
    if (setup.testCall) {
      if (!setup.requiredTools.includes(setup.testCall.tool)) throw new Error('Test call must use a reviewed required tool');
      const result = await client.callTool({name: setup.testCall.tool, arguments: setup.testCall.arguments}, undefined, {timeout: 15_000});
      if (result.isError || (setup.testCall.expectedText && !JSON.stringify(result.content).includes(setup.testCall.expectedText))) throw new Error('MCP capability test failed');
    }
    return {tools, negotiated: true};
  } finally {await client.close();}
}
export async function applyMcp(path: string, input: unknown, expectedHash: string, cwd: string) {
  const proposal = mcpProposal(path, input);
  return applyProposal(proposal, expectedHash, async () => {await verifyMcp(proposal.setup, cwd);});
}
