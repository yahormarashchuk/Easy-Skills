import { StageResult, Plan } from '../contracts.js';

/** Deliberately small common subset, with no refs, defaults, unions of objects or recursive Plan.
 * Planning transports the Plan as JSON text and validates it independently at runtime. */
export function outputSchema(planning = false) {
  const properties: Record<string, unknown> = {
    outcome: {type: 'string', enum: ['passed', 'blocked', 'failed']}, summary: {type: 'string'},
    findings: {type: 'array', items: {type: 'string'}}, question: {type: ['string', 'null']},
  };
  if (planning) properties.planJson = {type: ['string', 'null']};
  return {type: 'object', properties, required: Object.keys(properties), additionalProperties: false};
}
export function parseOutput(value: unknown) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid structured result object');
  const {question, planJson, ...rest} = parsed;
  return StageResult.parse({...rest, ...(question == null ? {} : {question}), ...(planJson == null ? {} : {plan: Plan.parse(JSON.parse(planJson))})});
}
