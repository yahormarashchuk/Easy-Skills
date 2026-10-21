---
name: easy-cleanup
description: Remove only reviewed, owned temporary worktrees after a confirmed final feature merge.
---

Read [the workflow contract](references/workflow.md). Run `easy-skills cleanup <run>`
to inspect the plan. It checks the actual GitHub merge, feature revision, branch target,
no live executor, recorded ownership and all uncommitted/untracked files.

Show the exact resource list. Apply only the reviewed hash using --apply-hash. Stop
if ownership, dirtiness or merge evidence changed. Never force-remove a worktree,
delete discussions or treat ancestry alone as proof of a squash merge. Keep logs and
result history. Current cleanup retains branches and does not delete Docker volumes
or databases; data removal requires its own reviewed procedure and permission.
