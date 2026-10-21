---
name: easy-ship
description: Verify delivery readiness for per-Issue and final feature Pull Requests in Easy Skills.
---

Read [the workflow contract](references/workflow.md). Check that required evidence and
review refer to the current commit, acceptance is satisfied, and PR scope is clear.
The runner creates each intermediate PR, explicitly closes its Issue with evidence,
and merges only when authorized. Dependency completion waits for confirmed integration.

Keep the parent Issue open until the final merge. Final readiness requires sync with
the current main branch, whole-feature checks and final review. Describe the concrete
behavior and evidence in the PR. Main-branch merge needs its own explicit head-bound
decision. Do not perform GitHub mutations from a stage agent session.
