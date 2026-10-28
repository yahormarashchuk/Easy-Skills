# Easy Skills

![Easy Skills — Configure once. Describe a task. Approve the plan. Workflow: DEFINE, PLAN, BUILD, VERIFY, REVIEW, SHIP.](docs/assets/easy-skills-banner.png)

<p align="center">
  <a href="https://github.com/yahormarashchuk/Easy-Skills/actions/workflows/ci.yml"><img alt="GitHub Actions CI status" src="https://github.com/yahormarashchuk/Easy-Skills/actions/workflows/ci.yml/badge.svg"></a>
  <a href="package.json"><img alt="Node.js 24 or newer" src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache_2.0-blue"></a>
  <a href="docs/implementation-status.md"><img alt="Status: development alpha" src="https://img.shields.io/badge/Status-Development_alpha-orange"></a>
</p>

**Configure your project once. Describe a task. Discuss requirements with AI. Choose your models. Approve the plan. Easy Skills develops, tests, reviews, and prepares a Pull Request autonomously.**

A local CLI for developers who want to assign work, review a clear proposal, and
return to a reviewed PR. Uses official AI CLI authentication and keeps execution
state on your machine. No mandatory Docker, WSL, server, dashboard, or direct model
API key.

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#models">Models</a> ·
  <a href="#documentation">Documentation</a>
</p>

> [!IMPORTANT]
> **Development alpha — `0.1.0-alpha.2`.** The guided journey is covered by local
> fixtures; live Codex/GitHub acceptance is still pending. Claude Code runs when no
> admin or organization policy configures hooks, plugins, a policy helper or extra allow rules; otherwise
> its launch is refused with the reason. No provider or model is silently substituted. Published alpha.1 assets predate this guided workflow.

## ✨ What you get

| | Capability | What it means for you |
| --- | --- | --- |
| 💬 | Project-aware conversations | Investigate existing code and conventions, then discuss unresolved questions. |
| 🧠 | Reusable project knowledge | Save approved rules, source references, and owner answers for future tasks. |
| 🎛️ | Exact model assignments | Choose a provider and exact model for each of six engineering stages. |
| 🔀 | One task, one PR | Reuse an existing Issue, work on one isolated branch, and deliver a PR for manual acceptance. |
| 🧪 | Checks and review | Run approved checks, review the actual diff, and repair defects within the approved limit. |
| 🔄 | Recoverable execution | Persist progress and exact sessions across interruptions, quota waits, and retries. |

<a name="quick-start"></a>

## 🚀 Quick start

### 1️⃣ Install and sign in

| Prerequisite | Purpose |
| --- | --- |
| Node.js **24+** | Runs the local Easy Skills CLI and SQLite state store. |
| Git | Creates isolated task worktrees and branches. |
| GitHub CLI (`gh`) | Reads Issues and publishes approved branches and PRs. |
| Official Codex CLI | Runs your selected exact models using official authentication. |

Sign in through the official tools:

```powershell
gh auth login
codex login
```

From this source checkout, build and install the current guided alpha:

```powershell
npm ci
npm run build
npm pack
npm install -g ./easy-skills-0.1.0-alpha.2.tgz
```

Package users install the compiled tarball; the package contains the runtime, skills,
schemas, templates, and documentation. There is no npm registry release for this
working version. See [installation, upgrades, and removal](docs/installation/README.md).

### 2️⃣ Configure your project once

Open the existing GitHub repository you want Easy Skills to work on. Its `origin`
must identify the intended repository. Run:

```powershell
easy-skills init
```

Easy Skills inventories maintained instructions, manifests, docs, skills, and code
examples. Choose a model from a numbered list, answer the unresolved questions, and review
the proposed rules, setup commands, and required checks before saving them.

Discovery does not execute project tests or change application code. Existing
instructions are preserved. Large projects start with bounded samples; deeper
inspection and instruction validation can take longer.

### 3️⃣ Assign a task

```powershell
easy-skills run 909
```

The AI reads the existing Issue and relevant implementation, discusses requirements,
and prepares a technical plan. Confirm the specification and model assignments, then
approve **Start autonomous development** once.

If project onboarding is missing, Easy Skills performs it and continues your task.
You do not need to prepare YAML or copy approval hashes for the normal terminal flow.

### 4️⃣ Follow progress and review the PR

```powershell
easy-skills status
```

The detached worker implements, checks, reviews, and publishes the approved work.
The result is a reviewed PR awaiting your acceptance. **Final merge is manual by
default.** Closing the terminal does not stop the detached worker.

> [!TIP]
> If PowerShell blocks an npm `.ps1` wrapper, use `easy-skills.cmd` or `npm.cmd` with
> the same arguments. No system execution-policy change is required. Native Windows
> and paths containing spaces are supported.

<a name="how-it-works"></a>

## 🛠️ How it works

