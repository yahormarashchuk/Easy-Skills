#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync, openSync, closeSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parse } from 'yaml';
import { Assignment, Plan, VERSION } from '../contracts.js';
import { Store } from '../persistence/store.js';
import { Engine } from '../runner/engine.js';
import { worker } from '../runner/worker.js';
import { CliClient } from '../adapters/index.js';
import { Git } from '../git/index.js';
import { cleanup, cleanupPlan } from '../runner/cleanup.js';
import { requestMergeDecision, answerDecision } from '../runner/remote.js';
import { ensureDir, hash, message, redact, rulesHash, rejectSymlinkPath } from '../util.js';
import { inspectProject, initProject, loadProject, installSkills, uninstallSkills, updateProject } from './project.js';
import { LocalSettings, settings, mailTransport, flushNotifications } from '../notifications/index.js';
import { configProposal, applyConfig } from '../integrations/config.js';
import { inspectCompose } from '../environments/index.js';
import { execute } from '../process.js';
import { generatePlan } from '../runner/planning.js';
import { agreementProposal, applyAgreement } from '../runner/onboarding.js';
import { mcpProposal, applyMcp } from '../integrations/mcp.js';
import { bootstrap } from './bootstrap.js';
import { childEnvironment } from '../execution.js';

const program = new Command().name('easy-skills').version(VERSION).description('Local engineering workflow runner (alpha)');
program.option('--project <path>', 'Project directory', process.cwd());
const output = (value: unknown): void => {process.stdout.write(JSON.stringify(value, null, 2) + '\n');};
const read = (path: string) => parse(readFileSync(resolve(path), 'utf8'));
async function withStore<T>(fn: (store: Store) => Promise<T> | T) {
  const store = new Store();
  try {return await fn(store);} finally {store.close();}
}
function cwd() {return realpathSync.native(program.opts().project);}
function start(store: Store, id: string) {
  const run = store.get(id);
  if (store.locked('worker:' + id)) return {runId: id, attached: true, status: run.status};
  if (!['approved', 'running', 'paused', 'needs_decision', 'waiting_quota', 'waiting_external', 'waiting_resource', 'ready'].includes(run.status)) throw new Error('Run is not startable');
  const log = join(ensureDir(join(store.home, 'logs', id)), 'worker.log');
  const fd = openSync(log, 'a', 0o600);
  // The installed CLI runs as JavaScript; inherit execArgv so source mode can use tsx as well.
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '_worker', id],
    {detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: childEnvironment('supervisor')});
  child.on('error', e => process.stderr.write(redact(message(e)) + '\n'));
  child.unref(); closeSync(fd);
  return {runId: id, pid: child.pid, log, status: 'starting'};
}
program.command('inspect').description('Read-only project inventory').action(async () => output(await inspectProject(cwd())));
program.command('bootstrap').requiredOption('--client <provider>', 'codex or claude-code')
  .option('--target <directory>', 'Override the client skill directory').option('--apply-hash <hash>', 'Apply the reviewed bootstrap')
  .action(async opts => {
    const provider = Assignment.parse({provider: opts.client, model: 'diagnostic-only'}).provider;
    const target = opts.target || join(homedir(), provider === 'codex' ? '.agents' : '.claude', 'skills');
    output(await bootstrap(cwd(), provider, target, opts.applyHash));
  });
program.command('init').requiredOption('--config <file>', 'Proposed project YAML').option('--apply-hash <hash>', 'Apply the reviewed onboarding proposal')
  .action(async opts => output(await initProject(cwd(), read(opts.config), opts.applyHash)));
program.command('project-config').requiredOption('--file <yaml>', 'Reviewed replacement project v2 configuration').option('--apply-hash <hash>', 'Apply the reviewed configuration with a backup')
  .action(async opts => output(await updateProject(cwd(), read(opts.file), opts.applyHash)));
program.command('rules-hash').action(() => output({rulesHash: rulesHash(cwd())}));
program.command('agree-rules').requiredOption('--file <json>', 'Completed interview with explicit resolved decisions')
  .option('--apply-hash <hash>', 'Approve the reviewed agreement revision')
  .action(opts => output(opts.applyHash ? applyAgreement(cwd(), read(opts.file), opts.applyHash) : agreementProposal(cwd(), read(opts.file))));
