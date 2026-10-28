export interface Choice {value: string; label: string}

/** Resolve the displayed ordering; scripted choices must use stable exact identities. */
export function resolveChoice(answer: string, choices: Choice[], fallback?: string, allowNumber = true, kind: 'model' | 'effort' = 'model'): string {
  const value = answer.trim();
  if (!value && fallback && choices.some(choice => choice.value === fallback)) return fallback;
  if (/^\d+$/.test(value)) {
    if (!allowNumber) throw new Error(`Scripted ${kind} selections require an exact ${kind === 'model' ? 'model ID' : 'effort value'}, not a menu number that can change when the catalog is refreshed`);
    const selected = choices[Number(value) - 1];
    if (selected && /^[1-9]\d*$/.test(value)) return selected.value;
  } else if (choices.some(choice => choice.value === value)) return value;
  throw new Error(`Choose a number from 1 to ${choices.length}${fallback ? ', or press Enter to keep the default' : ''}.`);
}
