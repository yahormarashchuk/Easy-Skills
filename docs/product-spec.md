# Easy Skills product specification

This document preserves the agreed implementation plan in English. It describes
the intended product and its release criteria; the original plan preceded creation
of the repository and executable components. For current implementation progress,
see [implementation status](implementation-status.md).

**Product: Easy Skills, licensed under Apache-2.0.** The primary mode runs everything
on the user's computer while allowing remote control. No separate server is required.
AI agents run on the host rather than in containers. Docker remains an optional tool
for application environments and test data.

**A separate skill for checking branch compatibility and resolving conflicts is part
of the main workflow.** It runs automatically at the appropriate checkpoints and
manually at the user's request.

Command and file names below describe the intended Easy Skills interface.

# 1. What we are building

**Easy Skills is an installable collection of engineering skills and a small local
runner that takes an agreed feature from a description to a verified Pull Request.**

User journey:

> Install Easy Skills → configure the project once → describe a feature → answer
> questions → choose CLI and model assignments for each stage → approve the plan →
> receive a sequence of completed Issues and PRs → verify the complete feature →
> merge it into the main branch → run cleanup.

Initial version boundaries:

| Area | Decision |
| --- | --- |
| AI clients | Codex CLI and Claude Code, with an architecture that allows additional clients. |
| Model access | The user's own authentication in official CLIs, without mandatory model API keys. |
| Execution | On the user's computer, including Windows without mandatory WSL. |
| Remote control | GitHub and email notifications, supplemented by available native client features. |
| Within a feature | One executing Issue at a time, ordered by dependencies. |
| Between features | Parallel execution in separate worktrees. |
| GitHub | A separate PR per Issue and a final PR for the complete feature. |
| Merging | Intermediate PRs merge automatically into the feature branch when authorized; the main branch requires separate permission. |
| Quotas | Wait for recovery and resume without silently substituting a model or provider. |
| Errors | After three identical unsuccessful cycles without progress, stop the affected task and notify the user. |

**Easy Skills itself is free.** Users access models through their own accounts;
the product neither provides nor resells a shared subscription.

# 2. What we adapt from the source repositories

We build an original product by adapting specific procedures, rather than combining
three complete projects.

| Source | Procedures used | Changes |
| --- | --- | --- |
| **`addyosmani/agent-skills`** | DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP lifecycle, plan approval before autonomous implementation, and stage checks. | Add durable execution, GitHub history, CLI/model selection, recovery and notifications. |
| **`mattpocock/skills`** | The `grilling` interview, decision trees, integration branches, dependent tasks, worktrees and context handoff through document links. | Execute Issues sequentially within each feature, create a PR for each Issue and defer cleanup until the final merge. |
| **`donvito/codex-astra-luna-orchestrator`** | Separate planner, implementer, tester and reviewer responsibilities; bounded assignments with result criteria. | Remove fixed model assignments and the requirement for a continuously running lead agent. |

The source procedures include Addy's lifecycle and `/build auto`, Matt's interview
rounds and integration branch/worktree approach, and Donvito's roles and delegation
contracts. Record the actual inspected revisions when adapting them.

**One task uses one primary procedure.** Do not run duplicate TDD methodologies or
equivalent reviews merely because they appear in different source repositories.

For adapted components, retain provenance, source revision, applicable licenses and
a description of changes. Use small attribution files rather than copies of the
entire upstream repositories. The product's Apache-2.0 license does not replace the
conditions attached to adapted material. [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)

# 3. Architecture: skills guide, the runner executes

```text
       User: CLI / GitHub
               |
           Easy Skills
               |
          Local runner
               |
      +--------+---------+
      |                  |
   Codex CLI         Claude Code
      |                  |
      +--------+---------+
               |
      Worktrees / checks
               |
      GitHub Issues and PRs
               |
       Email notifications
```

## Skills

Skills describe engineering procedures: asking questions, planning, writing tests,
reviewing changes and resolving conflicts.

## Runner

