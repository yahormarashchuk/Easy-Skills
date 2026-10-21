/** Maintained source paths; the packer and installer use the same dependency map. */
export function skillResources(skill: string): Record<string, string> {
  const shared: Record<string, string> = {'references/workflow.md': 'skills/_shared/workflow.md'};
  if (skill === 'easy-init') shared['references/project.yaml'] = 'templates/project.yaml';
  if (skill === 'easy-plan') {
    shared['references/feature-request.yaml'] = 'templates/feature-request.yaml';
    shared['references/feature.yaml'] = 'templates/feature.yaml';
    shared['references/plan.schema.json'] = 'schemas/plan.schema.json';
  }
  if (skill === 'easy-remote') {
    shared['references/settings.json'] = 'templates/settings.json';
    shared['references/remote-control.md'] = 'docs/remote-control.md';
  }
  return shared;
}
