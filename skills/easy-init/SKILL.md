---
name: easy-init
description: Inspect an existing project and interview its owner to establish Easy Skills rules and context.
---

Read [the workflow contract](references/workflow.md). Start with `easy-skills inspect`.
Use [the interview procedure](references/interview.md) to maintain unresolved decisions,
investigate repository facts, resolve contradictions and avoid repeated questions.
Study existing instructions, manifests, tests and maintained examples without editing
application code. Existing violations do not establish approved patterns.

Ask focused rounds of questions following unresolved decisions: architecture and
layers, business logic, errors, access control, dependencies, tests, data environments,
and deprecated patterns. Investigate answers present in the repository yourself.

Prepare project.yaml from [the project template](references/project.yaml) with the actual main branch, GitHub repository, and executable
required checks as command/argument arrays. `easy-skills init --config <file>` shows
the proposal; apply its exact hash after the user reviews it. Preserve existing
AGENTS.md and CLAUDE.md and use short pointers to one shared rules directory.

The generated rules are interview drafts. Replace unresolved text with agreed allowed,
forbidden and approval-required behavior. Create layer files only for actual layers.
Record decisions and a current project map. Do not require Docker, WSL or API keys.
Complete `.easy-skills/decisions/onboarding.json`, preview `agree-rules --file FILE`,
and apply the exact reviewed hash. Generated drafts never establish agreement. Show
the agreement version/hash for the feature plan. Rules changes need a new agreement.
