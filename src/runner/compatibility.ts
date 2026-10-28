import type { Assignment } from '../contracts.js';
import { CliClient, ClientError, type Client } from '../adapters/index.js';
import type { Store } from '../persistence/store.js';

/** The saved launch/resume probe establishes protocol/model compatibility for one binary.
 * Authentication is checked without model calls on every recovery; quota is runtime state. */
export async function requireCompatibility(store: Store, client: Client, assignment: Assignment, cwd: string) {
  // Fail before inspecting auth when no exact configuration has ever been approved/probed.
  if (!store.db.prepare('SELECT key FROM probes WHERE key=?').get(store.probeKey(assignment)))
    throw new Error(`Validate the exact model configuration first: ${assignment.provider}/${assignment.model}${assignment.effort ? ' (effort: ' + assignment.effort + ')' : ''}`);
  const diagnostic = await (client.diagnose ? client.diagnose(assignment, cwd) : new CliClient().diagnose(assignment, cwd));
  if (!diagnostic.installed) throw new ClientError('failure', `CLI installation unavailable: ${assignment.provider}`);
  if (!diagnostic.authenticated) throw new ClientError('auth', `Official CLI authentication expired or unavailable: ${assignment.provider}; sign in and resume`);
  if (diagnostic.isolation === false) throw new ClientError('prerequisite', diagnostic.detail || 'Client capability isolation unavailable');
  if (!store.hasProbe(assignment, diagnostic)) throw new ClientError('failure', `CLI path/version compatibility changed for ${assignment.provider}/${assignment.model}; review and rerun doctor --probe with the same exact model${assignment.effort ? ' and --effort ' + assignment.effort : ''}`);
  return diagnostic;
}
