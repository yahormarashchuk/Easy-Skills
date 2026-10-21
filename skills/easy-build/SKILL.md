---
name: easy-build
description: Implement the current approved Easy Skills task with focused tests and recoverable changes.
---

Read [the workflow contract](references/workflow.md). Verify task, acceptance criteria,
dependencies, rules and assigned worktree. Inspect current neighboring code.

Use one test-driven cycle: express the missing behavior in a meaningful failing test,
confirm the failure, implement the smallest correct change, rerun and refactor. For
changes with no useful automated test, explain the suitable verification instead of
writing a test that repeats implementation details. Follow project-specific discipline.

For failures reproduce, isolate the cause, test the repair and report remaining gaps.
Preserve unrelated changes. Do not edit rules, check commands, permissions or runner
state. Runner-owned commits, GitHub operations, and notifications stay with the runner.
Return passed, blocked or failed with concrete results; do not claim missing evidence.
