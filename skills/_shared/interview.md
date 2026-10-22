# Repository and feature interviews

Use this procedure for unresolved decisions, not as a questionnaire to repeat.
Keep one decision tree with stable IDs, topic, question, status, answer, evidence,
conflicting sources and explicit assumptions. Reuse answers only while their rules
revision and scope remain applicable.

1. Inspect instructions, manifests, maintained examples, tests and affected code.
   Record facts with repository paths. Treat old violations as evidence of legacy
   behavior, not permission to copy it. Verify the project map against current code.
2. Separate facts that can be investigated from choices only the owner can make.
   Investigate facts first. Ask a small round of dependent questions from the
   unresolved tree. Do not ask again for a recorded, still-applicable answer.
3. Identify contradictory instructions and requirements explicitly. State the two
   sources and their effects. Apply established instruction precedence where clear;
   ask the owner when project intent remains ambiguous. Do not silently invent an
   exception or change rules as an implementation shortcut.
4. For setup, resolve architecture/layers, maintained examples, allowed/forbidden/
   approval-required dependencies, errors/access control, checks and data isolation.
   For a feature, resolve observable behavior, exclusions, acceptance, affected paths,
   dependencies, failure states and verification. For UI work also resolve loading,
   empty/error states, accessibility, interactions and available visual evidence.
5. Record assumptions as assumptions, with consequences. A material unresolved choice
   blocks approval. If a required check is unavailable, identify its prerequisite;
   do not mark it passed or silently replace it. Preserve ambiguous merge conflicts
   and ask for behavior-level intent before choosing a resolution.
6. Finish only when the decision tree has no unresolved material decisions or
   contradictions, assumptions are reviewed, current repository facts support the
   plan and acceptance/checks are reproducible. Summarize decisions without replaying
   the interview. For onboarding, complete the structured decision record, preview
   `agree-rules --file INTERVIEW.json`, then apply the exact reviewed hash.

The generated `decisions/onboarding.json` is a draft. Agreeing its rules revision
does not approve a feature, expand permissions, or authorize a final merge. Rule
changes require a new agreement and an explicitly reviewed replacement plan.

Use [the interview evaluation cases](interview-evals.json) for behavioral validation.
Judge observable decisions and repository evidence, not wording or headings. Run
model-based evaluations only with permission to use the chosen account/model.
