import { isAbsolute, relative } from 'node:path';
import type { Assignment } from '../contracts.js';

/**
 * Short display text for one client protocol event, or undefined when the event shows nothing useful.
 * Model output is shown only so the owner can follow progress; it is never a result or evidence.
 */
export function describeActivity(provider: Assignment['provider'], line: string, cwd?: string): string | undefined {
  let event: any;
  try {event = JSON.parse(line);} catch {return undefined;}
  if (!event || typeof event !== 'object') return undefined;
  try {return clean(provider === 'codex' ? codex(event, cwd) : claude(event, cwd));} catch {return undefined;}
}
function codex(event: any, cwd?: string): string | undefined {
  if (event.type === 'turn.started') return 'Thinking';
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined;
  const item = event.item || {}, started = event.type === 'item.started';
  switch (item.type) {
    case 'reasoning': return thought(item.text);
    case 'agent_message': return started ? undefined : firstLine(item.text);
    case 'command_execution': return started ? 'Running ' + unwrapShell(item.command) : undefined;
    case 'file_change': return Array.isArray(item.changes) ? 'Editing ' + item.changes.map((change: any) => path(change?.path, cwd)).join(', ') : undefined;
    case 'mcp_tool_call': return 'Using ' + [item.server, item.tool].filter(Boolean).join('.');
    case 'web_search': return 'Searching the web for ' + item.query;
    case 'todo_list': {
      const next = Array.isArray(item.items) ? item.items.find((entry: any) => !entry?.completed) : undefined;
      return next?.text ? 'Next step: ' + next.text : undefined;
    }
  }
  return undefined;
}
function claude(event: any, cwd?: string): string | undefined {
  if (event.type === 'system' && event.subtype === 'init') return 'Session started';
  if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return undefined;
  for (const block of [...event.message.content].reverse()) {
    const text = claudeBlock(block, cwd);
    if (text) return text;
  }
  return undefined;
}
function claudeBlock(block: any, cwd?: string): string | undefined {
  if (block?.type === 'thinking') return thought(block.thinking);
  if (block?.type === 'text') return firstLine(block.text);
  if (block?.type !== 'tool_use') return undefined;
  const input = block.input || {}, where = input.path ? ' in ' + path(input.path, cwd) : '';
  switch (block.name) {
    case 'Read': return 'Reading ' + path(input.file_path, cwd);
    case 'Glob': return 'Finding files ' + input.pattern + where;
    case 'Grep': return 'Searching for ' + JSON.stringify(input.pattern) + where;
    case 'Bash': return 'Running ' + input.command;
    case 'Edit': case 'MultiEdit': return 'Editing ' + path(input.file_path, cwd);
    case 'Write': return 'Writing ' + path(input.file_path, cwd);
    default: return typeof block.name === 'string' ? 'Using ' + block.name : undefined;
  }
}
function thought(text: unknown) {
  const line = firstLine(text);
  return line ? 'Thinking: ' + line : 'Thinking';
}
function firstLine(text: unknown) {
  return typeof text === 'string' ? text.split(/\r?\n/).map(line => line.replace(/\*\*|__|`/g, '').trim()).find(Boolean) : undefined;
}
/** Codex reports the full shell invocation; the command inside it is what the owner cares about. */
function unwrapShell(command: unknown) {
  const text = Array.isArray(command) ? command.join(' ') : String(command ?? '');
  const inner = text.match(/^"?(?:[^"\s]*[\\/])?(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?"?\s+(?:-NoLogo\s+|-NoProfile\s+)*(?:-lc|-c|-Command|\/c)\s+([\s\S]+)$/i)?.[1] ?? text;
  return inner.replace(/^(['"])([\s\S]*)\1$/, '$2');
}
function path(value: unknown, cwd?: string) {
  if (typeof value !== 'string') return '';
  const rel = cwd && isAbsolute(value) ? relative(cwd, value) : '';
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : value).replace(/\\/g, '/');
}
/** Terminal control and bidirectional characters from model output must never reach the screen. */
function clean(text: string | undefined, limit = 300) {
  return text?.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) || undefined;
}
