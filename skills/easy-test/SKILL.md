---
name: easy-test
description: Validate a task or whole feature against approved acceptance criteria and deterministic evidence.
---

Read [the workflow contract](references/workflow.md). Inspect the actual diff, required
checks and their runner-recorded exit codes at the current commit. Map evidence to
acceptance criteria and investigate uncovered behavior or regressions.

Tests that cannot run remain incomplete. Report missing tools, data, configuration or
requirements explicitly. Return failed for a repairable defect and blocked for a
decision/environment gap. Do not alter the implementation in a VERIFY session; BUILD
repairs it and the runner repeats verification. Whole-feature validation also covers
interaction between all tasks and the end-to-end user scenario.
