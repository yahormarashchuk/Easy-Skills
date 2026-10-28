# Implementation and acceptance status

This is an alpha implementation of the supplied [product specification](product-spec.md).
Do not equate a built package or simulated acceptance run with release readiness.

Current working version: **0.1.0-alpha.2**, project/plan contract v2, SQLite schema v3.
See the [finding ledger, migration notes and current validation](reliability-implementation.md).
Real Claude launches are refused when managed policy configures hooks, plugins, a
policy helper or MCP servers. Codex supports verified empty MCP grants; named grants are unsupported.
The table below describes the earlier alpha foundation; current limits in the ledger
take precedence. No new live-provider or GitHub mutation acceptance is claimed.

| Area | Implemented | Outstanding validation or scope |
| --- | --- | --- |
| Contracts/provenance | Strict project, model, plan, stage-result and run schemas; dependency validation; pinned source revisions and licenses | Schema v1 to v2 backup/migration and preserved-plan tests; future schema migrations need explicit coverage |
| Clients | Codex output-schema/final file; Claude json-schema/structured_output; exact sessions, path/version compatibility and fresh auth checks | Earlier real probes cover the original adapter; revised flags/MCP paths and full autonomous workflows need fresh opt-in validation |
| Distribution | Compiled npm tarball, bootstrap diagnostics, preview/apply installation, backups and conservative uninstall | Registry publication and clean-machine installer acceptance |
| State/runner | SQLite WAL, event log, optimistic updates, process/run/resource locks, detached worker, live-child recovery guard | Full power-loss/orphan-process reconciliation across Windows reboots; automatic startup is intentionally absent |
| Onboarding/rules | Read-only inventory, structured versioned rules agreement, unresolved decision procedure, six behavioral eval cases, 13 packaged skills | Interview quality remains model-dependent; eval cases are provided but not run against a live model |
| Feature/model routing | Terminal interviews, numbered current-client model catalog, saved exact six-stage profiles, readable rule/task confirmations, hash-bound plans, autonomous BUILD onward; advanced feature commands retained | Live interview quality and large-project latency acceptance; advanced mode is selected explicitly |
| GitHub/worktrees | Direct existing-Issue or local task mode with one branch/PR; manual delivery without merge-policy access; advanced dependencies and merge gates retained | Real GitHub mutation/branch-protection acceptance; GitHub MCP transport not implemented |
| Evidence/review | Baseline capture, cleaned failure bundles, scoped/delta context manifests, exact-head evidence and repairs bounded across commits | Real acceptance with production repositories and independent human reviewers |
| Sync | Recovery refs, merge, conflict session using BUILD, revalidation, manual sync, preserved ambiguous merge | Broader semantic-conflict corpus and crash fault injection |
| Notifications/remote | Outbox claims/leases/backoff, durable remote operation states, operation-bound merge intent, replay and crash reconciliation | Real SMTP/mobile decision acceptance |
| Environments/MCP | Shared resource locks, Compose inspection, native Codex TOML/Claude JSON MCP setup, protocol/tool checks and VERIFY tool filtering | Managed database/schema/port provisioning and data lifecycle cleanup; managed/plugin client configurations need live validation |
| Cleanup | Actual merged PR/head/base checks, live executor/ownership/dirty guards, exact proposal hash; no force | Branches retained; database/volume deletion deliberately unimplemented |
| Updates/release | Version pins, backups, documented manual rollback; CI definitions for Windows/Linux; GitHub prerelease packaging | Automated updater/rollback manager; complete v1 acceptance still pending |

The guided redesign adds bounded discovery, rule evidence/provenance, persisted interview
answers, recoverable knowledge saves, project-context snapshots, explicit scripted
consent, same-PR feedback approval history and latest-task status/resume. See
[guided workflow and remaining limits](guided-workflow.md). No new live acceptance is
implied by these additions. Claude continues to fail closed.

Local tests use temporary Git repositories, real Git merges and deterministic CLI
fixtures. Node and Python sample checks exercise different project layouts without
embedding either framework in onboarding. Real Codex compatibility is recorded
separately in [the provider matrix](provider-compatibility/README.md).

Windows command execution accepts argument arrays and supports .cmd launchers with
ordinary arguments and spaced paths. Batch scripts reparse arguments: ambiguous shell
metacharacters are rejected rather than executed. Use a native executable, or
`node path/to/script.js`, when a check needs literal quotes, percent signs or shell
operators in its arguments. No arbitrary Issue text becomes a shell command.

Cleanup rejects unknown ignored files to avoid deleting private data hidden by
.gitignore. The optional `--setup-outputs` proposal includes only unchanged ignored
files inventoried as outputs of the approved setup, under its exact apply hash.

The v1 release gate remains the supplied full scenario: clean Windows installation,
two real provider/model assignments across parallel features, terminal closure, quota
recovery, base-branch movement/conflicts, mobile/email decision, evidence-backed PRs,
final human merge and safe cleanup on at least two technology stacks. This alpha
does not claim that gate passed.

Historical validation of the original alpha on 2026-10-21 included 23 local Windows
fixture tests, package installation and two-turn real launch/resume probes for Codex
CLI 0.163.0 (`gpt-6.1-sol`) and Claude Code 2.1.306 (`claude-sonnet-5-5`). Those probes
do not establish compatibility of the revised structured-output/MCP implementation.
Current local verification and remaining limits are recorded in
[the implementation ledger](reliability-implementation.md).

Hosted CI was rechecked read-only on 2026-10-22. Both `test (windows-latest, 24)` and
`test (ubuntu-latest, 24)` passed at release commit
`fda65ecaeed91b6d7c441345fdf5f1b743175c5c` in
[run 39625039980](https://github.com/yahormarashchuk/Easy-Skills/actions/runs/39625039980).
The old unregistered-workflow/404 condition is resolved. Baseline `0899a37` was pushed
before this implementation. The current alpha.2 edits are local and no hosted CI result
for these edits has been checked.
