# Guided workflow and migration

The terminal layer delegates interviews to DEFINE, technical planning to PLAN, and
approved work to the existing runner. Exact assignments, rules agreements, protected
verification controls and revision evidence remain authoritative. Model output is
never deterministic check evidence.

## Storage and trust

`runner/discovery.ts` takes a bounded initial inventory: up to 40 text samples and
80,000 characters. The selected client can inspect deeper relevant code read-only.
Discovery never runs setup, tests, package scripts or GitHub mutations. Tracked skills
are referenced; ignored/untracked skills are not automatically enumerated. Existing
instructions and skills are preserved.

Approved rules live in `.easy-skills/rules/approved-rules.md`; other existing rules
remain in force. Configuration is `.easy-skills/project.yaml`. Source paths, owner
answers and skill references are saved in `.easy-skills/context/knowledge.json`.
The existing versioned onboarding agreement binds configuration and the complete
rules hash. That hash covers `.easy-skills/rules/`, every `AGENTS.md`, `CLAUDE.md` and
`.mcp.json`, all of `.codex/`, and the `.claude/` files Claude Code loads (`CLAUDE.md`,
`settings.json`, `settings.local.json`, `commands/`, `agents/`, `skills/`, `hooks/`,
`output-styles/`, `rules/`). It skips nested worktrees and repositories, including
`.claude/worktrees/`. A covered file over 256,000 bytes stops onboarding with its path;
binary files are bound by digest. Inferred rules must cite existing Git-tracked files; untracked and ignored
files are not evidence. A reply with invalid evidence is discarded and the model is
asked again with the rejected paths, so a rerun never replays it. Relevance and content
quality still depend on the selected model and owner review.

The external SQLite journal stores profiles, interview answers/sessions, discovery
cache, approval history and recoverable knowledge-write intents. An approval intent
precedes writes; recovery accepts only approved before/after content and refuses
intervening edits. Backups remain. State must stay outside the repository.
Onboarding answers are kept per repository root and requested update until the rules
are approved; a repository change only discards the cached model reply.

Direct plans carry approved project knowledge without copying it into the task branch.
Protected checks validate the snapshot plus actual code/check controls. Guards reject
task edits to managed knowledge. No setup PR merge is required. Existing AGENTS.md,
CLAUDE.md and client settings must match the approved rules; dirty changes to those
controls require reconciliation before execution. General dirty developer work stays
untouched in the original checkout.

Approved owner choices and project rules govern the task. Repository examples,
skills, Issues and references are evidence, never permission to expand scope, tool
rights or model assignments. Agents do not receive private sessions or runner logs.

## Direct delivery and feedback

Optional `plan.workflow` binds the base commit, Issue, knowledge and separate push,
PR and Issue-completion permissions. It requires one independent task and prohibits
Issue creation and intermediate merges. Older plans without this field retain their
advanced feature behavior and serialized identity. Direct branches use `codex/`.
The historical internal worktree resource name remains `integration`; only one task
branch and worktree exist.

When the task worktree is created, files inside the approved scope paths that are
modified, staged, deleted or untracked (not ignored) in the source checkout are copied
into it and committed as `Add uncommitted task inputs from the source checkout`, so
BUILD sees inputs that were never committed. The source checkout is not changed, and
files outside the scope and `.easy-skills/` are never copied. On Windows the
repository's `core.longpaths` is set to `true` first, because task worktrees live
under the state directory. If Git has no `user.name`/`user.email`, task commits use the
signed-in GitHub account's name and no-reply address.

Instruction and client-control files that Git ignores in the source checkout, such as
generated `.claude/skills/` copies or `.claude/settings.local.json`, are bound by the
approved rules hash but can never come from a commit. Before every guard of a task
worktree they are copied from the source checkout, so each stage uses the same
instructions the plan was approved with. Being ignored, they never enter a commit.

Direct BUILD enters the existing final SYNC, VERIFY, REVIEW and SHIP machine. Baseline
evidence, setup/resource locks, protected controls, complete file review coverage,
bounded repairs, commit intents, worker locks and network reconciliation still apply.
Missing prerequisites and baseline failures stop for a decision. Required checks are
never removed to make delivery succeed.

Stable PR markers recover publication interruptions. Feedback updates the same PR
and branch after a new approval, retaining the previous plan, approval, evidence,
reviewed head and sessions. Sessions continue only for unchanged assignments. Old
readiness is invalidated. Feedback cannot change Issue identity, project or external
permissions; those changes require a separately reviewed task.

PR delivery does not query branch-protection APIs. Automatic merging still requires
the existing strict/queue policy and separate exact-head consent. Manual merges are
reconciled against the saved approval, PR identity, reviewed revision and evidence.
Issue completion follows actual merge. Ready workers still monitor base movement.

## Scripted inputs

Guided commands accept `--non-interactive --answers FILE`. The JSON object maps prompt
IDs to text or booleans. Missing inputs fail with their ID, including when a terminal
default exists. Generated rule and execution approvals require `approve:DIGEST` for
the exact displayed proposal; booleans cannot approve unseen generated work. A missing
approval reports the required digest after showing the proposal. Review the output,
then supply that value on a subsequent invocation. Unapproved drafts persist and
reuse their identity; changed source inputs invalidate the binding. Interactive
confirmations do not display digests. These are owner-supplied
inputs, never model-generated approval files or Issue attachments.

