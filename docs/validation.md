# Validation scenarios

Public CI and `npm test` use local repositories, protocol fixtures and injected
GitHub/SMTP/CLI executors. They require no authenticated sessions. Run `npm run check`
before tests: it checks test/script types as well as production sources.

## Deterministic suite

Run `npm run check`, `npm test`, `npm run build`, then `npm pack`. Install the actual
tarball into a fresh directory with `npm install --prefix CLEAN_DIR TARBALL` and invoke
`CLEAN_DIR/node_modules/easy-skills/dist/cli/index.js`. Check help, schema parsing,
skill preview/install/uninstall and an injected local workflow from that installed
package. A source-tree pass alone does not validate package resources.
From the source checkout, `node --import tsx scripts/package-acceptance.ts
CLEAN_DIR/node_modules/easy-skills` performs that injected compiled-package scenario,
including reattaching to a ready feature without leaving a deferred execution request.

Recovery coverage includes changing-commit repair loops, quota waits beyond 24 hours,
exact-session resume, authentication/client identity changes, remote operation replay,
single-use intent binding, concurrent outbox claims, lost delivery acknowledgements,
ready worker restart, base changes, stale final confirmation, pending/failed/missing
checks, queued merges, lost PR/merge responses, old database migration and baseline
failure classification. Fault injection exercises persisted crash states; it is not
a physical power-loss or Windows reboot test.

`tests/fixtures/client-events.json` contains representative official event formats
with synthetic identifiers/content for launch/resume. They are not recordings of
a successful live feature with the revised adapter. Real protocol flags still need
fresh compatibility probes in the target installation.

## Interview behavior

The shared cases in `skills/_shared/interview-evals.json` cover forbidden dependencies,
conflicting rules, stale maps, incomplete UI requirements, ambiguous synchronization
and unavailable checks. Their expected observations and failure criteria are the
rubric. In an isolated temporary repository, materialize each case's files and ask
the selected client to handle its request using the installed skill. Save the actual
answer, inspected paths, decisions, unresolved questions and proposed actions.

Evaluate decisions against the rubric, not matching phrases. A model that merely
repeats the skill has not demonstrated correct behavior. These model-based cases
have not been executed for this change: doing so requires permission for real client
requests. Deterministic agreement-gate tests do not substitute for those evaluations.

## Explicitly opt-in real checks

Obtain permission for the exact client/model and two small account requests:

```powershell
$env:EASY_SKILLS_ALLOW_CLIENT_PROBES = '1'
npm run smoke:clients -- codex EXACT_MODEL_ID
# Or: npm run smoke:clients -- claude-code EXACT_MODEL_ID
```

For disposable GitHub Issue create/close or a real email, obtain separate permission
for the named repository or configured recipient:

```powershell
$env:EASY_SKILLS_ALLOW_EXTERNAL = '1'
npm run smoke:external -- --allow-external --github OWNER/DISPOSABLE_REPOSITORY
npm run smoke:external -- --allow-external --smtp
```

These smoke checks do not establish end-to-end feature behavior, protected merges or
inbox delivery. A full acceptance run additionally needs two real clients, approved
checks/protection, parallel features, terminal closure, quota recovery, main movement,
an ambiguous conflict, remote/email control, actual intermediate/final PR merging and
cleanup on two project stacks. Do not declare v1 readiness from fixture results.

Neither opt-in script is run by public CI. Never add official client credentials,
private sessions or SMTP passwords to fixtures or artifacts.
