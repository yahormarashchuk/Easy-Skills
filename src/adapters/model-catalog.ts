import crossSpawn from 'cross-spawn';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { Assignment, VERSION } from '../contracts.js';
import { childEnvironment } from '../execution.js';
import { terminateTree } from '../process.js';

export interface ModelOption {model: string; displayName: string; isDefault: boolean; efforts?: {value: string; description: string}[]; defaultEffort?: string}
const Page = z.object({data: z.array(z.object({model: z.string().min(1), displayName: z.string().min(1),
  hidden: z.boolean().optional(), isDefault: z.boolean().optional(), defaultReasoningEffort: z.string().optional(),
  supportedReasoningEfforts: z.array(z.object({reasoningEffort: z.string(), description: z.string()})).max(32).optional()})), nextCursor: z.string().min(1).nullable().optional()});

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
            const efforts = entry.supportedReasoningEfforts?.map(item => ({value: Assignment.parse({provider: 'codex', model, effort: item.reasoningEffort}).effort!, description: item.description.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 300)}));
            if (efforts && new Set(efforts.map(item => item.value)).size !== efforts.length) throw new Error('Codex returned duplicate reasoning effort values');
            const defaultEffort = entry.defaultReasoningEffort;
            if (defaultEffort && !efforts?.some(item => item.value === defaultEffort)) throw new Error('Codex returned an unsupported default reasoning effort');
            models.push({model, displayName, isDefault: entry.isDefault === true, ...(efforts ? {efforts} : {}), ...(defaultEffort ? {defaultEffort} : {})});
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

const ClaudeModels = z.array(z.object({value: z.string().min(1), resolvedModel: z.string().min(1).optional(), displayName: z.string().min(1),
  description: z.string().optional(), supportsEffort: z.boolean().optional(), supportedEffortLevels: z.array(z.string()).max(32).optional()})).max(200);

/**
 * Metadata only: the official client's initialize control request reports the
 * account's picker entries with exact resolved IDs. No prompt is sent, so no turn runs.
 * Aliases are collapsed onto their resolved exact ID; models without effort levels are omitted.
 */
export function readClaudeModels(resolved: {command: string; prefix: string[]}, cwd: string, args: string[], timeoutMs = 30_000): Promise<ModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(resolved.command, [...resolved.prefix, ...args],
      {cwd, env: childEnvironment('client'), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    const decoder = new StringDecoder('utf8'), requestId = 'easy-skills-models';
    const input = child.stdin!, output = child.stdout!, errors = child.stderr!;
    let pending = '', total = 0, result: ModelOption[] | undefined, failure: Error | undefined;
    // The client keeps waiting for a prompt after initialize, so it is always terminated here.
    const stop = (error?: Error) => {if (failure) return; if (error && !result) failure = error; input.end(); if (child.pid) void terminateTree(child.pid);};
    const timeout = setTimeout(() => stop(new Error('Claude Code model discovery timed out. Check the official CLI installation and login, then retry.')), timeoutMs);
    child.on('spawn', () => input.write(JSON.stringify({type: 'control_request', request_id: requestId, request: {subtype: 'initialize'}}) + '\n'));
    input.on('error', () => {if (!result) stop(new Error('Claude Code model discovery connection closed unexpectedly'));});
    errors.resume();
    output.on('data', (bytes: Buffer) => {
      if (failure || result) return;
      total += bytes.length;
      if (total > 4_194_304) {stop(new Error('Claude Code model discovery exceeded the response limit')); return;}
      pending += decoder.write(bytes);
      let boundary: number;
      while ((boundary = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, boundary).trim(); pending = pending.slice(boundary + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type !== 'control_response' || event.response?.request_id !== requestId) continue;
          if (event.response.subtype !== 'success') throw new Error('Claude Code could not list models. Check official CLI login and update the client, then retry.');
          const entries = ClaudeModels.parse(event.response.response?.models);
          const models: ModelOption[] = [];
          const defaultModel = entries.find(entry => entry.value === 'default')?.resolvedModel;
          for (const entry of entries) {
            const exact = entry.resolvedModel || entry.value;
            if (!entry.supportsEffort || !entry.supportedEffortLevels?.length || models.some(existing => existing.model === exact)) continue;
            const parsed = Assignment.safeParse({provider: 'claude-code', model: exact});
            if (!parsed.success) continue;
            const named = entries.find(other => other.value !== 'default' && (other.resolvedModel || other.value) === exact) || entry;
            const displayName = named.displayName.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 200) || exact;
            const efforts = [...new Set(entry.supportedEffortLevels)].map(level => ({value: Assignment.parse({provider: 'claude-code', model: exact, effort: level}).effort!, description: ''}));
            models.push({model: parsed.data.model, displayName, isDefault: exact === defaultModel, efforts});
          }
          if (!models.length) throw new Error('Claude Code returned no selectable models. Sign in using claude auth login and retry.');
          result = models; clearTimeout(timeout); stop();
        } catch (error) {stop(error instanceof Error ? error : new Error('Invalid Claude Code model discovery response')); return;}
        if (result) break;
      }
    });
    child.on('error', () => {clearTimeout(timeout); reject(new Error('Could not start Claude Code model discovery. Check the CLI installation.'));});
    child.on('close', code => {
      clearTimeout(timeout);
      if (result && !failure) resolve(result);
      else reject(failure || new Error(`Claude Code model discovery ended before returning a catalog (exit ${code}). Update the official CLI and retry.`));
    });
  });
}
