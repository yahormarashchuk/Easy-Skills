---
name: easy-feature
description: Define a feature, resolve requirements and choose exact CLI/model assignments before implementation.
---

Read [the workflow contract](references/workflow.md). Read project context and current
code in the affected area. Accept prose, an Issue or a document; inspect provided
screenshots as additional requirements. Flag a stale project map.
Use [the interview procedure](references/interview.md). Reuse current resolved
decisions; investigate discoverable facts and resolve material conflicts or missing
UI states before approval. Confirm the structured rules agreement is current.

Run DEFINE in the user's current CLI/model and display that assignment explicitly.
Interview only unresolved behavior, acceptance, scope and constraints. For PLAN,
BUILD, VERIFY, REVIEW and SHIP ask which CLI, then which exact model ID to use.
Do not translate labels such as Luna into a guessed ID. Verify selected configurations
with `easy-skills doctor --provider <provider> --model <id> --probe` when authorized
to use the account. The probe also verifies exact-session continuation.

Use easy-plan to produce local drafts. Show one complete approval package: spec,
task order/dependencies, models, checks, permissions and stop rules. Implementation
tasks include explicit `scope.areas` and repository-relative `scope.paths`. Match
layer rule names to those areas. Show `project.mergePolicy` and any approved VERIFY
diagnostics/browser tools; never infer permission to bypass server requirements.
Implementation and Issue publication wait until the user approves the exact plan hash. Future final
main-branch merge requires a separate revision-bound decision.
