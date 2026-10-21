---
name: easy-sync
description: Check branch compatibility and resolve merge conflicts while preserving both changes and revalidating behavior.
---

Read [the workflow contract](references/workflow.md). Identify source and target
commits, owned worktree, current executor and clean starting state. Use a safe checkpoint;
do not interrupt another agent's edits. The runner records a recovery ref before merging.

Study both sides, the specification, Issues and affected contracts. Merge published
branches without rewriting their history. Resolve code by intended behavior; never
blanket-select ours/theirs, delete tests for green status, or use reset --hard as repair.
When acting as the conflict agent, edit and stage resolved files; the runner commits.
If a choice is ambiguous, return blocked and preserve the merge state for a decision.

Run checks for changed and neighboring behavior, including semantic compatibility
when Git reports no textual conflict. Review the resolution independently using the
REVIEW assignment. All evidence and readiness for an older commit become stale.
`easy-skills sync <run>` performs manual integration sync; resume validation afterward.
