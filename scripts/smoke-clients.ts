import { CliClient } from '../src/adapters/index.js';
import { Assignment } from '../src/contracts.js';

const [provider, model] = process.argv.slice(2);
if (process.env.EASY_SKILLS_ALLOW_CLIENT_PROBES !== '1') throw new Error('Real client requests are opt-in. After explicit permission, set EASY_SKILLS_ALLOW_CLIENT_PROBES=1; this consumes your account quota.');
if (!provider || !model) throw new Error('Usage: npm run smoke:clients -- codex|claude-code EXACT_MODEL_ID');
const assignment = Assignment.parse({provider, model}), client = new CliClient();
const diagnostic = await client.diagnose(assignment, process.cwd());
if (!diagnostic.authenticated) throw new Error('Install and sign in through the official CLI first');
let session: string | undefined;
const prompt = 'Do not use tools. Reply exactly {"outcome":"passed","summary":"Compatibility smoke check","findings":[]}';
await client.run(assignment, prompt, {cwd: process.cwd(), mode: 'read', timeoutMs: 120_000, onSession: id => {session = id;}});
if (!session) throw new Error('No persisted session ID returned');
const result = await client.run(assignment, prompt, {cwd: process.cwd(), mode: 'read', timeoutMs: 120_000, session});
console.log(JSON.stringify({assignment, diagnostic, exactSessionResumed: session, result}, null, 2));
