# Implementation and acceptance status

This is an alpha implementation of the supplied [product specification](product-spec.md).
Do not equate a built package or simulated acceptance run with release readiness.

| Area | Implemented | Outstanding validation or scope |
| --- | --- | --- |
| Contracts/provenance | Strict project, model, plan, stage-result and run schemas; dependency validation; pinned source revisions and licenses | Schema migrations beyond version 1 |
| Clients | Codex/Claude adapters, diagnostic status, exact-model probes, JSON events, explicit session resume, error classification; real Codex and Claude execution/resume probes passed | Other account-specific model configurations and full autonomous client workflows still need validation |
| Distribution | Compiled npm tarball; preview/apply installation, backups, dependency-complete skills, conservative uninstall | Registry publication and clean-machine installer acceptance |
| State/runner | SQLite WAL, event log, optimistic updates, process/run/resource locks, detached worker, live-child recovery guard | Full power-loss/orphan-process reconciliation across Windows reboots; automatic startup is intentionally absent |
| Onboarding/rules | Read-only inventory, reviewable config proposal, preserved entry instructions, 13 skills and context templates | Interview quality is model-dependent; generated rules remain drafts until agreed |
| Feature/model routing | Interactive DEFINE; read-only feature plan command routes the selected PLAN CLI/model; exact assignments in approved plans; autonomous BUILD onward | No standalone terminal interview wizard; local skill interaction is the interface |
| GitHub/worktrees | gh transport, parent/task Issues, task/final PRs, explicit Issue closure, sequential dependency execution, owned worktrees | Real GitHub mutation/branch-protection acceptance; GitHub MCP transport not implemented |
| Evidence/review | Deterministic check exit codes/head/logs; separate sessions; stale evidence blocked; bounded task repair | Real acceptance with production repositories and independent human reviewers |
| Sync | Recovery refs, merge, conflict session using BUILD, revalidation, manual sync, preserved ambiguous merge | Broader semantic-conflict corpus and crash fault injection |
| Notifications/remote | Durable SMTP outbox, no-mail reporting, scoped commands and question answers, expiring single-use exact-head merge code | Real SMTP/mobile decision acceptance |
| Environments/MCP | Shared resource locks, Compose config/risk inspection, reviewed JSON config backup/probe/rollback | Managed database/schema/port provisioning, lifecycle cleanup, non-JSON client config adapters |
| Cleanup | Actual merged PR/head/base checks, live executor/ownership/dirty guards, exact proposal hash; no force | Branches retained; database/volume deletion deliberately unimplemented |
| Updates/release | Version pins, backups, documented manual rollback; CI definitions for Windows/Linux; GitHub prerelease packaging | Automated updater/rollback manager; complete v1 acceptance still pending |

Local tests use temporary Git repositories, real Git merges and deterministic CLI
fixtures. Node and Python sample checks exercise different project layouts without
embedding either framework in onboarding. Real Codex compatibility is recorded
separately in [the provider matrix](provider-compatibility/README.md).

Windows command execution accepts argument arrays and supports .cmd launchers with
ordinary arguments and spaced paths. Batch scripts reparse arguments: ambiguous shell
metacharacters are rejected rather than executed. Use a native executable, or
`node path/to/script.js`, when a check needs literal quotes, percent signs or shell
operators in its arguments. No arbitrary Issue text becomes a shell command.

Cleanup also rejects ignored files (including generated dependency directories) to
avoid deleting untracked private data hidden by .gitignore. Handle those files explicitly
before applying a worktree cleanup plan; the alpha does not auto-classify ignored data.

The v1 release gate remains the supplied full scenario: clean Windows installation,
two real provider/model assignments across parallel features, terminal closure, quota
recovery, base-branch movement/conflicts, mobile/email decision, evidence-backed PRs,
final human merge and safe cleanup on at least two technology stacks. This alpha
does not claim that gate passed.

Local verification on 2026-10-21: 23 automated tests passed on Windows, including
parallel feature execution, exact-session quota recovery, a live orphan-child guard,
detached worker lifecycle, blocked conflict recovery with a scoped human answer,
PR-create response loss reconciliation, stale approvals and dirty cleanup. TypeScript,
package build, all 13 skill validations, and installation/diagnosis from the generated
npm tarball also passed. Real read-only launch and exact-session resume passed for
Codex CLI 0.163.0 with `gpt-6.1-sol` (ChatGPT login) and Claude Code 2.1.306 with
`claude-sonnet-5-5` (claude.ai login). Full live-provider/GitHub/SMTP acceptance remains
separate. Hosted Windows/Linux CI is unverified for the first prerelease: Actions is
enabled, but GitHub has not registered the committed workflow, and manual dispatch
returns HTTP 404. Check subsequent results in
[GitHub Actions](https://github.com/yahormarashchuk/Easy-Skills/actions).
