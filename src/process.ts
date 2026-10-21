import crossSpawn from 'cross-spawn';
import { createWriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import which from 'which';
import { resolve as absolute } from 'node:path';
import { redact } from './util.js';

export interface Command { command: string; args: string[] }
export interface ProcessOptions {
  cwd: string; input?: string; timeoutMs?: number; signal?: AbortSignal;
  onSpawn?: (pid: number) => void; onLine?: (line: string) => void; log?: string;
  env?: NodeJS.ProcessEnv;
}
export interface ProcessResult {code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean}
export function terminateTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      const child = crossSpawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
      child.on('error', () => resolve()); child.on('close', () => resolve());
    } else {
      try {process.kill(-pid, 'SIGTERM');} catch {try {process.kill(pid, 'SIGTERM');} catch { /* already exited */ }}
      const timer = setTimeout(() => {try {process.kill(-pid, 'SIGKILL');} catch { /* already exited */ }}, 1500);
      timer.unref(); resolve();
    }
  });
}
/** No shell text: Windows npm .cmd launchers are resolved/escaped by cross-spawn. */
export function execute(spec: Command, options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {reject(new Error('Execution aborted')); return;}
    let command = spec.command;
    if (process.platform === 'win32') {
      const file = which.sync(absolute(options.cwd, spec.command), {nothrow: true}) ||
        which.sync(spec.command, {nothrow: true, path: (options.env || process.env).PATH});
      // A .cmd script expands %* in a second cmd.exe parse. Generic batch scripts do
      // not provide a lossless argv boundary. Reject ambiguous text instead of letting
      // it become a second command; use an .exe or node <script> for these arguments.
      if (file && /\.(cmd|bat)$/i.test(file) && spec.args.some(arg => /[\r\n&|<>^%!"`()\[\];,*?]/.test(arg))) {
        reject(new Error('Unsafe metacharacter argument for Windows .cmd/.bat; use a native executable or node script with an argument array'));
        return;
      }
      if (file) command = file;
    }
    const log = options.log ? createWriteStream(options.log, {flags: 'a', mode: 0o600}) : undefined;
    let logError: Error | undefined;
    log?.on('error', e => {logError = e;});
    const child = crossSpawn(command, spec.args, {
      cwd: options.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'], env: options.env || process.env,
    });
    let stdout = '', stderr = '', pending = '', timedOut = false, truncated = false, callbackError: unknown;
    const decoder = new StringDecoder('utf8');
    const limit = 1024 * 1024;
    const finishLine = (line: string) => {
      log?.write(redact(line) + '\n');
      try {options.onLine?.(line);} catch (e) {callbackError = e; if (child.pid) void terminateTree(child.pid);}
    };
    child.stdout?.on('data', (buffer: Buffer) => {
      const chunk = decoder.write(buffer); if (stdout.length + chunk.length > limit) truncated = true;
      stdout = (stdout + chunk).slice(-limit); pending += chunk;
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {finishLine(pending.slice(0, index)); pending = pending.slice(index + 1);}
      if (pending.length > limit) {callbackError = new Error('CLI event exceeds 1 MiB'); pending = ''; if (child.pid) void terminateTree(child.pid);}
    });
    child.stderr?.on('data', (buffer: Buffer) => {const chunk = buffer.toString('utf8'); stderr = (stderr + chunk).slice(-limit);});
    const abort = () => {if (child.pid) void terminateTree(child.pid);};
    options.signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => {timedOut = true; abort();}, options.timeoutMs ?? 3_600_000);
    timer.unref();
    const cleanup = () => {clearTimeout(timer); options.signal?.removeEventListener('abort', abort);};
    child.on('error', error => {cleanup(); log?.end(); reject(error);});
    child.on('spawn', () => {
      try {if (child.pid) options.onSpawn?.(child.pid);} catch (e) {callbackError = e; abort();}
      child.stdin?.on('error', () => { /* closed stdin is reported by process result */ });
      child.stdin?.end(options.input || '');
    });
    child.on('close', code => {
      cleanup(); pending += decoder.end(); if (pending) finishLine(pending);
      log?.write(redact(stderr));
      const done = () => {
        if (callbackError || logError) reject(callbackError || logError);
        else resolve({code: code ?? -1, stdout, stderr, timedOut, truncated});
      };
      if (log) log.end(done); else done();
    });
  });
}
export async function checked(command: string, args: string[], cwd: string, input?: string): Promise<string> {
  const result = await execute({command, args}, {cwd, input, timeoutMs: 120_000});
  if (result.code !== 0) throw new Error(redact(`${command} failed (${result.code}): ${result.stderr || result.stdout}`));
  if (result.truncated) throw new Error(`${command} output exceeded the capture limit; refusing to use incomplete output`);
  return result.stdout.trim();
}
