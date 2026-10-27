# GitHub merge policy

An approved plan includes `project.mergePolicy.mode` (`strict` or `queue`) and
`requiredChecks`, each with a check name and optional trusted GitHub App ID. Missing
policy in an older plan is a diagnostic stop, not implicit permission.

Before requesting merge the runner reads the actual PR head/base, applicable active
rules and classic protection. It verifies agreed checks are server-required. Pending
checks wait, failed checks stop, and missing checks stop with their names. Check
discovery refuses incomplete results beyond its supported 100-item limits.

Strict mode needs server-enforced branch freshness: strict required checks with
administrator enforcement in classic protection, or an active strict ruleset. Queue
mode requires an effective merge-queue rule. These conditions are required on every
target branch, including the feature integration branch. An unavailable protection
API or unknown policy stops automatic merge. Repository settings are never changed.

The asynchronous REST request pins the approved head, selects direct merge or queue,
and explicitly sends `bypass_rules: false`. Server rules decide the merge after the
local checks; a local repository lock does not protect against other GitHub users.
An administrator can still change repository policy externally; the runner cannot
make protection configuration immutable.

Intent is saved before HTTP. Pending UUIDs and enqueued states are persisted. An
existing request after a lost response is accepted only when its head, merge action
and non-bypass option match. A 202 response, `pending` or `enqueued` is not completion.
Dependencies/final state advance only after an actual merged PR with the reviewed
head. Lost completed responses reconcile through the PR's state. An expired async
request or removed queue entry needs investigation; the runner does not invent
completion or silently change policy.

Final authorization is separately bound to run, plan and head. A remotely accepted
single-use code is retained as operation-specific intent after transient failures.
It cannot authorize another comment, plan or revision. Without an in-flight request,
ready monitoring invalidates current readiness when source/target moves and repeats
sync/review before another final confirmation. During an in-flight request, movement
instead stops new sync/submission and preserves its original head and evidence while
monitoring the actual outcome. Historical merge recording works even after rules change.
After submitting a queue request, GitHub owns its scheduling: inspect
and remove an obsolete queue entry in GitHub before changing its authorization scope.

Async observation and queue membership checks are read operations. A failed/expired
request or a removed queue entry needs a fresh reviewed `retry-merge` proposal; an
ambiguous submission without a known request ID needs external reconciliation first.
The runner does not make another PUT just to discover whether an earlier PUT happened.

Official sources checked 2026-10-21:

- [REST pull request merging and async results](https://docs.github.com/en/rest/pulls/pulls)
- [Strict checks and branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Active rules for a branch](https://docs.github.com/en/rest/repos/rules)
- [Merge queues and merge-group CI](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
