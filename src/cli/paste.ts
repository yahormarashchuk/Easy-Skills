import type { EventEmitter } from 'node:events';

/** Lines of one paste arrive within a few milliseconds of each other; a person typing never presses Enter this fast. */
const DEFAULT_QUIET_MS = 250;

export function pasteQuietMs(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.EASY_SKILLS_PASTE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_QUIET_MS;
}

/**
 * Reads one answer from a readline-like source. A terminal turns every newline of pasted text into Enter, so the
 * answer is the first line plus every line that follows before the input has been quiet for `quietMs`. Anything
 * pasted therefore stays one answer instead of spilling into the next questions.
 */
export class PastedAnswer {
  constructor(private readonly source: EventEmitter, private readonly activity?: EventEmitter, private readonly quietMs = pasteQuietMs()) {}
  next(): Promise<string> {
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      let timer: NodeJS.Timeout | undefined;
      const stop = () => {
        clearTimeout(timer);
        this.source.off('line', onLine); this.source.off('close', onClose); this.activity?.off('data', onData);
      };
      const arm = () => {clearTimeout(timer); timer = setTimeout(() => {stop(); resolve(lines.join('\n'));}, this.quietMs);};
      const onLine = (line: string) => {lines.push(line); arm();};
      /** Pasted text can stall in the middle of a line; any received input keeps the answer open. */
      const onData = () => {if (lines.length) arm();};
      const onClose = () => {
        stop();
        if (lines.length) resolve(lines.join('\n'));
        else reject(new Error('Input was closed before an answer was given. Saved answers are kept; run the command again to continue.'));
      };
      this.source.on('line', onLine); this.source.on('close', onClose); this.activity?.on('data', onData);
    });
  }
}
