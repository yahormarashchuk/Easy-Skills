import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpProposal, applyMcp } from '../../src/integrations/mcp.js';

test('native Codex TOML preserves settings and verifies actual MCP tools, rolling back a missing capability', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy mcp fixture '));
  try {
    const path = join(dir, 'config.toml'), server = join(dir, 'server.mjs');
    writeFileSync(path, 'model = "exact-model"\n[mcp_servers.existing]\ncommand = "existing-command"\n');
    writeFileSync(server, `import readline from 'node:readline';
const lines = readline.createInterface({input: process.stdin});
for await (const line of lines) { const q=JSON.parse(line); if (q.id === undefined) continue;
const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
q.method==='tools/list'?{tools:[{name:'snapshot',inputSchema:{type:'object',properties:{}}}]}:
{content:[{type:'text',text:'fixture browser connected'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n'); }`);
    const input = {client: 'codex' as const, name: 'browser', server: {command: process.execPath, args: [server]}, requiredTools: ['snapshot']};
    const proposal = mcpProposal(path, input);
    assert.match(proposal.after, /\[mcp_servers.browser\]/); assert.match(proposal.after, /exact-model/);
    assert.equal((await applyMcp(path, input, proposal.hash, dir)).verified, true);
    const before = readFileSync(path, 'utf8'), missing = {...input, requiredTools: ['missing_tool']};
    const rejected = mcpProposal(path, missing);
    await assert.rejects(applyMcp(path, missing, rejected.hash, dir), /missing|required|restored/i);
    assert.equal(readFileSync(path, 'utf8'), before);
    const zeroExit = {...input, server: {command: process.execPath, args: ['-e', 'process.exit(0)']}};
    await assert.rejects(applyMcp(path, zeroExit, mcpProposal(path, zeroExit).hash, dir), /closed|restored|connection/i);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