```mermaid
flowchart LR
    A["💬 Understand the task"] --> B["📋 Review the plan"]
    B --> C["✅ Approve execution"]
    C --> D["🔨 Implement"]
    D --> E["🧪 Verify"]
    E --> F["🔎 Review the diff"]
    F --> G["🔀 Prepare the PR"]
    E -->|Implementation defect| D
    F -->|Actionable findings| D
    G --> H["👤 Your review and merge"]
```

| Step | Easy Skills does | You decide |
| --- | --- | --- |
| 👀 Discover | Read project conventions, examples, and existing instructions. | Resolve important gaps and approve project rules. |
| 💬 Define | Investigate the task, related code, tests, and skills. | Clarify behavior, acceptance, and exclusions. |
| 📋 Plan | Prepare a concrete implementation plan and display all six model assignments. | Approve the displayed scope, commands, and permissions. |
| 🔨 Develop | Work in an isolated branch, run checks, and perform a separate review. | Respond only to genuine blockers or material changes. |
| 🔀 Deliver | Push the approved branch and create or update its PR. | Review the result and choose when to merge. |

The execution approval covers the displayed task paths, setup and checks, repair
limit, branch push, and PR handling. Protected checks, rules, and exact assignments
remain enforced. Passing check evidence comes from executed commands at the reviewed
commit; model prose does not establish a passing test.

## 📥 Start from an Issue, an idea, or a specification

| Starting point | Example |
| --- | --- |
| Existing Issue | `easy-skills run 909` |
| Issue URL in the configured repository | `easy-skills run https://github.com/owner/repository/issues/909` |
| Natural-language task | `easy-skills run "Fix search by full name"` |
| Local Markdown or text specification | `easy-skills run "docs/specs/name search.md"` |

An existing Issue is reused and remains open until its reviewed PR is actually
merged. Text and local-document tasks create a PR without creating an Issue.
Direct PR delivery does not require branch-protection API access or automatic merge
eligibility, including in restricted private repositories.

To discuss a correction **before execution**, decline the proposal and refine the
same Issue:

```powershell
easy-skills run 909 --refine "Preserve selection behavior and normalize spaces"
```

<a name="models"></a>

## 🎛️ Choose your models

Save a named profile such as **Fast**, **Balanced**, or **High Quality**. A profile
is simply a name for saved settings; press Enter to use **Balanced** if you are unsure.
Easy Skills loads the current catalog from your official Codex CLI or Claude Code and
lets you choose a model and reasoning effort by number. You do not need to know or type
its technical ID. Provider prompts also use a numbered list. Claude Code is shown as
unavailable when it is missing, signed out, or managed policy configures hooks, plugins
or a policy helper; selecting an unavailable provider explains why and asks again. Login and model access are checked after selection.

For example (the actual list depends on your installed client and account):

```text
Choose a model from codex
  1. GPT-6.1-Sol [default]
  2. GPT-6.1 Terra
  3. GPT-6-Astra
Choose a model by number (1-3) [1]: 2
```

After choosing a model, choose its reasoning effort from the numbered options reported
by the client. Press Enter to use the model's advertised default. Effort controls how
much reasoning the model can use; higher settings can take longer and use more quota.
The selected model ID and effort are saved for each stage. Existing profiles without
an effort retain the CLI's unpinned default until you edit them with `easy-skills config`.
The same numbered selection is available when assigning individual stages. Catalog discovery runs no AI task;
account access is checked separately before use. An unavailable saved model requires
an explicit replacement rather than an automatic fallback.

| Stage | Responsibility | Assignment |
| --- | --- | --- |
| DEFINE | Project and task interviews | Your provider, model, and effort |
| PLAN | Technical implementation planning | Your provider, model, and effort |
| BUILD | Implementation and corrective changes | Your provider, model, and effort |
| VERIFY | Acceptance inspection alongside runner-executed checks | Your provider, model, and effort |
| REVIEW | Separate review of the actual file diffs | Your provider, model, and effort |
| SHIP | Delivery-readiness inspection before runner publication | Your provider, model, and effort |

```powershell
easy-skills config
```

Saved profiles avoid re-entering all six assignments for each task. Availability,
authentication, and compatibility are checked. Compatibility probes request consent
before using account quota and validate exact-session continuation.

**Codex and Claude Code can both be used.** Claude Code launches stop with a diagnostic
only when an administrator or organization policy configures hooks, plugins, a policy
helper or extra allow rules. Explicitly choose another configuration when that happens; there is no silent fallback.

## 🔄 Resume work and request changes

| Situation | Command | Result |
| --- | --- | --- |
| Check the latest task | `easy-skills status` | Readable progress, PR, or genuine blocker. |
| Resume after interruption | `easy-skills resume` | Continue the approved plan and recorded sessions. |
| Revise an Issue's delivered work | `easy-skills revise 909 "Also normalize repeated spaces"` | Review a revised plan and update the same branch and PR. |
| Revise a text or document task | `easy-skills revise latest "Describe the correction"` | Select the latest active task without an internal ID. |
| Update project rules | `easy-skills rules "Require approval before new dependencies"` | Investigate conflicts and approve a new rules version. |

