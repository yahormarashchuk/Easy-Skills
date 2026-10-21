import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { Project, Assignment, Plan, StageResult, RunSchema } from '../dist/contracts.js';
import { FeatureRequest } from '../dist/runner/planning.js';
mkdirSync('schemas', {recursive: true});
for (const [name, schema] of Object.entries({project: Project, assignment: Assignment, plan: Plan, run: RunSchema, 'feature-request': FeatureRequest, 'stage-result': StageResult})) {
  writeFileSync(`schemas/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
}
