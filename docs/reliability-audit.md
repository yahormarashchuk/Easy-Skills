# Autonomous alpha reliability audit

Date: 2026-10-22. Base: `fda65ecaeed91b6d7c441345fdf5f1b743175c5c`.
Work branch: `codex/reliable-autonomous-alpha`. The checkout was clean when work
started. Changes remain local and unreleased; no real repository mutations, email
delivery or package publication were authorized for this task.

## Confirmed problems and changes

| Requirement | Confirmed problem | Implemented behavior and regression evidence |
| --- | --- | --- |
| Repair limits | A different HEAD reset identical failure counts | Scoped normalized failure ledger separates issue identity, observed revisions and independently confirmed progress. Task/final regressions create different commits and stop at three unresolved failures. Different failing tests remain different issues; timestamps/PIDs/temp paths/timings are normalized. |
| Quota recovery | Probes expired after 24 hours and completed DEFINE/PLAN were required | Compatibility records bind assignment/path/version. Recovery checks required stages and current official authentication; unchanged compatibility survives a 48-hour fixture wait and resumes the same session/model. Changed executable/version and expired auth stop. Unknown resets use capped backoff. |
| Remote commands | Reading a comment marked it handled; consuming a code lost intent after failure | Persisted operation states, immutable comment binding, atomic local effects/completion, network reconciliation and operation-bound accepted merge codes. Retry, replay, crash-state and rejected-author/plan/head tests exercise recovery without SQL transactions across HTTP. |
| Outbox | Workers could send the same pending row; one failure stopped the batch | Atomic claims, expiry, retry times and per-item failure isolation. Concurrent workers, stale claims and SMTP-success-before-database-ack tests pass. A stable Message-ID does not promise exactly-once delivery. |
| Ready lifecycle | Start/resume rejected ready; monitoring ignored main changes | Ready monitoring can restart without BUILD. Run locking/live-child checks protect safe points. Main movement revokes readiness, routes through existing sync/checks/review and invalidates old head confirmation. |
| Merge gate | Expected head alone did not constrain the target base or require agreed CI | Agreed checks and actual PR head/base, effective rules/classic protection, server freshness and explicit non-bypass async requests. Pending/failed/missing checks, base races, queue states, existing async requests and lost merged responses are tested. Dependencies require an actually merged reviewed head. |
| Failure information | Agents got a generic failure and inaccessible private log reference | Cleaned bounded bundles include command, exit code, test hints, stdout/stderr, attempt count and expected repair. Private paths, including Windows case/slash/escaped forms, credentials and unrelated session histories are excluded. |
| Context | Every call loaded all layers and task histories | Task areas/paths select relevant layer rules. Mandatory global rules remain present; dependencies are summarized. Review gets its own scope/diff. Exact-session continuation supports changed optional sections. Manifests record section hashes/sizes and explicitly approximate token estimates. Unscoped legacy tasks conservatively retain rules. |
| Adapters | Intermediate Codex messages could be mistaken for results; structured-output flags were absent | Small compatible schemas; Codex final file plus completed turn; Claude structured_output; runtime Plan/result validation; explicit session/model checks and error kinds. Synthetic launch/resume event formats and injected executors cover the protocol. |
| Baseline/VERIFY | No initial baseline; Claude VERIFY could not run approved diagnostics/browser tools | Baseline commands/head/results are persisted separately; existing failures and unavailable checks stop implementation. VERIFY has approved diagnostics/browser capabilities without built-in editing. Native Codex tool allow lists and Claude's per-assignment MCP filter constrain browser tools. |
| Onboarding | Generated interview drafts could be approved as rules | Structured status/version, resolved decisions/conflicts/assumptions/completion criteria and rules/config hashes bind agreement to the plan. Compact skills link a shared interview procedure and six behavioral evaluation cases. |
| Installation/MCP/docs | JSON-only settings and arbitrary code-zero probes overclaimed MCP readiness; CI status was stale | Bootstrap wraps existing installation with diagnostics and review hashes. Native TOML/JSON preserves unrelated settings with backup/rollback and actual MCP initialization/tool verification. README separates product installation, setup, first feature, recovery and development. Hosted CI facts were refreshed. |