Example profile import without model requests:

```powershell
easy-skills config --profile-file profile.json --non-interactive --answers consent.json
```

The profile contains `name` and six exact `assignments`; consent contains
`{"profile:save": true}`. Interactive users select models from a numbered catalog
reported by the installed official CLI. Scripted `profile:model` and per-stage model
answers must use exact IDs from that catalog: menu numbers are deliberately rejected
in scripts because catalog ordering can change. Importing an explicit profile remains
available for advanced operation.

After selecting a model, choose a reasoning effort from the client's reported options.
The model's advertised default is offered for new assignments; an unavailable saved
effort needs an explicit replacement. Each stage stores its exact effort in the plan,
approval and compatibility-probe identity. `doctor --provider codex --model MODEL
--effort EFFORT --probe` validates that exact assignment. Existing assignments without
an effort retain the CLI's implicit default and their existing approval/probe identity;
edit the profile to pin one explicitly. Missing effort metadata stops with a diagnostic
rather than inventing choices. Scripted answers use effort values, not menu numbers.

Provider prompts show a numbered list; press Enter to keep the displayed available
provider. The installed Codex executable is checked before displaying the menu; login
and model access are checked separately. Claude Code is shown as unavailable when it
is missing, signed out, or managed policy configures hooks, plugins, a policy helper or extra allow rules.
Its models and effort levels come from the official client's metadata. An invalid or unavailable interactive choice
is explained and the same question is asked again. Scripted provider answers use the
exact ID (`codex` or `claude-code`) and fail clearly when invalid or unavailable.

Stage banners show each model-setup position and explain its responsibility. DEFINE
and PLAN are marked during the guided conversation; `easy-skills status` highlights
the current execution stage. Color is used only in a supported interactive terminal
and can be disabled with `NO_COLOR`; redirected output remains readable without it.

| Prompt ID | Meaning |
| --- | --- |
| `profile:reuse` | Reuse displayed saved assignments |
| `profile:name`, `profile:provider` | Name saved settings and choose the provider |
| `profile:model` | Numbered model choice interactively; exact catalog ID in scripts |
| `profile:effort`, `profile:STAGE:effort` | Numbered reasoning effort interactively; exact effort value in scripts |
| `profile:customize` | Edit individual stages |
| `profile:STAGE:provider`, `profile:STAGE:model` | Provider and numbered stage model choice; exact catalog ID in scripts |
| `model-requests` | Allow read-only interviews/planning using account quota |
| `probe:PROVIDER:MODEL[:EFFORT]` | Allow launch/resume validation for the exact assignment |
| `interview:QUESTION_ID` | Answer a model-derived unresolved question |
| `rules:approve` | Save displayed rules and commands |
| `task:specification` | Continue planning with displayed requirements |
| `task:approve` | Approve exact displayed execution/revision proposal |
| `install:approve` | Install displayed packaged skills with backups |

In an interactive terminal each interview answer is a single answer however many lines
it has: pasted text (Markdown, lists, blank lines) is collected until the input has
been quiet for 250 ms (`EASY_SKILLS_PASTE_MS` changes this). The answer is then shown
back and recorded only after confirmation: Enter accepts it, `n` discards it and asks
the same question again.

Question IDs are model-derived. Fully scripted operation needs answers to the actual
questions. Declining execution leaves local interview/planning records but creates
no branch, Issue or PR.

## Migration and limits

Existing alpha.2 configuration loads unchanged. `init` reuses a current agreement;
draft/stale agreements enter onboarding. Replacements back up managed files. Changes
invalidate old plan execution. Database schema remains v3, and previous approved
JSON is never silently upgraded. Legacy reliability contracts still need replacement
approval. See the older [migration record](reliability-implementation.md).

Claude execution stops if managed policy gains hooks, plugins, a policy helper or extra allow rules.
Saved assignments are preserved; replacement requires explicit profile editing.
Probe identity includes executable, version and execution policy; authentication is
rechecked. No direct API key is required.

Model discovery uses the official Codex app-server `initialize` / `initialized`
handshake and paginated `model/list`, with hooks, apps and MCP restrictions checked
before launch. It requests no thread or inference turn and does not read credential
stores. Hidden entries are excluded, display names are presented, and the returned
`model` identity and selected advertised reasoning effort are stored unchanged. Each profile interaction refreshes the catalog;
one interaction reuses its displayed provider list across the six stages. A catalog
can be bundled or cached by the official client, so a listed entry is not proof of
account entitlement. Existing compatibility probes still establish execution access.
Discovery errors stop with a diagnostic; no built-in model-name table is substituted.
See [the official model-list protocol](https://learn.chatgpt.com/docs/app-server#list-models-modellist).

Complex dependent work still uses advanced feature commands; automatic selection of
advanced mode is not implemented. Branch prefixes are not inferred from project
conventions. Protected instruction hashing retains an exhaustive safety scan, so
initial inventory limits do not bound total onboarding time. Interview quality,
large-project latency, Windows reboot recovery and live provider/GitHub behavior need
authorized field acceptance. The real TS Studio repository is not modified by tests.
