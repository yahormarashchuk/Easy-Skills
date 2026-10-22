import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectMcp, type McpSetup } from './mcp.js';

// Optional per-assignment tool filter. No listening socket or background service.
const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {server: McpSetup['server']; allowed: string[]; cwd: string};
const upstream = await connectMcp(config.server, config.cwd);
const server = new Server({name: 'easy-skills-approved-tools', version: '0.1.0-alpha.1'}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, async request => {
  const result = await upstream.listTools(request.params);
  return {...result, tools: result.tools.filter(tool => config.allowed.includes(tool.name))};
});
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (!config.allowed.includes(request.params.name)) throw new Error('Tool is outside approved VERIFY capabilities');
  return await upstream.callTool(request.params);
});
server.onclose = () => {void upstream.close();};
await server.connect(new StdioServerTransport());
