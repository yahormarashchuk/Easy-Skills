import crossSpawn from 'cross-spawn';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { Assignment, VERSION } from '../contracts.js';
import { childEnvironment } from '../execution.js';
import { terminateTree } from '../process.js';

export interface ModelOption {model: string; displayName: string; isDefault: boolean}
const Page = z.object({data: z.array(z.object({model: z.string().min(1), displayName: z.string().min(1),
  hidden: z.boolean().optional(), isDefault: z.boolean().optional()})), nextCursor: z.string().min(1).nullable().optional()});

/** Metadata only: no thread, turn, tool invocation, or direct credential access. */
export function readCodexModels(resolved: {command: string; prefix: string[]}, cwd: string, overrides: string[], timeoutMs = 20_000): Promise<ModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(resolved.command, [...resolved.prefix, ...overrides.flatMap(value => ['--config', value]), 'app-server', '--listen', 'stdio://'],
      {cwd, env: childEnvironment('client'), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    const decoder = new StringDecoder('utf8'), models: ModelOption[] = [], cursors = new Set<string>();
    const input = child.stdin!, output = child.stdout!, errors = child.stderr!;
    let pending = '', total = 0, expected = 0, pages = 0, ready = false, result: ModelOption[] | undefined, failure: Error | undefined;
    let shutdown: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {if (failure || result) return; failure = error; if (child.pid) void terminateTree(child.pid);};
    const timeout = setTimeout(() => stop(new Error('Codex model discovery timed out. Check the official CLI installation and login, then retry.')), timeoutMs);
    const cleanup = () => {clearTimeout(timeout); if (shutdown) clearTimeout(shutdown);};
    const send = (value: unknown) => input.write(JSON.stringify(value) + '\n');
    function requestPage(cursor?: string) {
      if (++pages > 25) throw new Error('Codex model catalog exceeded the supported discovery limit');
      expected++;
      send({method: 'model/list', id: expected, params: {limit: 100, includeHidden: false, ...(cursor ? {cursor} : {})}});
    }
    child.on('spawn', () => send({method: 'initialize', id: 0, params: {clientInfo: {name: 'easy_skills', title: 'Easy Skills model picker', version: VERSION}}}));
    input.on('error', () => stop(new Error('Codex model discovery connection closed unexpectedly')));
    errors.resume();
    output.on('data', (bytes: Buffer) => {
      if (failure || result) return;
      total += bytes.length;
      if (total > 1_048_576) {stop(new Error('Codex model discovery exceeded the response limit')); return;}
      pending += decoder.write(bytes);
      let boundary: number;
      while ((boundary = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, boundary).trim(); pending = pending.slice(boundary + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === undefined) continue;
          if (response.id !== expected) throw new Error('Unexpected Codex model discovery response');
          if (response.error) throw new Error('Codex could not list models. Check official CLI login and update the client, then retry.');
          if (!ready) {
            if (!response.result || typeof response.result !== 'object') throw new Error('Invalid Codex initialization response');
            ready = true; send({method: 'initialized', params: {}}); requestPage(); continue;
          }
          const page = Page.parse(response.result);
          for (const entry of page.data) {
            if (entry.hidden) continue;
            const {model} = Assignment.parse({provider: 'codex', model: entry.model});
            const displayName = entry.displayName.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
            if (!displayName || displayName.length > 200) throw new Error('Invalid Codex model display name');
            if (models.some(existing => existing.model === model)) throw new Error('Codex returned a duplicate model identity; refresh the catalog');
            models.push({model, displayName, isDefault: entry.isDefault === true});
          }
          if (page.nextCursor) {
            if (cursors.has(page.nextCursor)) throw new Error('Codex repeated a model catalog cursor');
            cursors.add(page.nextCursor); requestPage(page.nextCursor);
          } else {
            if (!models.length) throw new Error('Codex returned no selectable models. Sign in using codex login and retry.');
            result = models; input.end();
            shutdown = setTimeout(() => {if (child.pid) void terminateTree(child.pid);}, 1000);
          }
        } catch (error) {stop(error instanceof Error ? error : new Error('Invalid Codex model discovery response')); return;}
        if (result) break;
      }
    });
    child.on('error', () => {cleanup(); reject(new Error('Could not start the official Codex model catalog. Check the CLI installation.'));});
    child.on('close', code => {
      cleanup();
      if (result && !failure) resolve(result);
      else reject(failure || new Error(`Codex model discovery ended before returning a complete catalog (exit ${code}). Update the official CLI and retry.`));
    });
  });
}
