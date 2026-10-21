import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from '../../src/process.js';
import { applyConfig, configProposal } from '../../src/integrations/config.js';
import { installSkills, uninstallSkills } from '../../src/cli/project.js';

test('processes handle spaces, Unicode, shell metacharacters, stdin, event fragments and redaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy process '));
  try {
    const lines: string[] = [], log = join(dir, 'local.log');
    const payload = 'space " %PATH% & echo BAD | < > ^ ! $(whoami) `x` Unicode \u2603';
    const result = await execute({command: process.execPath, args: ['-e',
      'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({value:process.argv[1],input:s})+"\\n");process.stderr.write("password=hidden\\n");});', payload]},
      {cwd: dir, input: payload, log, onLine: line => lines.push(line)});
    assert.equal(result.code, 0); assert.equal(JSON.parse(lines[0]!).value, payload); assert.equal(JSON.parse(lines[0]!).input, payload);
    assert.match(readFileSync(log, 'utf8'), /REDACTED/); assert.ok(!readFileSync(log, 'utf8').includes('hidden'));
    const unicode: string[] = [];
    await execute({command: process.execPath, args: ['-e', 'const b=Buffer.from("\\u2603 Hello\\n");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10);']}, {cwd: dir, onLine: line => unicode.push(line)});
    assert.deepEqual(unicode, ['\u2603 Hello']);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
test('timeouts stop an owned process and return non-success', async () => {
  const result = await execute({command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)']}, {cwd: process.cwd(), timeoutMs: 150});
  assert.equal(result.timedOut, true); assert.notEqual(result.code, 0);
});
test('Windows .cmd shims support spaced paths and reject ambiguous shell arguments', {skip: process.platform !== 'win32'}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy cmd '));
  try {
    const script = join(dir, 'echo args.cjs'), shim = join(dir, 'client shim.cmd');
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const args = ['a b', 'path with spaces/file.txt', 'Unicode \u2603', '--flag=value'];
    const result = await execute({command: shim, args}, {cwd: dir});
    assert.equal(result.code, 0, JSON.stringify(result)); assert.deepEqual(JSON.parse(result.stdout), args);
    for (const arg of ['literal"quote', '%PATH%', '& echo SHOULD_NOT_RUN', '|', '$(x)', '`x`'])
      await assert.rejects(execute({command: shim, args: [arg]}, {cwd: dir}), /Unsafe metacharacter/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
test('config edits preserve backups, reject stale proposals and roll back failed probes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy config ')), path = join(dir, 'mcp.json');
  try {
    writeFileSync(path, '{"unrelated":true}\n');
    const proposal = configProposal(path, {unrelated: true, mcpServers: {}});
    await assert.rejects(applyConfig(path, {}, proposal.hash, {command: process.execPath, args: ['-e', 'process.exit(0)']}, dir), /changed/);
    await assert.rejects(applyConfig(path, {unrelated: true, mcpServers: {}}, proposal.hash,
      {command: process.execPath, args: ['-e', 'process.exit(1)']}, dir), /restored/);
    assert.equal(readFileSync(path, 'utf8'), '{"unrelated":true}\n');
    const result = await applyConfig(path, {unrelated: true, mcpServers: {}}, proposal.hash,
      {command: process.execPath, args: ['-e', 'process.exit(0)']}, dir);
    assert.ok(result.backup && existsSync(result.backup)); assert.equal(result.verified, true);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
test('each installed skill contains its shared dependency and uninstall preserves user modifications', () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy skills install '));
  try {
    const proposal = installSkills(dir); installSkills(dir, proposal.hash);
    assert.ok(existsSync(join(dir, 'easy-sync/references/workflow.md')));
    assert.ok(existsSync(join(dir, 'easy-plan/references/plan.schema.json')));
    assert.ok(existsSync(join(dir, 'easy-remote/references/remote-control.md')));
    const modified = join(dir, 'easy-build/SKILL.md'); writeFileSync(modified, 'User version');
    const removal = uninstallSkills(dir); assert.ok(removal.modified.includes(modified));
    uninstallSkills(dir, removal.hash); assert.equal(readFileSync(modified, 'utf8'), 'User version');
    assert.equal(existsSync(join(dir, 'easy-sync/SKILL.md')), false);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
