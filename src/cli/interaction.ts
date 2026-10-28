import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Interaction } from '../runner/guided.js';
import { redact } from '../util.js';
import { resolveChoice, type Choice } from './choices.js';
import { Provider } from '../contracts.js';

const Script = z.record(z.string(), z.union([z.string(), z.boolean()]));
/** Missing scripted consent is always an error, never an implicit yes. */
export class TerminalInteraction implements Interaction {
  private answers?: z.infer<typeof Script>;
  private terminal?: ReturnType<typeof createInterface>;
  constructor(readonly options: {answers?: string; nonInteractive?: boolean} = {}) {
    if (options.answers) this.answers = Script.parse(JSON.parse(readFileSync(options.answers, 'utf8')));
  }
  say(text: string) {stdout.write(redact(text) + '\n\n');}
  private async input(id: string, question: string, fallback?: string) {
    if (this.answers && id in this.answers) return this.answers[id]!;
    if (this.options.nonInteractive || this.answers || !stdin.isTTY || !stdout.isTTY)
      throw new Error(`Input required (${id}): ${question}. Use an interactive terminal or --non-interactive --answers FILE with explicit answers and approvals.`);
    this.terminal ||= createInterface({input: stdin, output: stdout});
    return (await this.terminal.question(question + (fallback ? ` [${fallback}]` : '') + ': ')).trim();
  }
  async ask(id: string, question: string, fallback?: string) {
    const answer = await this.input(id, question, fallback);
    if (typeof answer !== 'string') throw new Error('Expected text for ' + id);
    if (!answer && !fallback) throw new Error('A value is required for ' + id);
    return answer || fallback!;
  }
  async askProvider(id: string, question: string, fallback: Provider): Promise<Provider> {
    const scripted = !!this.answers || !!this.options.nonInteractive;
    while (true) {
      const answer = await this.ask(id, question, fallback);
      const provider = Provider.safeParse(answer);
      if (provider.success) return provider.data;
      const message = 'Unknown provider. Enter codex or claude-code, or press Enter to keep the displayed provider. Model numbers are chosen at the next prompt.';
      if (scripted) throw new Error(`Invalid provider for ${id}. Enter codex or claude-code.`);
      this.say(message);
    }
  }
  async select(id: string, question: string, choices: Choice[], fallback?: string) {
    if (!choices.length) throw new Error('No models are available to select');
    const scripted = !!this.answers || !!this.options.nonInteractive;
    const defaultIndex = choices.findIndex(choice => choice.value === fallback);
    this.say(question + '\n' + choices.map((choice, index) => `  ${index + 1}. ${choice.label}${index === defaultIndex ? ' [default]' : ''}`).join('\n'));
    while (true) {
      const answer = await this.input(id, `Choose a model by number (1-${choices.length})`, !scripted && defaultIndex >= 0 ? String(defaultIndex + 1) : undefined);
      if (typeof answer !== 'string') throw new Error('Expected a model selection for ' + id);
      try {return resolveChoice(answer, choices, scripted ? undefined : fallback, !scripted);}
      catch (error) {if (scripted) throw error; this.say((error as Error).message);}
    }
  }
  async confirm(id: string, question: string, binding?: string) {
    if (binding && (this.answers || this.options.nonInteractive)) {
      const answer = await this.input(id, question + ` After reviewing this proposal, provide ${JSON.stringify(id)}: ${JSON.stringify('approve:' + binding)} in the answer file`);
      if (answer === false || answer === 'no') return false;
      if (answer !== 'approve:' + binding) throw new Error(`Approval for ${id} does not match the displayed proposal. Review it, then provide "approve:${binding}". A boolean cannot approve generated work in scripted mode.`);
      return true;
    }
    const answer = await this.input(id, question + ' [y/N]');
    return answer === true || typeof answer === 'string' && /^(?:y|yes)$/i.test(answer);
  }
  close() {this.terminal?.close();}
}
