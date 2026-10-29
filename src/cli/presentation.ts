import { Stage, type Cursor } from '../contracts.js';

type DisplayStage = Stage | Cursor | 'SYNC';
const details: Record<DisplayStage, {description: string; color: number}> = {
  DEFINE: {description: 'Clarify requirements and project context', color: 36},
  PLAN: {description: 'Plan the work', color: 34},
  BUILD: {description: 'Implement the approved changes', color: 32},
  VERIFY: {description: 'Run checks on the current revision', color: 33},
  REVIEW: {description: 'Review the changes and evidence', color: 35},
  SHIP: {description: 'Deliver the reviewed changes', color: 36},
  REPAIR: {description: 'Address the reported problem', color: 31},
  SYNC: {description: 'Update against the base branch', color: 34},
  INTEGRATE: {description: 'Integrate approved task work', color: 32},
};

export function useColor(isTTY: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

/** Legacy Windows consoles lack progress glyphs; Windows Terminal, VS Code and JetBrains terminals have them. */
export function useUnicode(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform !== 'win32') return env.TERM !== 'linux';
  return !!env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' || env.ConEmuTask === '{cmd::Cmder}' || /^(?:xterm-256color|alacritty)$/.test(env.TERM || '');
}

export function stageColor(name: string): number {
  return details[name as DisplayStage]?.color ?? 36;
}

// Stages outside the six-step pipeline are shown at the pipeline step they belong to.
const pipelineStep: Record<DisplayStage, Stage> = {DEFINE: 'DEFINE', PLAN: 'PLAN', BUILD: 'BUILD', VERIFY: 'VERIFY', REVIEW: 'REVIEW', SHIP: 'SHIP',
  REPAIR: 'BUILD', SYNC: 'VERIFY', INTEGRATE: 'SHIP'};

/** One line showing finished, current and upcoming pipeline steps. */
export function stepTracker(stage: DisplayStage, color = false, unicode = false): string {
  const current = Stage.options.indexOf(pipelineStep[stage]);
  const [done, active, next, joint] = unicode ? ['✔', '●', '○', ' ── '] : ['[x]', '[>]', '[ ]', ' - '];
  const paint = (code: string, text: string) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  return Stage.options.map((name, i) => (i ? paint(i <= current ? '32' : '90', joint) : '') +
    (i < current ? paint('32', done + ' ' + name) : i === current ? paint(`1;${details[stage].color}`, active + ' ' + name) : paint('90', next + ' ' + name))).join('');
}

export function stageBanner(stage: DisplayStage, context: 'model' | 'current', color = false, unicode = false): string {
  const position = Stage.options.indexOf(stage as Stage);
  const title = context === 'model' && position >= 0 ? `[${position + 1}/${Stage.options.length}] MODEL SETUP: ${stage}` : `CURRENT STAGE: ${stage}`;
  const line = `---------- ${title} ----------`;
  const heading = color ? `\u001b[1;${details[stage].color}m${line}\u001b[0m` : line;
  const tracker = context === 'current' ? `\n  ${stepTracker(stage, color, unicode)}` : '';
  return `${heading}\n  ${details[stage].description}${tracker}\n${'-'.repeat(Math.min(line.length, 70))}`;
}

/** Preserve question text while adding line breaks at spaces for easier reading. */
export function interviewQuestion(question: string, number: number, columns = 80, color = false): string {
  const width = Math.max(40, Math.min(100, columns - 2));
  const lines: string[] = [];
  for (let line of question.split('\n')) {
    while (line.length > width) {
      const split = line.lastIndexOf(' ', width);
      if (split <= 0) break;
      lines.push(line.slice(0, split)); line = line.slice(split + 1);
    }
    lines.push(line);
  }
  const heading = `---------- QUESTION ${number} ----------`;
  return `${color ? `\u001b[1;36m${heading}\u001b[0m` : heading}\n${lines.join('\n')}\n${'-'.repeat(heading.length)}`;
}
