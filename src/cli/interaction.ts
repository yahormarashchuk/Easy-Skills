import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Activity, Interaction } from '../runner/guided.js';
import { redact } from '../util.js';
import { resolveChoice, type Choice } from './choices.js';
import { Provider } from '../contracts.js';
import { interviewQuestion, stageBanner, stageColor, useColor, useUnicode } from './presentation.js';
import { ActivityView } from './activity.js';
import type { Assignment, Stage } from '../contracts.js';
import type { ProviderOption } from '../adapters/index.js';

const Script = z.record(z.string(), z.union([z.string(), z.boolean()]));
/** Missing scripted consent is always an error, never an implicit yes. */
export class TerminalInteraction implements Interaction {
  private answers?: z.infer<typeof Script>;
  private terminal?: ReturnType<typeof createInterface>;
  private interviewCount = 0;
  private view?: ActivityView;
  constructor(readonly options: {answers?: string; nonInteractive?: boolean} = {}) {
    if (options.answers) this.answers = Script.parse(JSON.parse(readFileSync(options.answers, 'utf8')));
  }
  private get live() {return !this.answers && !this.options.nonInteractive && !!stdout.isTTY;}
  say(text: string) {this.view?.erase(); stdout.write(redact(text) + '\n\n');}
  stage(stage: Stage, context: 'model' | 'current') {this.say(stageBanner(stage, context, this.live && useColor(stdout.isTTY), this.live && useUnicode()));}
  /** Scripted and redirected output stays a plain transcript; only an interactive terminal is redrawn. */
  activity(title: string, assignment: Assignment): Activity {
    if (!this.live) return {update() {}, done() {}};
    this.view?.done(false);
    const view = this.view = new ActivityView(stdout, title, assignment, {color: useColor(stdout.isTTY), unicode: useUnicode(), tone: stageColor(title)});
    return {update: text => view.update(redact(text)), done: ok => {view.done(ok); if (this.view === view) this.view = undefined;}};
  }
  private async input(id: string, question: string, fallback?: string) {
    if (this.answers && id in this.answers) return this.answers[id]!;
    if (this.options.nonInteractive || this.answers || !stdin.isTTY || !stdout.isTTY)
      throw new Error(`Input required (${id}): ${question}. Use an interactive terminal or --non-interactive --answers FILE with explicit answers and approvals.`);
    this.terminal ||= createInterface({input: stdin, output: stdout});
    const answer = (await this.terminal.question(question + (fallback ? ` [${fallback}]` : '') + ': ')).trim();
    stdout.write('\n');
    return answer;
  }
  async ask(id: string, question: string, fallback?: string) {
    if (id.startsWith('interview:') && !this.answers && !this.options.nonInteractive && stdin.isTTY && stdout.isTTY) {
      this.say(interviewQuestion(question, ++this.interviewCount, stdout.columns, useColor(stdout.isTTY)));
      question = 'Your answer';
    }
    const answer = await this.input(id, question, fallback);
    if (typeof answer !== 'string') throw new Error('Expected text for ' + id);
    if (!answer && !fallback) throw new Error('A value is required for ' + id);
    return answer || fallback!;
  }
  async askProvider(id: string, question: string, fallback: Provider, options?: ProviderOption[]): Promise<Provider> {
    const scripted = !!this.answers || !!this.options.nonInteractive;
    const providers = options || Provider.options.map(provider => ({provider, available: true}));
    const labels: Record<Provider, string> = {'codex': 'Codex CLI', 'claude-code': 'Claude Code'};
    this.say(question + '\n' + providers.map((option, i) => `  ${i + 1}. ${labels[option.provider]}${option.available ? '' : ' [unavailable: ' + (option.reason || 'Check the client setup.') + ']'}${option.available && option.provider === fallback ? ' [default]' : ''}`).join('\n'));
    this.say('Client login and model access are checked separately after selection.');
    if (!providers.some(option => option.available)) throw new Error('No providers are currently available. Install or configure the official Codex CLI and retry.');
    const defaultIndex = providers.findIndex(option => option.provider === fallback && option.available);
    while (true) {
      const answer = await this.input(id, `Choose a provider by number (1-${providers.length})`, !scripted && defaultIndex >= 0 ? String(defaultIndex + 1) : undefined);
      if (typeof answer !== 'string') throw new Error('Expected a provider selection for ' + id);
      const value = answer.trim();
      if (scripted && /^\d+$/.test(value)) throw new Error(`Invalid provider for ${id}. Scripted answers must use a provider ID such as codex or claude-code.`);
      const index = /^[1-9]\d*$/.test(value) ? Number(value) - 1 : -1;
      const option = !scripted && !value && defaultIndex >= 0 ? providers[defaultIndex] : index >= 0 ? providers[index] : providers.find(item => item.provider === value);
      if (!option) {
        const message = `Choose a provider number from 1 to ${providers.length}${defaultIndex >= 0 && !scripted ? ', or press Enter for the default' : ''}.`;
        if (scripted) throw new Error(`Invalid provider for ${id}. Enter codex or claude-code.`);
        this.say(message); continue;
      }
      if (!option.available) {
        const message = `${labels[option.provider]} is unavailable. ${option.reason || 'Check the client setup.'}`;
        if (scripted) throw new Error(message);
        this.say(message + ' Choose an available provider.'); continue;
      }
      return Provider.parse(option.provider);
    }
  }
  async select(id: string, question: string, choices: Choice[], fallback?: string, kind: 'model' | 'effort' = 'model') {
    if (!choices.length) throw new Error(`No ${kind} options are available to select`);
    const scripted = !!this.answers || !!this.options.nonInteractive;
    const defaultIndex = choices.findIndex(choice => choice.value === fallback);
    this.say(question + '\n' + choices.map((choice, index) => `  ${index + 1}. ${choice.label}${index === defaultIndex ? ' [default]' : ''}`).join('\n'));
    while (true) {
      const answer = await this.input(id, `Choose ${kind === 'model' ? 'a model' : 'reasoning effort'} by number (1-${choices.length})`, !scripted && defaultIndex >= 0 ? String(defaultIndex + 1) : undefined);
      if (typeof answer !== 'string') throw new Error(`Expected a ${kind} selection for ` + id);
      try {return resolveChoice(answer, choices, scripted ? undefined : fallback, !scripted, kind);}
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
