import { execute } from '../process.js';
import { Store } from '../persistence/store.js';
import { Identifier } from '../contracts.js';

export async function inspectCompose(file: string, featureId: string, cwd: string) {
  Identifier.parse(featureId);
  const project = 'easy-skills-' + featureId;
  const result = await execute({command: 'docker', args: ['compose', '-p', project, '-f', file, 'config', '--format', 'json']}, {cwd, timeoutMs: 30_000});
  if (result.code !== 0) throw new Error('Compose configuration could not be inspected; Docker is optional');
  const config = JSON.parse(result.stdout);
  const risks: string[] = [];
  for (const [name, service] of Object.entries(config.services || {}) as [string, any][]) {
    if (service.container_name) risks.push(`${name}: fixed container_name is shared`);
    for (const port of service.ports || []) if (port.published) risks.push(`${name}: published port ${port.published} needs feature-specific allocation`);
    for (const volume of service.volumes || []) if (volume.type === 'bind') risks.push(`${name}: bind mount ${volume.source} may share mutable data`);
  }
  for (const [name, volume] of Object.entries(config.volumes || {}) as [string, any][])
    if (volume.external || (volume.name && !volume.name.startsWith(project + '_'))) risks.push(`${name}: shared/external volume`);
  return {project, risks, config};
}
export async function withResource<T>(store: Store, name: string, operation: () => Promise<T>): Promise<T> {
  const key = 'environment:' + name, owner = store.acquire(key);
  try {return await operation();} finally {store.release(key, owner);}
}
