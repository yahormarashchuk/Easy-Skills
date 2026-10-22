import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignmentMcp } from '../../src/adapters/mcp-permissions.js';
import { connectMcp } from '../../src/integrations/mcp.js';

test('Claude assignment proxy lists approved tools and rejects a direct call to an unapproved tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'easy tool permissions fixture '));
  try {
    const script = join(root, 'upstream.mjs');
    writeFileSync(script, `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
 const q=JSON.parse(line); if(q.id===undefined) continue;
 const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
 q.method==='tools/list'?{tools:['snapshot','unsafe_write'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))}:
 {content:[{type:'text',text:'fixture result'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
}`);
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({mcpServers: {browser: {command: process.execPath, args: [script]}}}));
    const config = assignmentMcp(root, root, 'claude-code', ['mcp__browser__snapshot']);
    const server = JSON.parse(readFileSync(config.path, 'utf8')).mcpServers.browser;
    const client = await connectMcp(server, root);
    try {
      assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['snapshot']);
      await assert.rejects(client.callTool({name: 'unsafe_write', arguments: {}}), /outside approved/);
      assert.equal((await client.callTool({name: 'snapshot', arguments: {}})).isError, undefined);
    } finally {await client.close();}
  } finally {rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});}
});