The runner is a normal program that launches CLIs, monitors processes, persists
state, manages GitHub operations and waits for relevant events.

**Queue inspection, quota waiting and notification delivery do not require a model.**

The proposed technical foundation is **TypeScript, a supported Node.js LTS version
and SQLite**. This is a runner implementation choice, not a restriction on the
technology stacks of user projects. Distribute the runner as a ready-to-use package
so users do not need to compile its source.

Verify process handling separately on Windows: `.cmd` launchers, paths containing
spaces, child-process termination and continuation after terminal closure have
platform-specific behavior. See the [Node.js process documentation](https://nodejs.org/api/child_process.html).

## Client adapters

Codex and Claude Code have separate adapters with a common contract:

```text
Check installation and authentication
Validate the selected model configuration
Start an assignment
Receive events and the result
Resume a specific session
Stop execution
Classify an error
```

Codex provides `codex exec`, structured output and continuation by session ID.
Claude Code provides programmatic execution through `claude -p`, structured output
and `--resume`. These interfaces allow integration without simulating keystrokes.
[OpenAI non-interactive mode](https://developers.openai.com/codex/noninteractive)

Between different CLIs, transfer **the specification, rules, task state, code references
and check results**. Do not attempt to move one client's internal session into another.

Keep official CLIs unmodified. Easy Skills does not extract their tokens for its own
model requests. Distribution involving Claude Code must also account for Anthropic's
applicable conditions for running the client within a third-party product, including
end-user authentication and no intermediary payment for model usage.
[Claude legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance)

# 4. Skill collection

The main user entry points are `easy-init`, `easy-feature`, `easy-sync` and
`easy-cleanup`. Other skills handle setup or individual workflow stages.

| Skill | Purpose |
| --- | --- |
| **`easy-init`** | Inspect a project, interview its owner, agree rules and save context. |
| **`easy-rules`** | Propose rule changes and show their diff and consequences for current tasks. |
| **`easy-mcp`** | Select and configure useful MCP integrations with user permission. |
| **`easy-remote`** | Configure remote control of local execution and notifications. |
| **`easy-feature`** | Accept a feature description, run DEFINE, collect model assignments and prepare execution. |
| **`easy-plan`** | Produce the implementation specification, Issues, dependencies and acceptance criteria. |
| **`easy-build`** | Implement the current task using the agreed discipline, including TDD. |
| **`easy-test`** | Execute checks, collect evidence and organize repairs. |
| **`easy-review`** | Independently verify requirements, correctness and regressions. |
| **`easy-ship`** | Prepare PRs and perform only authorized delivery actions. |
| **`easy-sync`** | Update a branch, check compatibility, resolve conflicts and validate the result again. |
| **`easy-resume`** | Recover execution after interruption, quota waiting or human intervention. |
| **`easy-cleanup`** | Safely remove feature-owned worktrees and temporary resources after final merge. |

Supporting procedures such as TDD, debugging, security checks and code simplification
are selected by the relevant stages. Users should not need to invoke the entire skill
list manually for every task.

# 5. Initial project setup

## How `easy-init` works

The user describes the project. The agent inspects it without changing application
code, finds existing instructions and interviews the user about gaps and contradictions.

Establish concrete rules beyond a statement such as "the project uses Blazor":

> Which components are maintained examples? Where does business logic belong? Which
> dependencies are permitted? How are errors, authorization, testing and data access
> handled? Which existing approaches are deprecated and must not be copied?

The interview adapts `grilling`: ask rounds of questions along a decision tree and
investigate discoverable facts directly in the project.

After agreement, use the following structure:

```text
project/
├─ AGENTS.md
├─ CLAUDE.md
└─ .easy-skills/
   ├─ project.yaml
   ├─ rules/
   │  ├─ architecture.md
   │  ├─ coding-style.md
   │  ├─ testing.md
   │  ├─ boundaries.md
   │  └─ layers/
   ├─ context/
   │  ├─ project-map.md
   │  └─ glossary.md
   ├─ decisions/
   └─ features/
      └─ <feature-id>/
         ├─ spec.md
         ├─ plan.md
         └─ execution.yaml
```

Keep `AGENTS.md` and `CLAUDE.md` as short entry instructions. Maintain detailed rules
in one place; each client adapter ensures the relevant sections are loaded.

**The universal template must not require a `blazor.md` file.** Add layer-specific
files only where those layers actually exist.

Separate rules into allowed, forbidden and approval-required behavior. A violation
found in legacy code does not become an approved pattern.

## Separately stored state

SQLite, process logs, session IDs, the notification queue and local settings belong
**in the user's Easy Skills directory outside the Git repository**. Otherwise parallel
worktrees would acquire divergent copies of execution state.

Secrets must not enter Markdown, Issues or commits.

**Onboarding does not repeat before every feature.** Agents must still read current
code in the affected area. If architecture has changed since the saved project map,
report the discrepancy instead of trusting stale context.

# 6. Starting a feature and choosing models

`easy-feature` accepts an ordinary description, an existing Issue or a document.
Screenshots and mockups supply additional requirements.

Sequence:

```text
Description
  → DEFINE in the current CLI
  → interview and requirements agreement
  → choose CLI and model assignments for subsequent stages
  → PLAN using the selected model
  → one final approval
  → autonomous execution
```

The final approval shows the specification, task order, model assignments, checks,
permissions and stop rules.

Local drafts may be created before approval. Implementation and publication of the
Issue set must not start without permission.

## Stage assignments

| Stage | Configuration |
| --- | --- |
| DEFINE | The current CLI and current model, displayed explicitly. |
| PLAN | The user chooses a CLI, then a model. |
| BUILD | The user chooses a CLI, then a model. |
| VERIFY | The user chooses a CLI, then a model. |
| REVIEW | The user chooses a CLI, then a model. |
| SHIP | The user chooses a CLI, then a model for necessary agent actions. |

Preserve this conversational flow:

> **Which CLI should BUILD use?**
> Codex.
> **Which model should it use?**
> Luna.

Validate the actual identifier and availability of the configuration. If a user's
label is unrecognized, do not silently substitute another model.

Additional roles inherit the stage assignment. For example, **conflict repair uses
BUILD and independent review of the repair uses REVIEW**. Show this in the final
plan; allow separate overrides through advanced settings.

Running `git`, waiting for CI and invoking an already defined test command remain
ordinary program operations. Assigning a model to a stage does not require a model
call for every technical step.

# 7. GitHub workflow

Use the agreed branch layout:

```text
main
 └─ feature/ai-chat
      ├─ issue/101
      │    └─ PR → feature/ai-chat
      ├─ issue/102
      │    └─ PR → feature/ai-chat
      └─ issue/103
           └─ PR → feature/ai-chat

feature/ai-chat
 └─ final PR → main
```

The product uses the project's configured main branch. `main` above is an example,
not a mandatory name for all repositories.

## Executing one Issue

The runner creates the Issue branch and worktree from the current feature integration
branch. BUILD, VERIFY and REVIEW then execute sequentially.

After successful checks, create a ready intermediate PR. **Under the agreed semantics,
close the Issue at this point**, with an implementation summary, check evidence and
the PR link.

After the authorized intermediate merge, verify the integration branch state and
start the next task.

> **A dependency is satisfied when its result is included in the integration branch,
> not merely when its Issue closes.**

Reopen an Issue if its PR is rejected or validation finds an unmet requirement.

The runner closes child Issues explicitly. GitHub does not apply standard closing
keywords in the same way to PRs targeting a non-default branch.
[GitHub Issue/PR linking](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

## Completing a feature

After all tasks, check compatibility with the main branch, run end-to-end validation
and review the complete change.

Intermediate review covers an individual task. Final review covers interactions
between feature components and compliance with the overall specification. These
are different review scopes rather than duplicate procedures.

The parent feature Issue stays open until final merge.

**Account limitation:** when PRs are created under the user's account, manual review
cannot always use GitHub's `Approve` button because authors cannot approve their own
PRs. A required independent approval needs another reviewer. Easy Skills must not
bypass this restriction.
[GitHub required reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)

# 8. `easy-sync`: compatibility checks and conflict resolution

This is a required part of the product. Invoke it when the integration branch needs
updating from the main branch, before final PR readiness, before an authorized merge
and manually when requested.

**When the runner detects a new `main` revision, it must not interrupt active file
editing.** Wait for a safe checkpoint and hand the branch to `easy-sync`.

## Procedure

**1. Inspect the starting state.** Identify target branches, commits, the current
executor and uncommitted changes. Do not modify another executor's working directory.

**2. Create a recovery point.** Record original refs and prepare a controlled operation.
Do not use `reset --hard` as a universal repair.

**3. Study both sides.** Inspect specifications, related Issues, rules and changed
contracts as well as the conflicting lines.

**4. Merge.** The default for published working branches is a merge without forced
history rewriting.

**5. Resolve and validate behavior again.** Run required checks, including checks for
affected neighboring functionality.

**6. Persist the result and update status.** Record the conflicts, their resolution
and supporting check evidence. Preserve state and request a user decision when the
intended result is ambiguous.

A clean starting worktree matters: Git warns that even `merge --abort` may be unable
to restore the original state after merging over uncommitted changes.
[Git merge documentation](https://git-scm.com/docs/git-merge)

## Prohibited shortcuts

Do not select the entire `ours` or `theirs` side without analysis, remove checks to
make validation pass, lose another feature's behavior or declare success solely
because conflict markers disappeared.

For example, if one feature adds message loading and another changes access checks,
preserve both behaviors rather than choosing the newer file wholesale.

**A lack of textual conflicts does not remove the compatibility-check requirement.**
Successful `easy-sync` means the prescribed checks confirm the result; it is not a
guarantee that every possible defect has been excluded.

If synchronization changes an already reviewed PR's code, its earlier review does
not automatically apply to the new commit. Bind readiness and permissions to an
exact revision.

# 9. Local execution and remote control

## Primary approach

The runner stays on the user's computer and exchanges state with GitHub.

From a phone, the user can open an Issue, inspect progress, answer a decision request
or issue a supported control command. Email links to the relevant Issue or PR.

Initial remote actions are status, answers to specific requests, pause, resume and
stop. They do not provide a remote shell for arbitrary comment text.

**No incoming port on the user's computer is required:** the runner can poll GitHub
through outbound requests.

## Optional Claude Code support

`easy-remote` also explains and checks availability of native Remote Control for
interactive Claude Code sessions. It allows control of a local session from another
device, while the local process must remain running.
[Claude Remote Control](https://code.claude.com/docs/en/remote-control)

**Claude Code Remote Control is not a common control interface for every Codex and
Claude process.** The runner controls the complete feature; a client's native remote
control is supplementary.

## Runner lifecycle

Closing a terminal must not stop an approved task. Reconnecting displays the existing
run instead of creating another executor.

Automatic recovery after reboot is enabled separately. Installation must not register
automatic startup without permission.

The computer must stay powered on and awake. Shutdown or sleep does not turn a local
task into a cloud task. When the machine returns, recover from persisted state.

# 10. Databases, Docker and MCP

## Data environments

Docker is not an installation requirement. During onboarding, the user chooses an
existing test environment or an isolated environment.

For parallel features, prefer separate mutable data per feature: its own database
or schema, ports and temporary files. Docker Compose supports distinct project names
for parallel environments, but shared volumes and published ports still require
separate checks. [Docker Compose project names](https://docs.docker.com/compose/how-tos/project-name/)

When using a shared test database, the runner must serialize incompatible operations
such as migrations, cleanup and changes to shared fixtures. This is a resource lock,
not an artificial spending limit.

**AI clients run on the host.** Workflow and tool-permission restrictions still apply,
but without isolation they must not be described as absolute host protection against
an agent with broad shell access.

## MCP setup

`easy-mcp` investigates project needs and proposes only useful integrations. For each,
show its purpose, permissions, transmitted data and an alternative without MCP.

Setup requires a preview diff, backup of existing configuration and a connection
probe. Writing configuration alone does not establish a working integration.

Use one selected primary GitHub transport: `gh` or MCP. Local Git operations remain
a separate component.

The runner maintains one operation journal regardless of transport. Do not create
the same Issue through both CLI and MCP or switch transports silently.

# 11. Recovery, notifications and user decisions

## Durable state

Persist the following for every run:

```text
Feature and approved plan version
Current Issue and stage
CLI, model and session ID
Branch, worktree and commits
Created Issues and PRs
Check results
Stop reason
Pending decision or next retry time
```

After interruption, first inspect actual process, Git and GitHub state. For example,
if a PR was created but its response was not persisted, find the existing PR.

**Continue from the last confirmed state instead of blindly repeating every command.**

Parallel features require specific session IDs. Both clients support targeted
continuation; "resume the latest session" is not reliable enough for this workflow.
[OpenAI non-interactive mode](https://developers.openai.com/codex/noninteractive)

## Waiting rules

| Event | Behavior |
| --- | --- |
| Quota exhausted | Persist state and wait for recovery without replacing the model. |
| Reset time known | Use the time supplied by the client. |
| Reset time unknown | Retry with increasing delay without promising an exact recovery time. |
| Login required | Notify the user; do not bypass authentication. |
| Three identical unsuccessful repairs | Stop the affected task and request intervention. |
| Required check unavailable | Mark it incomplete; do not declare readiness. |

Quota waiting and network retries do not consume code-repair attempts.

## Email

Notification format:

```text
Display name: Easy Skills

[Easy Skills][Project][Feature] Decision required
[Easy Skills][Project][Feature] Waiting for quota recovery
[Easy Skills][Project][Feature] Ready for final verification
```

Email contains a brief reason, status and an Issue or PR link. Do not send secrets
or complete session logs.

Configure a sender once, for example through SMTP. Recipients may use Gmail; the
product does not need access to their inbox. Without a configured notification
channel, Easy Skills must not claim that notifications are being sent.

## Accepting decisions

Bind an answer to a specific request and plan version. An old "yes" does not authorize
a new operation.

The shared GitHub account has an important limitation: **checking the author's name
alone cannot distinguish a person from automation acting under the same identity**.
For decisions expanding permissions, require an additional confirmation, such as a
single-use email code that is not provided to agents. Use an explicit confirmation
command for local CLI decisions.

This is an additional workflow safeguard, not a replacement for isolation.

# 12. Cleanup and updates

## `easy-cleanup`

Run cleanup after the final PR is actually merged into the main branch.

Check PR state, absence of active executors, uncommitted and untracked files, preserved
results, and ownership of every resource by the selected feature.

Show the cleanup plan and remove only approved resources.

Git itself refuses to remove a dirty worktree without a force flag. Easy Skills must
not bypass that protection by default. [Git worktree documentation](https://git-scm.com/docs/git-worktree)

Docker volumes and database contents require separate permission. Do not delete
Issues, PRs or their discussions.

With squash merges, branch ancestry alone is insufficient. Cleanup must consider
confirmed GitHub merge state and the saved mapping of feature results.

## Easy Skills updates

An active run pins skill versions, runner contracts and project rules.

Updates show a diff, preserve user settings and support rollback. Changes to critical
safety rules require separate treatment: an unsafe action must not continue merely
because an older version authorized it.

# 13. Easy Skills repository structure

```text
easy-skills/
├─ README.md
├─ LICENSE
├─ NOTICE
├─ THIRD_PARTY_NOTICES.md
├─ CONTRIBUTING.md
├─ SECURITY.md
├─ skills/
│  ├─ easy-init/
│  ├─ easy-feature/
│  ├─ easy-plan/
│  ├─ easy-build/
│  ├─ easy-test/
│  ├─ easy-review/
│  ├─ easy-ship/
│  ├─ easy-sync/
│  └─ ...
├─ src/
│  ├─ cli/
│  ├─ runner/
│  ├─ adapters/
│  │  ├─ codex/
│  │  └─ claude-code/
│  ├─ git/
│  ├─ github/
│  ├─ persistence/
│  ├─ notifications/
│  └─ environments/
├─ schemas/
├─ templates/
├─ integrations/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ recovery/
│  └─ end-to-end/
└─ docs/
   ├─ installation/
   ├─ architecture/
   ├─ provider-compatibility/
   └─ contributing/
```

Every installed skill must include all required materials. Check this explicitly:
Addy's source repository describes the failure case where installing one skill
does not carry shared reference files from the repository root.

Maintain one source copy of each shared procedure. The packager includes its required
dependencies in each installed skill package.

# 14. Implementation order

Start **by validating the execution foundation**, before writing a large collection
of Markdown files.

| Phase | Deliverable | Acceptance criterion |
| --- | --- | --- |
| **1. Contracts and provenance** | Project, run, model and stage-result schemas; adaptation map for source procedures. | Inputs, outputs, states and authority boundaries are defined. |
| **2. Codex and Claude Code verification** | Minimal installation, authentication, execution and resume adapters. | On Windows, both CLIs execute a test assignment using the selected authentication mode and resume the intended session. |
| **3. Installer and diagnostics** | Package installation, client integration, dependency checks and removal. | A clean Windows environment works without manual configuration edits; existing settings are preserved. |
| **4. Durable runner** | SQLite, event journal, processes, locks and recovery. | Terminal closure and forced interruption preserve state without creating a second executor. |
| **5. Onboarding and rules** | `easy-init`, `easy-rules` and context templates. | Rules come from interviews and the project rather than a built-in .NET assumption. |
| **6. Feature and model routing** | DEFINE, PLAN, stage assignments and final approval. | Each stage invokes the selected client with the correct context and no hidden substitution. |
| **7. GitHub and worktrees** | Parent and child Issues, intermediate PRs and an integration branch. | Dependent tasks execute sequentially; two features do not mix files or state. |
| **8. BUILD → VERIFY → REVIEW** | Adapted engineering procedures and inspectable results. | A model report without evidence from required checks cannot make a task ready. |
| **9. Synchronization and conflicts** | `easy-sync`, recovery and refreshed checks. | Test conflicts are resolved without lost changes; ambiguous cases block correctly. |
| **10. Notifications and remote decisions** | Email, GitHub answers, pause and resume. | A phone response applies to the correct request; unauthorized and stale commands are rejected. |
| **11. MCP, environments and cleanup** | Integration setup, existing database/Docker support and `easy-cleanup`. | Permissions and resources are checked; foreign data and dirty worktrees are not removed. |
| **12. Open-source release** | Documentation, updates, rollback, compatibility matrix and examples. | Installation and the end-to-end scenario are confirmed on at least two technology stacks. |

Phase 2 includes a concrete compatibility constraint: do not select an arbitrary
"lightweight" execution mode. For example, `claude --bare` skips automatic loading
of several settings and does not use subscription login, which matters for the
chosen authentication model. [Claude programmatic execution](https://code.claude.com/docs/en/headless)

Public CI tests the runner using simulated CLIs, temporary Git repositories and
failure scenarios. Test real authenticated clients separately; do not put personal
subscription sessions into public workflows.

## When the first version is ready

The complete acceptance scenario must pass:

A user installs Easy Skills on Windows, connects an existing project and agrees its
rules. They start two features with different CLI/model assignments. Within each
feature, Issues execute sequentially; the two features run in parallel.

During execution, close the terminal, simulate quota exhaustion and change the main
branch. The runner preserves progress, resumes the correct sessions, invokes
`easy-sync` and validates the result again. An ambiguous decision triggers email,
and a GitHub response resumes the correct task.

At completion, the user receives individual task PRs and a final feature PR with
check evidence. After final merge, `easy-cleanup` removes only safe temporary resources.

**This scenario, rather than the number of skills created, is the primary Easy Skills
release criterion.**
