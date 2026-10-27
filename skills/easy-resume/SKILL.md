---
name: easy-resume
description: Diagnose and recover an Easy Skills run after interruption, quota wait or a user decision.
---

The terminal commands `easy-skills status` and `easy-skills resume` select the latest
active task. An Issue number can select a direct task. Use `status --json` only when
full persisted diagnostics are needed. Ready direct tasks accept reviewed feedback
through `easy-skills revise ISSUE_NUMBER "feedback"`; this creates a new approval
revision while preserving the original Issue, branch and PR.

Read [the workflow contract](references/workflow.md). Inspect `easy-skills status <run>`
and `events <run>`, actual process liveness, Git state and existing GitHub objects.
Keep the pinned plan/rules/package and assigned model unchanged. Resume the exact
recorded client session; never use continue-last when features run concurrently.

Do not create a replacement executor while a recorded child is alive. After a merge
conflict interruption inspect the stored recovery refs and merge metadata; resolve
ambiguity with the user. Never clear state to conceal an incomplete check or conflict.

Use `easy-skills resume <run>` after resolving the recorded cause. Quota/network waits
retry with backoff; they do not consume repair attempts. A login failure needs the
user's official CLI login. No token extraction, account sharing or provider substitution.