Additional regressions found during implementation: an unreviewed manually merged PR
could satisfy a dependency; simultaneous database openers could apply the same migration
twice; a source-mode MCP proxy inherited incompatible Node test flags. These now have
focused regression coverage. Reattaching to ready also avoids leaving a deferred resume
request that could undo a later pause. Schema v1 migration makes a backup and preserves old run
JSON/plan hashes. Unsupported legacy approval/baseline gaps produce explicit migration
guidance rather than silent new permissions.

## Existing safeguards preserved

The audited commit already had optimistic SQLite revisions, PID/run/repository/resource
locks, official authentication, exact model/session routing, short quota recovery,
revision-bound evidence, separate final merge authorization, owned worktrees, clean
guards including ignored files, backup/preview hashes and conservative uninstall.
PR-create response-loss reconciliation and blocked conflict recovery also existed.
Their tests remain; these were not reimplemented as new features. Child Issue closure
after implementation/checks/review and PR publication remains unchanged.

## Validation and limits

Automated checks use temporary repositories and injected clients/GitHub/SMTP. Actual
Git operations, SQLite recovery, subprocess handling and MCP fixture servers run locally.
Package acceptance loads the installed compiled Engine/Store/protocol, completes a
fixture feature through final merge and installs packaged skills/references. This is
not real-client E2E.

Two early adapter regressions accidentally reached installed CLIs because the old
constructor ignored an attempted test injection. Both failed before a valid model
result. This was reported during work. The constructor now accepts an explicit
executor, and `check` type-checks tests/scripts before execution. No successful new
live-client compatibility probe is claimed.

All 13 skills passed the Skill Creator validator. Both opt-in scripts were executed
with their authorization environment disabled and stopped before external actions.
The six interview behavior cases are prepared with rubrics but have not been executed
against a real model. Current structured flags/MCP controls, account-specific models,
production protection/queue behavior, SMTP inbox delivery, physical power loss/reboots
and full multi-client feature acceptance still need explicitly authorized live tests.

