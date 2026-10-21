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
has died; PID reuse is deliberately treated conservatively, requiring human reconciliation.

States: draft → approved → running → ready → merged. Side exits are waiting_quota,
needs_decision, paused and stopped. Cursor: BUILD → VERIFY → REVIEW → SHIP → INTEGRATE.
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
Unavailable checks fail. Repeated code failures count only identical failures at the
same commit. Quota/network waits use capped exponential backoff and do not count as
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