program.command('doctor').option('--provider <name>', 'codex or claude-code').option('--model <id>', 'Exact model ID for --probe')
  .option('--probe', 'Run a read-only model request and resume its exact session (uses your account quota)')
  .action(async opts => {
    const providers = opts.provider ? [opts.provider] : ['codex', 'claude-code'];
    const client = new CliClient();
    const results: unknown[] = [];
    for (const provider of providers) {
      const assignment = Assignment.parse({provider, model: opts.model || 'diagnostic-only'});
      const diagnostic = await client.diagnose(assignment, cwd());
      const result: any = {provider, ...diagnostic, modelVerified: false};
      if (opts.probe) {
        if (!opts.model) throw new Error('--probe requires an exact --model ID; aliases are not expanded');
        if (!diagnostic.authenticated) throw new Error(provider + ' is not installed/authenticated');
        if (diagnostic.isolation === false) throw new Error(diagnostic.detail || 'Client capability isolation unavailable');
        let session: string | undefined;
        const prompt = 'Do not run tools or edit files. Reply exactly {"outcome":"passed","summary":"Easy Skills compatibility probe","findings":[]}';
        const first = await client.run(assignment, prompt, {cwd: cwd(), mode: 'read', onSession: id => {session = id;}, timeoutMs: 120_000});
        if (!session || first.outcome !== 'passed') throw new Error('Probe did not produce a valid persisted session');
        const resumed = await client.run(assignment, prompt, {cwd: cwd(), session, mode: 'read', timeoutMs: 120_000});
        if (resumed.outcome !== 'passed') throw new Error('Exact-session resume failed');
        await withStore(store => store.recordProbe(assignment, diagnostic.version!, diagnostic.executable));
        Object.assign(result, {modelVerified: true, sessionResumeVerified: true, session});
      }
      results.push(result);
    }
    output({node: process.version, platform: process.platform, clients: results,
      gh: (await execute({command: 'gh', args: ['auth', 'status']}, {cwd: cwd(), timeoutMs: 15_000})).code === 0});
  });
const feature = program.command('feature').description('Draft and approve features');
feature.command('plan').requiredOption('--file <yaml>', 'Agreed feature request and exact assignments')
  .requiredOption('--out <yaml>', 'New local plan draft; does not publish Issues')
  .action(async opts => withStore(async store => {
    const plan = await generatePlan(store, cwd(), read(opts.file));
    writeFileSync(resolve(opts.out), (await import('yaml')).stringify(plan), {flag: 'wx'});
    output({path: resolve(opts.out), planHash: hash(plan), plan, approved: false});
  }));
feature.command('draft').requiredOption('--file <yaml>', 'Complete plan YAML').action(async opts => {
  const git = new Git(cwd()), identity = await git.identity();
  const plan = Plan.parse(read(opts.file)), project = loadProject(identity.root);
  if (hash(project) !== hash(plan.project)) throw new Error('Plan project config differs from project.yaml');
  if (rulesHash(identity.root) !== plan.rulesHash) throw new Error('Plan rules hash is stale; run rules-hash');
  const featureDir = join(identity.root, '.easy-skills', 'features', plan.featureId);
  rejectSymlinkPath(identity.root, featureDir);
  await withStore(store => {
    const run = store.create(identity.root, identity.commonDir, plan);
    const dir = ensureDir(join(featureDir, 'attempts', run.id));
    writeFileSync(join(dir, 'spec.md'), plan.spec, {flag: 'wx'});
    writeFileSync(join(dir, 'plan.md'), `${plan.title}\n\n${plan.tasks.map(t => `- ${t.id}: ${t.title}; depends on ${t.dependsOn.join(', ') || 'none'}`).join('\n')}\n\nAssignments:\n${JSON.stringify(plan.assignments, null, 2)}\n\nPlan hash: ${run.planHash}\n`, {flag: 'wx'});
    writeFileSync(join(dir, 'execution.yaml'), readFileSync(resolve(opts.file), 'utf8'), {flag: 'wx'});
    output({runId: run.id, documents: dir, status: run.status, planHash: run.planHash, plan: run.plan});
  });
});
feature.command('approve <id>').requiredOption('--hash <sha256>', 'Exact reviewed plan hash')
  .action(async (id, opts) => withStore(store => output(new Engine(store).approve(id, opts.hash))));
program.command('start <id>').option('--foreground', 'Run one execution pass attached to this terminal')
  .action(async (id, opts) => withStore(async store => output(opts.foreground ? await new Engine(store).run(id) : start(store, id))));
program.command('resume <id>').description('Resume the approved plan and exact recorded sessions')
  .action(async id => withStore(store => {
    const run = store.get(id);
    if (!['approved', 'running', 'paused', 'needs_decision', 'waiting_quota', 'waiting_external', 'waiting_resource', 'ready'].includes(run.status)) throw new Error('Run is not resumable');
    if (run.status !== 'ready') store.recordOperation(`${id}:resume-request`, id, 'local.resume', {resume: true});
    output(start(store, id));
  }));
program.command('pause <id>').action(async id => withStore(store => {new Engine(store).requestControl(id, 'pause'); output({runId: id, requested: 'pause', at: 'next safe checkpoint'});}));
program.command('stop <id>').action(async id => withStore(store => {new Engine(store).requestControl(id, 'stop'); output({runId: id, requested: 'stop', at: 'next safe checkpoint'});}));
program.command('status [id]').action(async id => withStore(store => output(id ? {...store.get(id), notifications: store.notificationSummary(id)} : store.list().map(r => ({id: r.id, feature: r.plan.title, status: r.status, stopReason: r.stopReason, reason: r.reason, pr: r.finalPr?.url, notifications: store.notificationSummary(r.id)})))));
program.command('events <id>').action(async id => withStore(store => output(store.events(id))));
program.command('abandon <id>').description('Retain history and resources; allow a separately approved replacement').action(async id => withStore(store => new Engine(store).abandon(id).then(output)));
program.command('baseline <id>').requiredOption('--recapture <commit>', 'Exact selected base before implementation').option('--apply-hash <hash>', 'Apply the reviewed recapture').action(async (id, opts) => withStore(async store => output(await new Engine(store).recaptureBaseline(id, opts.recapture, opts.applyHash))));
program.command('setup-reset <id>').requiredOption('--worktree <name>', 'integration or task ID').option('--apply-hash <hash>', 'Approve retry against retained partial setup outputs')
  .action(async (id, opts) => withStore(async store => output(await new Engine(store).resetSetup(id, opts.worktree, opts.applyHash))));