Feedback retains the previous specification and implementation context. A revised
approval invalidates old readiness, preserves approval history, and repeats checks
and review. A materially different plan cannot inherit old permission.

Quota and network waits use backoff. Authentication problems require official login.
A recorded live client blocks a duplicate executor. Changed, closed, merged, or
actively merging PRs require reconciliation before further changes.

<a name="commands"></a>

## ⌨️ Commands at a glance

| Command | Use it to… |
| --- | --- |
| `easy-skills init` | Learn a project and approve reusable rules. |
| `easy-skills run <task>` | Discuss requirements and start approved autonomous work. |
| `easy-skills status [task]` | Inspect the latest task or a selected Issue. |
| `easy-skills resume [task]` | Recover an approved task safely. |
| `easy-skills revise <task> "feedback"` | Update an existing PR; use `latest`, an Issue number, or a displayed task title. |
| `easy-skills rules ["change"]` | Review or update the project rules. |
| `easy-skills config` | Select or edit exact stage model profiles. |
| `easy-skills install-skills --client codex --interactive` | Install official packaged skills with reviewed backups. |

The terminal workflow works directly. Installing the optional client-discoverable
skills exposes Easy Skills procedures inside supported clients without relying on
another local repository. Unrelated user skills are preserved; replaced managed
files receive backups.

## 🗂️ What is saved?

| Location | Contents |
| --- | --- |
| `.easy-skills/rules/` | Approved project rules, including preserved existing rule files. |
| `.easy-skills/context/` | Project knowledge, source references, owner answers, and discovered skill paths. |
| `.easy-skills/project.yaml` and the rules agreement | Managed project settings and versioned approval bindings. No manual editing is required for the guided flow. |
| External Easy Skills state home | SQLite execution state, profiles, sessions, logs, recovery records, and approval history. |

The state home defaults to `%LOCALAPPDATA%/EasySkills` on Windows and
`~/.local/share/EasySkills` elsewhere. `EASY_SKILLS_HOME` can select another directory
outside the managed repository. Agents do not receive private runner logs or session
histories as task context.

Approved local knowledge travels in direct task plans, so a setup PR merge is
unnecessary. Changes to rules invalidate earlier execution approvals and require a
reviewed replacement.

## 🧭 Guided by default, advanced when needed

| Previous manual journey | Guided default |
| --- | --- |
| Prepare configuration and rules agreements by hand. | Investigate, discuss, and approve through `init`. |
| Operate draft, hash, approve, and start commands separately. | Review one execution proposal through `run`. |
| Use parent/task Issues and intermediate branches for a small fix. | Reuse the original Issue with one task branch and one PR. |
| Reconstruct context for a follow-up. | Use `revise` and keep the existing branch, PR, and history. |

Advanced `feature plan`, `feature draft`, `feature approve`, and `start` commands
remain available for dependent multi-task features with integration branches and
explicitly authorized intermediate merges. Automatic merges retain their strict
gates and separate reviewed-head authorization.

Use `status --json` for detailed diagnostics. Explicit scripted operation uses
`--non-interactive --answers FILE`; generated rule and execution approvals must
match the displayed proposal digest. Missing or stale consent stops.

Existing alpha.2 configuration and approved runs are preserved. Legacy approvals
without current reliability contracts need a separately reviewed replacement.
Do not upgrade the package while its workers are active.

<a name="documentation"></a>

## 📚 Documentation

| Guide | What you will find |
| --- | --- |
| [Installation](docs/installation/README.md) | Packaging, skill discovery, Windows wrappers, removal, and upgrades. |
| [Guided workflow and migration](docs/guided-workflow.md) | Storage, trust, scripted approvals, feedback, migration, and remaining limits. |
| [Implementation status](docs/implementation-status.md) | Implemented behavior and outstanding acceptance work. |
| [Advanced operations](docs/advanced-operations.md) | Explicit configuration and multi-task feature procedures. |
| [Runner architecture](docs/architecture/runner.md) | Durable execution, approvals, evidence, ownership, and recovery. |
| [Merge gates](docs/merge-gate.md) | Separate merge authorization and GitHub policy requirements. |
| [Provider compatibility](docs/provider-compatibility/README.md) | Actual provider observations and current restrictions. |
| [Validation](docs/validation.md) | Deterministic fixtures and separately authorized live checks. |
| [MCP](docs/mcp.md) / [Remote control](docs/remote-control.md) | Optional integrations and advanced control. |

## 🧰 Develop and verify

```powershell
npm ci
npm run check
npm test
npm run build
npm pack
```

Tests use temporary repositories, real local Git operations, and injected model,
GitHub, and notification fixtures. A fixture pass does not establish live-provider
or GitHub acceptance. Real model requests and external mutations require separate
explicit authorization.

Apache-2.0 · [License](LICENSE) · [Contributing](CONTRIBUTING.md) ·
[Procedure provenance](THIRD_PARTY_NOTICES.md)
