import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodexModels } from '../../src/adapters/model-catalog.js';
import { CliClient } from '../../src/adapters/index.js';

async function withServer(mode: string, check: (command: {command: string; prefix: string[]}, root: string, log: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'easy model catalog ')), log = join(root, 'requests.jsonl'), script = join(root, 'catalog server.mjs');
  writeFileSync(script, `import fs from 'node:fs'; import readline from 'node:readline';
const mode=${JSON.stringify(mode)}, log=${JSON.stringify(log)};
fs.writeFileSync(log, JSON.stringify({args:process.argv.slice(2)})+'\\n');
const io=readline.createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
io.on('line', line=>{
 const message=JSON.parse(line); fs.appendFileSync(log,JSON.stringify(message)+'\\n');
 if(message.method==='initialize') {send({id:message.id,result:{userAgent:'fixture'}}); return;}
 if(message.method==='initialized') return;
 if(message.method!=='model/list') {process.exit(9); return;}
 if(mode==='timeout') return;
 if(mode==='exit') {process.exit(2); return;}
 if(mode==='error') {send({id:message.id,error:{code:-32601,message:'Unsupported'}}); return;}
 if(mode==='malformed') {process.stdout.write('{bad JSON\\n'); return;}
 if(mode==='oversize') {process.stdout.write('x'.repeat(1048577)); return;}
 if(mode==='empty') {send({id:message.id,result:{data:[],nextCursor:null}}); return;}
 if(mode==='cursor') {send({id:message.id,result:{data:[],nextCursor:'same'}}); return;}
 if(mode==='invalid') {send({id:message.id,result:{data:[{model:'invalid model',displayName:'Invalid'}]}}); return;}
 const second=!!message.params.cursor;
 send({method:'fixture/notification',params:{}});
 send({id:message.id,result:{data:second ? [{id:'opaque-b',model:'model-b',displayName:'Model B',isDefault:true}]
  : [{id:'opaque-a',model:'model-a',displayName:'Model A'},{model:'hidden-model',displayName:'Hidden',hidden:true}],nextCursor:second?null:'page-2'}});
});
io.on('close',()=>process.exit(0));
`);
  try {await check({command: process.execPath, prefix: [script]}, root, log);}
  finally {
    if (!root.startsWith(join(tmpdir(), 'easy model catalog '))) throw new Error('Invalid catalog fixture path');
    rmSync(root, {recursive: true, force: true});
  }
}

test('official catalog protocol waits for initialization, paginates, preserves exact models and filters hidden entries', async () => {
  await withServer('pages', async (command, root, log) => {
    const models = await readCodexModels(command, root, ['features.hooks=false']);
    assert.deepEqual(models, [{model: 'model-a', displayName: 'Model A', isDefault: false}, {model: 'model-b', displayName: 'Model B', isDefault: true}]);
    const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(requests[0].args, ['--config', 'features.hooks=false', 'app-server', '--listen', 'stdio://']);
    assert.deepEqual(requests.slice(1).map(r => r.method), ['initialize', 'initialized', 'model/list', 'model/list']);
    assert.equal(requests[3].params.includeHidden, false); assert.equal(requests[4].params.cursor, 'page-2');
    assert.ok(!requests.some(r => /thread\/|turn\//.test(r.method || '')));
  });
});

for (const mode of ['error', 'malformed', 'oversize', 'empty', 'cursor', 'invalid', 'exit', 'timeout']) test(`catalog ${mode} fails without substituting a static model list`, async () => {
  await withServer(mode, async (command, root) => {
    await assert.rejects(readCodexModels(command, root, [], mode === 'timeout' ? 400 : 5000));
  });
});

test('Claude catalog discovery stays fail-closed and injected protocol clients cannot launch a real catalog', async () => {
  let calls = 0;
  const client = new CliClient(async () => {calls++; throw new Error('Unexpected process');});
  await assert.rejects(client.listModels('claude-code', '.'), /managed.*hook|hook exclusion/);
  await assert.rejects(client.listModels('codex', '.'), /Injected clients/);
  await assert.rejects(client.listProviders('.'), /Injected clients/);
  assert.equal(calls, 0);
});