program.command('sync <id>').action(async id => withStore(async store => output(await new Engine(store).syncManual(id))));
program.command('merge <id>').requiredOption('--head <commit>', 'Explicitly authorize main-branch merge of this reviewed revision')
  .action(async (id, opts) => withStore(async store => output(await new Engine(store).confirmFinalMerge(id, opts.head))));
program.command('retry-merge <id>').requiredOption('--pr <number>', 'Previously failed PR merge').requiredOption('--head <commit>', 'Exact reviewed head')
  .option('--apply-hash <hash>', 'Authorize a fresh request after reviewing the terminal previous operation')
  .action(async (id, opts) => withStore(async store => output(await new Engine(store).authorizeMergeRetry(id, Number(opts.pr), opts.head, opts.applyHash))));
program.command('request-merge <id>').description('Send a one-time remote confirmation code by configured email')
  .action(async id => withStore(async store => output({request: await requestMergeDecision(store, store.get(id)), delivery: 'SMTP accepted'})));
program.command('answer <id>').requiredOption('--request <uuid>', 'Current decision request ID').requiredOption('--value <text>', 'Clarification within approved scope')
  .action(async (id, opts) => withStore(store => {answerDecision(store, id, opts.request, opts.value); output(start(store, id));}));
program.command('cleanup <id>').option('--apply-hash <hash>', 'Remove only resources in the reviewed cleanup plan')
  .option('--setup-outputs', 'Include unchanged ignored files created by approved setup in the preview')
  .action(async (id, opts) => withStore(async store => output(opts.applyHash ? await cleanup(store, id, opts.applyHash, undefined, !!opts.setupOutputs) : await cleanupPlan(store, id, undefined, !!opts.setupOutputs))));
program.command('install-skills').requiredOption('--client <name>', 'codex or claude-code')
  .option('--target <directory>', 'Override client skill directory').option('--apply-hash <hash>', 'Apply the reviewed skill installation')
  .action(opts => {
    const provider = Assignment.parse({provider: opts.client, model: 'installation'}).provider;
    const target = opts.target || join(homedir(), provider === 'codex' ? '.agents' : '.claude', 'skills');
    output(installSkills(target, opts.applyHash));
  });
program.command('uninstall-skills').requiredOption('--target <directory>', 'Previously used install destination').option('--apply-hash <hash>')
  .action(opts => output(uninstallSkills(opts.target, opts.applyHash)));
program.command('configure').requiredOption('--file <json>', 'Local SMTP/remote settings; passwords use environment variable names')
  .option('--apply-hash <hash>').action(async opts => withStore(store => {
    const value = LocalSettings.parse(read(opts.file)), path = join(store.home, 'settings.json'), proposal = configProposal(path, value);
    if (opts.applyHash) {
      if (opts.applyHash !== proposal.hash) throw new Error('Settings proposal changed since review');
      if (proposal.before) writeFileSync(path + '.backup-' + Date.now(), proposal.before, {mode: 0o600});
      writeFileSync(path, proposal.after, {mode: 0o600});
    }
    output({...proposal, applied: !!opts.applyHash});
  }));
program.command('mail-test').description('Verify the configured SMTP connection').action(async () => withStore(async store => {
  const config = settings(store).smtp; if (!config) throw new Error('SMTP is not configured');
  output({verified: await mailTransport(config).verify()});
}));
program.command('notify').action(async () => withStore(async store => output(await flushNotifications(store))));
program.command('mcp-config').requiredOption('--path <file>', 'Native Codex TOML or Claude JSON configuration')
  .requiredOption('--file <json>', 'Reviewed client/name/server/requiredTools and optional testCall')
  .option('--apply-hash <hash>')
  .action(async opts => {
    const value = JSON.parse(readFileSync(resolve(opts.file), 'utf8'));
    output(opts.applyHash ? await applyMcp(opts.path, value, opts.applyHash, cwd()) : mcpProposal(opts.path, value));
  });
program.command('inspect-compose').requiredOption('--file <yaml>').requiredOption('--feature <id>')
  .action(async opts => output(await inspectCompose(resolve(opts.file), opts.feature, cwd())));
program.command('_worker <id>', {hidden: true}).action(async id => withStore(store => worker(store, id)));

program.parseAsync().catch(error => {process.stderr.write(redact(message(error)) + '\n'); process.exitCode = 1;});
