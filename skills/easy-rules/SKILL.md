---
name: easy-rules
description: Propose and reconcile changes to established Easy Skills project rules.
---

Read [the workflow contract](references/workflow.md). Read current rules, instructions
and affected feature plans. Explain the exact rule diff and its consequences for active
tasks. Preserve existing project conventions and record the decision rationale.

Apply only the reviewed change. Recompute `easy-skills rules-hash`. Active plans pin
their old hash and pause when rules change; they need a newly reviewed plan. Do not
silently edit their approved hashes or weaken a critical rule to let a task proceed.

For project configuration changes, use the preview/apply `project-config --file FILE`
command, then renew the structured rules agreement. A legitimate protected-file edit
requires a newly reviewed plan from the maintainer-selected base. Preserve the old
run and its evidence; abandon it explicitly if a replacement feature is needed.
