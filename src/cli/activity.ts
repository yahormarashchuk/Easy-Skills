import type { Assignment } from '../contracts.js';

interface Output {write(text: string): unknown; columns?: number}
interface Style {color: boolean; unicode: boolean; tone: number}

const frames = {unicode: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], ascii: ['|', '/', '-', '\\']};
const HISTORY = 4;

export function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
}

/**
 * A small block redrawn in place while a model works: a spinner with the stage, model and elapsed
 * time, followed by the latest actions the client reported. It collapses to one line when done.
 */
export class ActivityView {
  private readonly steps: string[] = [];
  private readonly started = Date.now();
  private readonly timer: NodeJS.Timeout;
  private count = 0; private drawn = 0; private frame = 0; private finished = false;
  constructor(private readonly out: Output, private readonly title: string, private readonly assignment: Assignment, private readonly style: Style) {
    this.render();
    this.timer = setInterval(() => this.render(), 120);
    this.timer.unref();
  }
  /** Rendering happens on the next tick, so a burst of events costs one redraw. */
  update(text: string) {
    if (this.finished || !text || text === this.steps.at(-1)) return;
    this.steps.push(text); this.count++;
    if (this.steps.length > HISTORY) this.steps.shift();
  }
  /** Remove the block so other output can be written; the next tick draws it again below. */
  erase() {
    if (!this.drawn) return;
    this.out.write((this.drawn > 1 ? `\u001b[${this.drawn - 1}A` : '') + '\r\u001b[J');
    this.drawn = 0;
  }
  done(ok: boolean) {
    if (this.finished) return;
    this.finished = true; clearInterval(this.timer);
    const {unicode} = this.style, mark = ok ? (unicode ? '✔' : '[x]') : (unicode ? '✖' : '[!]');
    const steps = this.count === 1 ? '1 step' : this.count + ' steps';
    this.draw([this.paint(ok ? '32' : '31', this.fit(`${mark} ${this.title} ${ok ? 'finished' : 'stopped'} in ${elapsed(Date.now() - this.started)} · ${steps}`))]);
    this.out.write('\n\n'); this.drawn = 0;
  }
  private render() {
    if (this.finished) return;
    const {unicode, tone} = this.style, spinner = unicode ? frames.unicode : frames.ascii;
    const lead = `${spinner[this.frame++ % spinner.length]} ${this.title}`, {provider, model, effort} = this.assignment;
    const header = this.fit(`${lead} · ${provider} ${model}${effort ? ' (' + effort + ')' : ''} · ${elapsed(Date.now() - this.started)}`);
    const steps = this.steps.length ? this.steps : ['Waiting for the first response'];
    this.draw([this.paint(`1;${tone}`, header.slice(0, lead.length)) + header.slice(lead.length),
      ...steps.map((step, i) => {const line = this.fit(`    ${unicode ? '›' : '>'} ${step}`); return i < steps.length - 1 ? this.paint('90', line) : line;})]);
  }
  private draw(lines: string[]) {
    this.out.write((this.drawn > 1 ? `\u001b[${this.drawn - 1}A` : '') + '\r' + lines.map(line => '\u001b[2K' + line).join('\n') + '\u001b[J');
    this.drawn = lines.length;
  }
  /** Lines must never wrap, or moving the cursor up would no longer reach the top of the block. */
  private fit(text: string) {
    const width = Math.max(20, (this.out.columns || 80) - 1);
    return text.length <= width ? text : text.slice(0, width - 3) + '...';
  }
  private paint(code: string, text: string) {
    return this.style.color && text ? `\u001b[${code}m${text}\u001b[0m` : text;
  }
}