GitHub Actions was inspected read-only: Windows and Ubuntu Node 24 jobs passed at the
base release commit in [run 39625039980](https://github.com/yahormarashchuk/Easy-Skills/actions/runs/39625039980).
The former registration/404 delay is resolved. No hosted CI result exists for this
unpublished branch. No repository protection setting was changed.

See [validation commands and opt-in scenarios](validation.md), [merge policy limits](merge-gate.md)
and [MCP configuration limits](mcp.md). Queue scheduling belongs to GitHub once accepted;
obsolete entries require GitHub-side inspection/removal before changing authorization
scope. The runner stops on unavailable guarantees or incomplete protection/check
discovery rather than bypassing them. This remains an alpha, not v1 readiness.

## Reproduce the user workflow

Install the current compiled tarball. Run `bootstrap --client codex` and/or
`--client claude-code`; review/apply each proposal. Complete easy-init and a structured
`agree-rules` revision. Configure actual GitHub checks/protection and optionally verify
MCP/SMTP with separate permission. Approve exact client launch/resume probes. Generate
and review a feature plan with task scopes, exact assignments, agreement binding,
checks, merge policy and permissions, then draft/approve its exact hash and start it.

Close the launching terminal; inspect status/events or scoped GitHub commands. After
reboot, run start again even for ready state. Main movement requires sync and fresh
evidence/review. Authorize the resulting final head separately. After actual merge,
preview cleanup and apply its exact hash. Legacy runs remain saved: keep their pinned
package/backups and prepare a replacement plan when new agreement/policy/baseline
requirements cannot be established. No automatic approval migration is performed.

## Commands actually executed

- `npm test`: final full run passed all 62 tests, with zero failures/skips (162.8 seconds on this Windows host). Regression tests were first exercised as failing cases before their fixes.
- `npm run check`: passed for production code, tests and scripts.
- `npm run build`: passed; regenerated runtime declarations and JSON schemas and packaged skill references.
- `npm pack` (including its prepack build), and subsequent `npm pack --ignore-scripts --json --pack-destination artifacts` after explicit builds: passed.
- `npm install --prefix CLEAN_DIRECTORY TARBALL --ignore-scripts --no-audit --no-fund`: passed in fresh directories.
- `node --import tsx scripts/package-acceptance.ts INSTALLED_PACKAGE`: passed; the installed compiled Engine/Store completed a fixture feature through final merge, ready reattachment retained no execution request, packaged skill references installed, and the compiled structured-output path passed with an injected executor.
- Skill Creator `quick_validate.py`: all 13 skills passed.
- `git diff --check`: passed.
- Client/external smoke scripts with authorization disabled: exited with the expected opt-in rejection, before external actions.
- Read-only `gh run list` / `gh run view`: confirmed successful Windows and Linux jobs for the release commit, not this unpublished branch.

## Changed files

- `.github/workflows/ci.yml`
- `README.md`
- `docs/architecture/runner.md`
- `docs/implementation-status.md`
- `docs/installation/README.md`
- `docs/mcp.md`
- `docs/merge-gate.md`
- `docs/provider-compatibility/README.md`
- `docs/releases/v0.1.0-alpha.1.md`
- `docs/reliability-audit.md`
- `docs/remote-control.md`
- `docs/validation.md`
- `package-lock.json`
- `package.json`
- `schemas/plan.schema.json`
- `schemas/project.schema.json`
- `schemas/run.schema.json`
- `schemas/stage-result.schema.json`
- `scripts/package-acceptance.ts`
- `scripts/smoke-clients.ts`
- `scripts/smoke-external.ts`
- `skills/_shared/interview-evals.json`
- `skills/_shared/interview.md`
- `skills/easy-feature/SKILL.md`
- `skills/easy-init/SKILL.md`
- `skills/easy-mcp/SKILL.md`
- `src/adapters/index.ts`
- `src/adapters/mcp-permissions.ts`
- `src/adapters/protocol.ts`
- `src/cli/bootstrap.ts`
- `src/cli/index.ts`
- `src/cli/project.ts`
- `src/contracts.ts`
- `src/github/index.ts`
- `src/integrations/config.ts`
- `src/integrations/mcp-proxy.ts`
- `src/integrations/mcp.ts`
- `src/notifications/index.ts`
- `src/persistence/store.ts`
- `src/runner/check-failure.ts`
- `src/runner/compatibility.ts`
- `src/runner/context.ts`
- `src/runner/engine.ts`
- `src/runner/failures.ts`
- `src/runner/onboarding.ts`
- `src/runner/planning.ts`
- `src/runner/remote.ts`
- `src/runner/worker.ts`
- `src/skills.ts`
- `templates/feature.yaml`
- `templates/project.yaml`
- `tests/end-to-end/workflow.test.ts`
- `tests/fixtures/README.md`
- `tests/fixtures/client-events.json`
- `tests/helpers.ts`
- `tests/integration/adapter-protocol.test.ts`
- `tests/integration/bootstrap.test.ts`
- `tests/integration/cli.test.ts`
- `tests/integration/context-baseline.test.ts`
- `tests/integration/mcp-permissions.test.ts`
- `tests/integration/mcp.test.ts`
- `tests/integration/merge-gate.test.ts`
- `tests/integration/onboarding.test.ts`
- `tests/integration/planning.test.ts`
- `tests/integration/process.test.ts`
- `tests/integration/sync.test.ts`
- `tests/recovery/compatibility.test.ts`
- `tests/recovery/external-operations.test.ts`
- `tests/recovery/migration.test.ts`
- `tests/recovery/outbox.test.ts`
- `tests/recovery/ready.test.ts`
- `tests/recovery/remote-durable.test.ts`
- `tests/recovery/workflow.test.ts`
- `tests/unit/contracts.test.ts`
- `tests/unit/failures.test.ts`
- `tsconfig.tests.json`
