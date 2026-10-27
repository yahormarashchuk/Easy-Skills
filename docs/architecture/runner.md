# Runner contracts

The model supplies engineering judgment; the runner supplies process execution, Git,
GitHub, SQLite, resource locks, check evidence and waiting. No server or model API
key is required. Official CLI authentication is used as published by each vendor.

`src/contracts.ts` is the source of the versioned project, assignment, plan and stage
result contracts. `npm run build` exports JSON schemas. Plans bind the project rules
hash, package versions, explicit model assignments, dependency DAG, checks and publish/
intermediate merge permissions. Approval is a separate command with the exact plan hash.
DEFINE happens interactively through the skills. `feature plan` invokes the selected
PLAN CLI/model read-only and writes an unapproved draft; the worker starts at BUILD.

Each SQLite update uses an optimistic revision check and appends its event in one
transaction. WAL and busy timeouts permit different feature workers to share one
database. A process-owned run lock prevents concurrent execution of one feature;
resource locks serialize incompatible checks against shared environments. Repository
locks serialize fetch, push and worktree management across feature workers; Git's
own ref guards remain in effect. Dead process
locks can be replaced. A live recorded child blocks crash recovery even when its worker
has died. OS birth identity distinguishes proven PID reuse; unknown live identity stays
conservative and requires human reconciliation.

States: draft → approved → running → ready → merged. Side exits are waiting_quota,
waiting_external, waiting_resource, needs_decision, paused, stopped and abandoned.
Cursor: BUILD → VERIFY → REVIEW → SHIP → INTEGRATE, with persisted REPAIR intents.
The next task is selected only after dependency PRs are confirmed merged. Final work
uses SYNC → VERIFY → REVIEW → SHIP. Main merge is separately authorized at an exact
reviewed commit. Remote commands cannot approve drafts or change model assignments.

The worker runs detached using a private log. It polls outbound GitHub requests, and
checks pause/stop at safe checkpoints. CLI children receive prompts on stdin, arguments
as arrays, a bounded stream decoder, timeout and process-tree termination. Session IDs
are checkpointed as soon as emitted. Each stage uses its own session, and resumes only
that session. Authentication and model errors stop without provider fallback.

Required check evidence contains command ID, commit, exit code, timestamp and private
log path. A check or read/review stage that changes the checked tree invalidates readiness.
Unavailable checks stop for prerequisites. Repeated normalized failures count across
different commits in a scoped failure ledger. Observed revisions are recorded separately;
independent stage success clears the corresponding unresolved failure scope.
Quota/network waits use capped exponential backoff and do not count as
repair attempts. Agent summaries never establish passing deterministic checks.

External operations use stable run-specific markers. Recovery searches existing
Issues/PRs before creating replacements. Worktree creation records ownership intent
before acting. Merge recovery consults the PR's actual merged state. The runner does
not force-push or force-remove worktrees. It retains branches after cleanup, including
squash-merged branches. External systems cannot be included in a SQLite transaction;
reconciliation and conservative stops are therefore required, not exactly-once claims.

The state home defaults to `%LOCALAPPDATA%/EasySkills` on Windows and
`~/.local/share/EasySkills` elsewhere. `EASY_SKILLS_HOME` overrides it, but it must be
outside the managed repository. It holds runner.db, logs/, worktrees/ and settings.json.
Repository context remains under .easy-skills/. Credentials are never read from official
CLI stores; mail passwords are read by environment-variable name.

## Earlier reliability additions (alpha.1 baseline)

Database schema v2 migrates notification leases/retry times, operation-bound decisions
and probe executable identities in one transaction, with a pre-migration database
backup. Existing run JSON and approved plan hashes remain unchanged. Plans without
explicit rules agreement and merge policy receive a migration diagnostic; new
permissions are never inferred from legacy approval.

Structured onboarding records contain version, agreement status, resolved decisions,
conflicts, assumptions, completion criteria and rules/configuration hashes. PLAN and
execution check that agreement; Markdown wording is not an approval signal.

Before first BUILD, the runner records original head, check commands and baseline
results. Pre-existing failures and unavailable checks stop for a decision. Older
already-started runs without a captured baseline stop explicitly rather than calling
implemented code an original baseline. Feature evidence always requires passing
checks at the actual reviewed head.

Repair prompts receive bounded, cleaned failure bundles: command/check ID, exit code,
test-name hints, stdout/stderr excerpts, prior attempt count and expected repair.
Task scope chooses matching layer rules; global constraints stay mandatory. Unscoped
legacy tasks conservatively retain all layer rules. Dependency summaries exclude
private paths and sessions. Each invocation records a section/size/hash manifest;
token estimates are approximations, not usage. Exact-session continuation can send
only changed optional sections plus mandatory core/current observations.

Clients use small structured-output schemas and runtime validation. Planning transports
the complex Plan as JSON text for separate validation. Codex consumes its final-output
file after turn completion; Claude consumes structured_output. Read-only VERIFY has
separate approved diagnostic/browser capabilities, with no built-in edit tools.

Remote commands persist received, validated, executing, succeeded, transient_failed
and rejected states. Local effects and their completion marker commit together.
Network effects reconcile outside SQL transactions. Accepted one-time merge codes
are bound to stable operation/run/plan/head identity through retries and crashes.

Notification workers atomically claim pending rows with expiry and retryAt. A failure
does not block other rows. Stable Message-ID is not an exactly-once SMTP guarantee:
a process dying after delivery but before acknowledgement can cause redelivery.

Ready workers can restart without repeating implementation. Monitoring obtains the
run lock, refuses to edit alongside a live child, and revokes readiness after base
movement before automatic sync/reverification. GitHub async merge intents remain
pending until actual merged state, never merely accepted/enqueued. See
[merge gate](../merge-gate.md), [MCP](../mcp.md) and [validation](../validation.md).

## Reliability contract v2 / database v3 (alpha.2, unreleased)

See [the implementation ledger and migration record](../reliability-implementation.md).
New plan approvals bind setup, protected verification controls and completed repair
limits. Existing approved JSON/hashes are preserved; legacy execution stops for
replacement approval. SQLite migration adds OS birth identity with a backup and
transactional version recheck. Unknown live identities stay conservative.

Trusted tool paths and role environments cover Git, gh, official clients, checks,
MCP transports and termination. Effective origin fetch/push URLs are checked before
external Git operations. Test remotes require explicit fixture injection. Known secrets
are redacted at public boundaries; this cannot prove the absence of every secret.

Guards check the actual owned worktree before/after mutation, before verification and
commit/push. Protected file changes stop for a replacement approval. Review supplies
complete bounded file diffs and persists head/base/file coverage. Binary/oversized
inputs require a decision. The runner resends current context instead of relying on
optional-session delta placeholders.

Only typed code/check failures enter repair. The repair ID, failed stage, head, reasons,
bundle and session precede corrective BUILD. Validated BUILD plus a successful runner
commit completes an ID once; waits do not count. Commit intents recover commit-before-save
interruptions. Refusals/blocked repairs stop for a decision.

One network scheduler persists its deadline. Merge submission, async request, actual
queue membership and PR outcome are distinct. Terminal/ambiguous requests never cause
blind resubmission. Historical merged outcomes use saved authorization/evidence;
new operations require current rules and exact revision approval.

Real Claude execution is refused pending enforceable managed-hook isolation. Codex
launches verify effective empty MCP grants and disabled hooks/apps. These controls
do not establish absolute host isolation. Fresh real-provider acceptance is outstanding.
