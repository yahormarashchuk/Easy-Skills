---
name: easy-review
description: Independently review an Easy Skills task or integrated feature at the verified revision.
---

Read [the workflow contract](references/workflow.md). Inspect the diff, specification,
rules and check evidence afresh. Do not rely on the implementer's summary. Look for
incorrect behavior, missing acceptance, regressions, data loss and relevant security
boundaries. Give actionable findings with code locations and their consequences.

Do not edit code in review. A task review targets its PR; final review targets
interactions across the whole feature. Review is valid only for the inspected commit.
Do not fabricate GitHub approval or bypass required independent reviewers. Return a
structured verdict; the runner binds it to the actual head and repeats it after changes.
