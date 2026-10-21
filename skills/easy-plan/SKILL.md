---
name: easy-plan
description: Turn agreed requirements into an executable Easy Skills plan with sequential tasks and acceptance criteria.
---

Read [the workflow contract](references/workflow.md). Use the agreed specification,
project rules and exact assignments. Explore architecture and test seams before
breaking work into small deliverable Issues with explicit acceptance criteria.

Prepare [a feature request](references/feature-request.yaml) with featureId, title, spec, exact assignments and permissions.
Run `easy-skills feature plan --file <request.yaml> --out <execution.yaml>` to launch
the assigned PLAN CLI/model in read-only mode. It preserves agreed fields and produces
an unapproved local draft; it must not implement or publish anything.

Produce spec.md, plan.md and execution.yaml using the packaged plan schema and
[references/feature.yaml](references/feature.yaml). The machine contract is
[references/plan.schema.json](references/plan.schema.json). Include acyclic dependencies, current rulesHash, runner and
skills versions, required commands, and publish/merge permissions. Do not assume a
particular framework. Each Issue gets a PR into the feature integration branch.

Validate using `easy-skills feature draft --file <execution.yaml>`. This creates only
a local draft. Show its planHash with the complete plan for user approval. Use
`easy-skills feature approve <run> --hash <reviewed-hash>` only when the user's answer
authorizes that specific version. Then `easy-skills start <run>` starts the worker.
