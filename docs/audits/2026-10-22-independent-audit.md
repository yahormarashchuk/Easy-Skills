# Easy Skills — Independent Code Audit

Date: 2026-10-22 · Branch `codex/reliable-autonomous-alpha` (uncommitted working tree on top of `fda65ec`) · Host: Windows 11, Node 24.22.0, Codex CLI 0.163.0, Claude Code 2.1.306.

During the audit, no repository file, Git state or GitHub resource was modified, and the working-tree `git status` hash was identical before and after every command. No model calls, GitHub mutations, emails or publications were made. This report and its reproduction scripts were added under `docs/audits/` afterwards.

The reproductions use temporary Git repositories, temporary state homes and fake clients/GitHub. They are in [`repro/audit-repro.test.mts`](repro/audit-repro.test.mts) (R1–R13) and [`repro/audit-repro-2.test.mts`](repro/audit-repro-2.test.mts) (R14–R15). R1–R3 run only on Windows. `npm test` and `npm run check` do not include them. Run them from the repository root:

```bash
node --import tsx --test --test-concurrency=1 docs/audits/repro/audit-repro.test.mts docs/audits/repro/audit-repro-2.test.mts
```

Each reproduction **passes while its defect is present**. When fixing a finding, invert the corresponding assertions into a regression test under `tests/`.

## Verification run

| Command | Result |
|---|---|
| `npm run check` | Pass |
| `npm test` | 62/62 pass, 150 s |
| `npm run build` | Pass. Regenerated `schemas/*.json` were byte-identical to the tracked files, so there is no schema drift. |
| Audit reproductions | 15/15 confirmed the defects described below |
| Live CLI introspection | `codex exec resume --help`, `claude --help` and `codex mcp list --json` with the runner's `--config` overrides. These read configuration only and make no model call. |

---

## 1. Executive summary

The runner's foundations are good. Durable state uses optimistic revisions, and each event is appended in the same SQLite transaction. Worktrees are owned. Nothing is force-pushed or force-removed. Evidence is bound to the exact head commit. The final merge is bound to both head and base. GitHub objects are made idempotent with markers. The notification outbox uses leases. Remote commands go through a state machine. The Windows `.cmd` metacharacter guard is in place. The existing tests use real Git, not mocks of it.

However, the autonomy and safety claims are ahead of the implementation. The 62 passing tests prove the happy path and the specific regressions they target. They do not prove the invariants that matter most once a model or a repository is uncooperative:

1. **Bounded autonomy is not guaranteed.** The "three identical failures" stop compares the hash of model-written prose. Reviewer and verifier wording differs on every attempt, so BUILD → REVIEW loops run without limit (R4: 9 BUILD runs, the failure counter stayed at 1). Infrastructure errors are treated as code-repair failures (R7). Quota interruptions during the final repair consume repair attempts (R6).
2. **Tool and permission isolation is weaker than documented.** On Windows, a `git.cmd` placed in a worktree runs instead of Git (R1). A sandboxed Codex BUILD can use this to get its code run by the unsandboxed runner, which has network access and credentials. The Codex MCP allow-list has no effect: with Codex 0.163.0, the servers the user has enabled stay enabled, and the approved server is wiped (R11 plus the live `codex mcp list` check). Runner secrets are inherited by repository checks and agents (R13). The PLAN model can add VERIFY tool grants (R12). A local `merge` needs no human-only confirmation.
3. **First-run portability is likely to fail.** The baseline runs in a fresh worktree with no dependency setup. It is recorded once, never re-captured, and the feature ID cannot be reused (R15). For a typical Node project, this blocks the first feature permanently.
4. **Recovery paths have gaps.** The detached worker exits on any escaped exception (R8). `resume` refuses runs that a crash left in `running`, yet the `easy-resume` skill tells agents to use `resume` (R9). A merge-queue entry that GitHub removed means the run waits forever (R14). Permanent errors are classified as quota or network waits (R10, R2).

**Maturity:** a solid single-operator alpha for supervised fixture-like repositories. It is not yet a dependable unattended runner. **No P0 found.** Four P1 findings, thirteen P2 findings and eleven P3 findings are below.

---

## 2. Confirmed findings

Each finding lists: location · problem · why it is wrong · evidence · expected behavior · minimal fix · regression test.

### P1 — High

#### P1-1 Windows: executables in the working directory take precedence over Git, gh and the AI clients
- **Location:** `src/process.ts:33` (`which.sync(absolute(options.cwd, spec.command))`). This is reinforced by cross-spawn and `which`, which search the current directory first on Windows.
- **Problem:** `git`, `gh` and the check commands are resolved against the worktree or project root first. A file called `git.cmd`, `git.exe`, `gh.cmd` or similar in that directory is executed instead.
- **Why it is wrong:** BUILD writes to the worktree, and repository content comes from other people. The runner itself has no sandbox, and it holds network access plus the user's GitHub and Git credentials. A Codex BUILD running in `workspace-write` (no network) can therefore escape its sandbox by writing `git.cmd`. The runner executes it on its next command, which is `git add --all` in `Git.commit`. The same applies to a `gh.cmd` in the user's checkout (`Gh` runs with `cwd = run.root`). Native Windows is the primary target platform.
- **Evidence:** R1 printed `execute stdout: PLANTED-GIT "--version" | Git.run: PLANTED-GIT "--version"`.
- **Expected:** runner-owned executables come only from trusted PATH entries, never from the repository or a worktree.
- **Fix:** resolve `git`, `gh`, `codex`, `claude` and `node` once at startup to absolute paths, searching PATH while explicitly excluding the current directory and any repository or worktree root. Always pass the absolute path, so cross-spawn does not search again. Set `NoDefaultCurrentDirectoryInExePath=1` in child environments. For check commands, reject a resolved path that lies inside the worktree unless the agreed command is an explicit relative path.
- **Test:** R1 inverted. With a planted `git.cmd`, `Git.run(['--version'])` must return real Git output, and a check resolving into the worktree must be refused.

#### P1-2 The Codex MCP allow-list does not restrict anything, and the approved server is removed
- **Location:** `src/adapters/mcp-permissions.ts:38-43` and `src/adapters/index.ts:29`. The claim being contradicted is in `docs/mcp.md`: "Codex … sets `enabled_tools` for approved servers".
- **Problem:**
  - (a) `mcp_servers={}` in a `-c` override layer does not remove servers configured in other layers.
  - (b) Server keys are emitted with JSON quotes (`mcp_servers."browser".…`). Codex treats the quotes literally and creates a server named `"browser"`.
  - (c) `args.unshift` reverses the order, so `mcp_servers={}` is applied last and wipes the approved entry.
- **Why it is wrong:** Codex PLAN, VERIFY, REVIEW and SHIP are documented as read-only with approved tools only. MCP servers run outside Codex's sandbox. On the audit host, `node_repl` and `cua_repl` remained `enabled=true` under the runner's arguments.
- **Evidence:**
  - R11 shows the generated order ends with `mcp_servers={}` and uses quoted keys.
  - Live `codex mcp list --json`, with no overrides and with the runner's overrides, showed the same four servers with the same enabled flags.
  - Placing `mcp_servers={}` first, then `"probe"`, produced a server named `"probe"`.
  - With the runner's own order, the approved server disappeared.
  - Per-server `enabled=false` overrides failed with `invalid transport` for servers that come from non-TOML layers.
- **Expected:** Codex stages expose only the approved servers and tools, or the runner refuses to claim any restriction.
- **Fix:**
  - Stop advertising the Codex restriction now: reject a non-empty `verification.browserTools` for Codex assignments.
  - Then evaluate `codex exec --ignore-user-config` (present in 0.163.0) combined with explicit definitions of only the approved servers, using bare validated keys and the intended order (`push`, not `unshift`).
  - Have `doctor --probe` verify the effective server set with `codex mcp list --json` under the exact generated arguments.
- **Test:**
  - Unit: the generated overrides contain no quoted keys, and `mcp_servers={}` is not last.
  - Opt-in probe: `codex mcp list --json` under the generated arguments lists exactly the approved servers.

#### P1-3 Repair loops are unbounded when failure messages are not byte-identical
- **Location:**
  - `src/runner/failures.ts:19-27` (fingerprint = hash of normalized `message(error)`).
  - `src/runner/engine.ts:202` (agent failures become `Error(summary + findings)`).
  - `engine.ts:251` and `engine.ts:454` (stop only when `count >= 3` for one fingerprint).
- **Problem:** REVIEW and VERIFY failures are model prose, so the fingerprint is effectively new on every attempt. Nothing else limits the number of BUILD repairs.
- **Why it is wrong:** the spec says to stop after three unsuccessful cycles without progress (§1 and §11). Every cycle consumes the user's subscription quota, so this is an unbounded cost.
- **Evidence:** R4 gave `{builds: 9, reviews: 8, failuresCount: 1}`. The stop came only from the test harness. The runner never stopped with "Three identical".
- **Expected:** a hard repair budget per task scope and per final phase, shown in the approval package. It stops even when the failures are worded differently.
- **Fix:**
  - Keep the identical-failure detector.
  - Add a persisted counter in the existing ledger key (`${run.id}:failures:${scope}`) that counts every repair BUILD for that task or final phase. It resets only on integration or final readiness, not on stage success.
  - Stop at a plan-level `maxRepairs` (default 3–5).
  - For agent-reported failures, fingerprint on stage plus outcome, not prose.
- **Test:** R4 expecting `needs_decision` with a "repair budget exhausted" reason after at most `maxRepairs` BUILD runs.

#### P1-4 The first baseline is likely to fail on real projects and can never be re-captured
- **Location:**
  - `engine.ts:120-136`: worktree created, baseline recorded once, any non-`passed` status blocks for good.
  - `templates/project.yaml` and `skills/easy-init/SKILL.md` contain no dependency setup step.
  - `tests/helpers.ts:27` uses a fixture `package.json` with no dependencies.
- **Problem:**
  - (a) Baseline checks run in a fresh `git worktree add` checkout, which holds only tracked files. `npm test` without `node_modules`, or similar, fails, and the result is classified as `pre_existing_failure`.
  - (b) The baseline result is stored once. Fixing main, installing the prerequisite or retrying never re-captures it.
  - (c) The suggested remedy ("explicitly replan") needs a new feature ID: `store.ts:66-67` blocks the same ID for any unmerged run, and `engine.ts:113` refuses the existing branch.
- **Why it is wrong:** this breaks the "Portability across technology stacks" requirement and the first-feature journey. The error text promises "resolve … then resume", which does not work.
- **Evidence:** R15. After main was fixed, the run still reported `Baseline pre_existing_failure`, and `store.create` with the same plan returned `An unfinished run already uses this feature ID`.
- **Expected:**
  - An agreed per-worktree setup step (for example `npm ci`) runs before the baseline and before checks.
  - A baseline that is unavailable or failed can be re-captured explicitly before the first BUILD.
- **Fix:**
  - Add `project.setup: Check[]`, agreed during onboarding and shown at approval. Run it after each `ownedWorktree` and before baseline or checks. Setup evidence must not count as check evidence.
  - Add `easy-skills baseline <run> --recapture`, allowed only while no task has a `head` or sessions. It records a new baseline bound to the current base head and keeps the old record as history.
- **Test:**
  - Fixture whose check needs an ignored dependency directory created by setup: the baseline passes.
  - R15 with recapture after main is fixed: the run proceeds.

### P2 — Medium

#### P2-1 Runner and infrastructure errors are counted as code-repair failures; the REVIEW diff has no size limit
- **Location:** `engine.ts:329-338` (any non-`Blocked`/`ClientError` exception during BUILD, VERIFY or REVIEW leads to `failure()`), `engine.ts:448-449` (same in the final phase), `engine.ts:163-164` (full `git diff` placed in the prompt), `src/process.ts:91` (`checked` throws on output over 1 MiB).
- **Problem:** Git lock errors, SQLite busy errors, Windows EBUSY errors and the runner's own output-capture limit all trigger BUILD repairs.
- **Evidence:** R7. A 1.7 MB generated file produced `{builds: 3, reviews: 0}`, stopping with "Three identical unsuccessful repair cycles … git output exceeded the capture limit". REVIEW never ran. Below 1 MiB, the whole diff (around 250k tokens) is sent in the prompt.
- **Expected:** only `CheckFailure` and an agent `failed` outcome lead to repair. Everything else stops with a precise cause. REVIEW input is bounded.
- **Fix:**
  - Add one stage-error classifier used by both catch blocks.
  - For REVIEW, send `git diff --stat` plus a patch capped at about 200 KB with a truncation note, and let the read-only reviewer read the files.
- **Test:** R7 expecting REVIEW to run with a truncated diff and no repeated BUILD. Inject a Git failure and expect `needs_decision` with no repair.

#### P2-2 Quota or network interruptions during the final repair BUILD consume repair attempts
- **Location:** `engine.ts:448-458`. The failure is recorded before BUILD runs, and `finalPhase` stays `VERIFY`/`REVIEW` while BUILD is retried.
- **Evidence:** R6 gave states `['waiting_quota','waiting_quota','needs_decision']`, `finalBuildAttempts: 2` (both hit the quota error) and zero completed repairs. The reason was "Three identical unsuccessful whole-feature repairs".
- **Why it is wrong:** "Quota waiting and network retries do not consume code-repair attempts" (spec §11). The task flow already handles this correctly by moving the cursor to BUILD first.
- **Fix:** persist the repair intent (for example `finalPhase: 'REPAIR'`, or a stored flag) before calling BUILD, so a resume continues at BUILD without running checks again or recording the failure again.
- **Test:** R6 expecting a resumed BUILD and `failures.count === 1`.

#### P2-3 Repair prompts carry a stale check-failure bundle from another task or failure
- **Location:** `engine.ts:230` (the only writer, run-scoped key `${run.id}:failure-bundle`), read at `engine.ts:271` and `engine.ts:455`. It is never cleared.
- **Evidence:** R5. A REVIEW failure in task two was repaired with a prompt containing `{"checkId":"acceptance",…,"exitCode":1,"classification":"regression"…}` from task one's earlier check failure.
- **Fix:** store the bundle per failure scope, clear it on progress or integration, and include it only when the current error is a `CheckFailure`.
- **Test:** R5 expecting no bundle in task two's repair prompt.

#### P2-4 The detached worker exits on any escaped exception
- **Location:** `src/runner/worker.ts:39-44` (no try/catch around `engine.run`). `engine.ts:55` acquires the run lock outside the try block.
- **Evidence:** R8. With the run lock held, as `easy-skills sync`, `merge`, `cleanup` or `start --foreground` do from another terminal, the worker rejected with `ResourceBusy`, released its own lock, and left the run `approved` with nothing executing.
- **Expected:** the supervisor loop contains failures. `ResourceBusy` leads to wait and retry. Other errors are recorded as an event, set `needs_decision`, send a notification, and the loop continues.
- **Test:** R8 expecting the worker to stay alive and run once the lock is released.

#### P2-5 `resume` refuses a run that a crash left in `running` or `approved`; the skill tells agents to use `resume`
- **Location:** `src/cli/index.ts:124` and `skills/easy-resume/SKILL.md:15`. The README says to use `start`.
- **Evidence:** R9 — `{exit: 1, stderr: 'Run is not resumable'}` for a run whose status was left at `running`.
- **Fix:** let `resume` accept `running` and `approved` when no live `worker:` lock and no live child exist, so it is equivalent to `start`. Align the skill and README.
- **Test:** R9 expecting `starting` or `attached`.

#### P2-6 A removed merge-queue entry or a failed async merge leaves the run waiting indefinitely
- **Location:**
  - `engine.ts:365`: a prior `enqueued` intent always raises `ClientError('network')`.
  - `engine.ts:366-370` and `github/index.ts:100`: a GET of an async operation that returns `failed`, or 404 after its 24-hour retention, is not reconciled.
- **Evidence:** R14. After one `enqueued` response with the PR still open, four runs all reported `waiting_quota: Merge queued…`, and only one merge request was ever sent. GitHub's documentation confirms that results expire after 24 hours and that `failed` is a terminal status.
- **Why it is wrong:** removal from a merge queue after CI fails is routine. The user is told "waiting" forever.
- **Fix:** when the prior state is `enqueued` or `pending`, query the operation by UUID, or `mergeQueueEntry` through GraphQL. On `failed`, dequeued or 404, stop with `needs_decision` and allow a fresh request for the same head after an explicit decision.
- **Test:** a fake GitHub that reports dequeued or failed must give `needs_decision`.

#### P2-7 Error classification uses substrings; GitHub authentication failures become network waits
- **Location:** `src/adapters/index.ts:14-22` and `src/github/index.ts:32-35`.
- **Evidence:**
  - R10: `"Error: context window limit reached"` → quota; `"FAIL tests/orders.test.ts:429 …"` → quota; `"Assertion failed: network adapter …"` → network.
  - R2: `gh` with "please run: gh auth login" and exit code 4 → `ClientError('network')`.
- **Why it is wrong:** permanent failures become `waiting_quota` with exponential backoff up to 4 hours, without end.
- **Fix:**
  - Classify from structured signals: provider event types or codes, HTTP status, and `gh` exit codes (4 means authentication).
  - Anchor the regular expressions.
  - Add a limit: after N waits with the same reason, stop with `needs_decision`.
- **Test:** a classification table, plus a `gh` exit-4 fixture expecting `auth`.

#### P2-8 Windows: Claude Code installed through npm (`claude.cmd`) cannot be used
- **Location:** `src/adapters/index.ts:42-48` (`--json-schema` with quotes and commas, `--allowedTools` with commas) and `src/process.ts:38`.
- **Evidence:** R3 resolved `…\claude.CMD`, and every `CliClient.run` rejected with `Unsafe metacharacter argument`. Codex has a node-entry workaround (`adapters/index.ts:34-36`); Claude does not. `doctor` without `--probe` still reports the client as installed and authenticated.
- **Fix:** resolve the shim's JavaScript entry point and run it through `node`, or require the native executable and have `doctor` report the problem explicitly.
- **Test:** R3 expecting either a node-entry invocation or a clear `doctor` diagnostic.

#### P2-9 Runner secrets are inherited by AI clients and repository checks
- **Location:** `src/process.ts:49` (`env: options.env || process.env`; no caller passes a reduced environment) and `src/cli/index.ts:45` (worker inherits the full environment). The SMTP password environment variable read at `src/notifications/index.ts:20` is therefore visible to all children.
- **Evidence:** R13 — `child saw: audit-fixture-secret`.
- **Fix:** add a child-environment builder:
  - Drop the configured `passwordEnv` and the MCP `bearerTokenEnv` values for every child.
  - Drop `GH_TOKEN`/`GITHUB_TOKEN` and `*SECRET*`/`*TOKEN*`/`*PASSWORD*` variables for checks and agents.
  - Pass the minimum to `gh` and the clients, which authenticate through their own credential stores.
- **Test:** R13 expecting `undefined`.

#### P2-10 PLAN-introduced VERIFY capability grants bypass the protected-field check
- **Location:** `src/runner/planning.ts:40` (protected list omits `verification`), `planning.ts:13-14` (`FeatureRequest` cannot express `verification`) and `contracts.ts:52`.
- **Evidence:** R12. A PLAN result with `browserTools: ['mcp__github__merge_pull_request']` was accepted.
- **Why it is wrong:** the planner is meant not to expand permissions (that is the name of the existing test). The only source of `verification` is the model.
- **Fix:** add `verification` to `FeatureRequest` as a user choice and to the protected list.
- **Test:** R12 expecting "changed an agreed field: verification".

#### P2-11 Agent-writable instructions and client configuration are neither hash-bound nor detected
- **Location:** `src/util.ts:42-49` (rules hash covers only root AGENTS/CLAUDE and `.easy-skills/rules`), `src/runner/context.ts:48` (nested `AGENTS.md`/`CLAUDE.md` injected as mandatory context), `engine.ts:272` (`git add --all` commits whatever BUILD wrote).
- **Problem:**
  - Nested instruction files become mandatory prompt content without agreement.
  - BUILD can change `AGENTS.md`, `CLAUDE.md`, `.easy-skills/**`, `.claude/settings.json` or `.codex/**` inside its worktree. Native clients load those files in later stages (the runner does not use `--bare`). The changes ship in the PR without the runner noticing.
  - `checkpoint()` hashes only the user's root checkout.
- **Status:** verified from code. Whether each client loads worktree hooks and settings in `-p`/`exec` mode needs a live probe (see H4).
- **Fix:**
  - Include nested instruction files in `rulesHash`, or do not inject them.
  - After each write stage, stop with `needs_decision` if the diff touches a protected-path list.
- **Test:** BUILD edits `.easy-skills/rules/x.md` and must be blocked before VERIFY.

#### P2-12 Local final merge, plan approval and cleanup are not tied to a human
- **Location:** `src/cli/index.ts:117-118` (approve), `:133-134` (merge) and `:139-140` (cleanup). Compare `src/runner/remote.ts:40-50`, which uses an email code.
- **Problem:** any process with a shell, including another feature's BUILD agent, can run `easy-skills merge <run> --head <sha>`. The one-time code protects only the remote path.
- **Why it is wrong:** spec §11 requires confirmation that is not available to agents for decisions that expand permissions.
- **Fix:** require an interactive TTY and a typed confirmation of the run and short head (agent shell tools have no TTY), or the email code for local merges too.
- **Test:** spawning `merge` with non-TTY stdin must be refused.

#### P2-13 A blocked run cannot be abandoned or replaced
- **Location:** `src/persistence/store.ts:66-67` (feature ID uniqueness covers stopped and blocked runs) and `engine.ts:113` (the existing branch is refused).
- **Problem:** rule changes, failed baselines and legacy migration all ask for a "replacement plan", which forces a new feature ID and abandons the existing branch.
- **Evidence:** R15 (second assertion).
- **Fix:** add `easy-skills abandon <run>`: a terminal status that frees the feature ID and keeps resources until cleanup. Add an explicit, recorded ownership transfer of the branch and worktrees to a replacement run with the same base.
- **Test:** abandon, then create a replacement with the same feature ID; the replacement adopts the owned branch.

### P3 — Low

| ID | Location | Problem → minimal fix → test |
|---|---|---|
| P3-1 | `notifications/index.ts:38,41` | The subject uses the raw state (`needs_decision`), not the spec format ("Decision required", "Waiting for quota recovery", "Ready for final verification"). SMTP errors are swallowed silently with no attempt cap. → Map state to subject; record a redacted `notification.failed` event; show pending or failed counts in `status`. → Subject table test; a failing transport records an event. |
| P3-2 | `github/index.ts:41-46,116-123`; `remote.ts:59` | Every Issue creation scans all repository issues; every 15-second poll fetches all parent-issue comments. This risks rate limits on large repositories. → Use `creator=@me&sort=created&since=<intent time>`, and `since=` for comments. → Count fake-API calls. |
| P3-3 | `engine.ts:192-198` | Model-written questions are posted publicly without `redact` or `cleanExcerpt`. → Clean them before `commentOnce`. → A question containing a `ghp_` token is posted redacted. |
| P3-4 | `engine.ts:180-181`; `adapters/index.ts:40-41`; `context.ts:13-19` | VERIFY diagnostic permissions are exact `Bash(...)` strings that the agent is never told. JSON-escaping doubles Windows backslashes. `(x86)` paths throw at invocation time and count as a repair. → List the permitted commands in the VERIFY prompt; validate when the plan is drafted. |
| P3-5 | `engine.ts:94-99` | `ResourceBusy` shares the quota backoff (up to 4 hours) and the `waiting_quota` label. → Short fixed retry and a distinct reason. |
| P3-6 | `store.ts:101,120-123`; `cli/index.ts:39` | Liveness is checked by PID only. After a reboot, PID reuse makes `start` report `attached: true` with no worker running. → Store the process start time with locks; add a lock diagnostic. |
| P3-7 | `skills/easy-plan/SKILL.md:15,21`; `context.ts:12,20`; `cli/index.ts:106-107` | The PLAN stage prompt includes orchestration steps (`feature plan`, `draft`, `approve`, `start`). "Produce spec.md, plan.md and execution.yaml" conflicts with `feature draft` refusing files that already exist. → Use a stage-only procedure reference for PLAN; drop the instruction to produce those files. |
| P3-8 | `remote.ts:63-65` | A malformed `/easy-skills …` comment (for example mobile curly quotes) is ignored with no feedback. → Reply once to allowlisted authors. |
| P3-9 | `engine.ts:297` | Each task makes a read-only SHIP model call with no deterministic effect, which costs tokens. → Make it optional or final-only. |
| P3-10 | `engine.ts:272,299` | After an agent stage, nothing checks that the worktree is still on its owned branch. → Check `symbolic-ref` after every stage. |
| P3-11 | `git/index.ts:85` | Cleanup refuses ignored files, so it will always refuse once dependencies are installed per worktree (P1-4). This is documented, but it makes cleanup manual in practice. → Offer a reviewed removal of ignored outputs produced by the agreed setup. |

### Hypotheses that need live, authorized validation (not confirmed defects)

- **H1** — `adapters/index.ts:75-80,116`: the strict `modelUsage` and assistant-model equality check may reject legitimate Claude runs when Claude Code uses an auxiliary model internally, for example during Bash tool use. The only live probe was tool-free. Probe a BUILD-like task that uses Bash.
- **H2** — `adapters/index.ts:70,128`: a Codex `error` event emitted for an internally retried stream marks a later successful turn as failed.
- **H3** — `context.ts:57-59`: after client-side auto-compaction, the "unchanged in this exact session" placeholders may refer to content the model no longer has.
- **H4** — the worktree's `.claude/settings.json` hooks and `.codex/config.toml` may be honored by later read-only stages (see P2-11).
- **H5** — `github/index.ts:71`: GitHub's `base.sha` can lag the base branch, causing spurious "PR base changed" stops.

---

## 3. Requirements coverage

| Requirement | Status | Notes |
|---|---|---|
| Onboarding and approved rules | Implemented | Structured agreement with hashes. Nested instruction files are not covered (P2-11). |
| Requirements interviews | Partial | Procedure and six evaluation cases exist; never run against a model. |
| Provider/model per stage | Implemented | Exact IDs, compatibility probes. Model-identity check is unverified live (H1). |
| Autonomous execution | Partial | Happy path works. Unbounded loops (P1-3), worker fragility (P2-4), baseline portability (P1-4). |
| Deterministic verification | Implemented | Head-bound evidence; prose never counts as a passing check. |
| Independent review | Partial | Separate session and assignment. Diff unbounded and fails above 1 MiB (P2-1). |
| Parent/child Issues, sequential dependencies | Implemented | Dependencies require a merged PR whose head was reviewed. |
| Integration branch, owned worktrees | Implemented | Branch not asserted after stages (P3-10). |
| Intermediate PR merge | Implemented, not verified live | Needs strict protection and CI on `feature/*` branches, which onboarding does not check. Queue terminal states are not handled (P2-6). |
| Conflict resolution and semantic compatibility | Implemented | Recovery refs, merge preserved when ambiguous, checks and review repeated. |
| Final merge authorization | Partial | Head- and base-bound. Local path is not tied to a human (P2-12). |
| Main-branch movement | Implemented | Task sync, final sync, readiness revocation. |
| Safe cleanup | Implemented | Conservative; refuses ignored files in practice (P3-11). |
| Quota wait and resume | Partial | Exact session preserved. Misclassification (P2-7) and quota consuming repairs in the final phase (P2-2). |
| Crash recovery / orphans | Partial | Live-child guard. `resume` gap (P2-5); worker containment (P2-4); PID reuse (P3-6); no physical reboot test. |
| Email notifications | Partial | Outbox works. Subjects not in spec format; failures invisible (P3-1); not verified live. |
| Remote management | Implemented | Allowlist, binding and replay protection. Malformed commands get no feedback (P3-8). |
| Tool and permission isolation | Weak | P1-1, P1-2, P2-9, P2-10, P2-11. |
| Simple installation | Partial | Bootstrap preview and apply. npm-installed Claude broken on Windows (P2-8); not published to the registry. |
| Portability across stacks | Partial | No dependency setup step (P1-4); fixtures have no dependencies. |
| Skills | Implemented | 13 skills with shared references. PLAN procedure conflict (P3-7); `easy-resume` versus CLI (P2-5). |

---

## 4. Testing gaps (important untested failure scenarios)

1. Non-identical repeated REVIEW or VERIFY rejections (R4), and a total repair budget.
2. Infrastructure errors during BUILD, VERIFY or REVIEW (Git lock, SQLite busy, EBUSY, oversized diff) (R7).
3. Quota or network interruption during the final repair BUILD (R6).
4. Worker supervisor behaviour under `ResourceBusy` or an escaped error (R8); concurrent CLI `sync`/`merge` while a worker is active.
5. Crash-state CLI flows: `resume` from `running` or `approved` (R9); PID reuse after reboot.
6. Codex MCP effective server set (R11). Today only argument strings would be checkable; there is no semantic test at all.
7. Windows: executable planting in cwd (R1); npm-installed Claude shim (R3).
8. Child-environment secret exposure (R13).
9. Planner-introduced permissions other than `permissions` (R12).
10. Merge queue: dequeued, async `failed`, 24-hour expiry (R14).
11. Baseline with real dependencies, re-capture, and reuse of a feature ID (R15).
12. Classification table for real Codex, Claude and `gh` error texts and exit codes (R10, R2).
13. Agent edits to instruction, rules or client-configuration paths; agent switching branches in the worktree.
14. Crash between `git commit` and the state save in `sync()` / `syncTask()`.
15. Live contract tests, opt-in and outside public CI: Claude BUILD with Bash (H1), Codex transient errors (H2), GitHub protection and queue behaviour on `feature/*`.

---

## 5. Architecture improvements (only those with a clear correctness benefit)

1. **One stage-error taxonomy** used by `task()` and `finish()`: `CodeFailure` (`CheckFailure` or an agent `failed`) leads to repair within a persisted budget; `Wait` (quota, network, resource busy) is retried with its own limited budget; everything else stops with a cause. This fixes P1-3, P2-1, P2-2 and P2-7 together.
2. **A trusted execution context created at worker start:** absolute executable paths resolved without the cwd, and a child-environment builder for each kind of child (git, gh, agent, check). This fixes P1-1, P2-8 and P2-9.
3. **A protected-path guard after write stages**, and hash coverage for every instruction source the runner injects (P2-11).
4. **A worker supervisor loop with containment**, and `resume` consistent with `start` (P2-4, P2-5).
5. **An explicit `setup` phase and baseline re-capture** in the contract (P1-4), plus `abandon` with ownership transfer (P2-13).

No rewrite is recommended. `engine.ts` is dense (lines over 200 characters, repeated `new Git(... withLock)` and `options.github || new Gh(...)`). Extract helpers only while touching those lines.

---

## 6. Prioritized implementation plan for Codex

Run `npm run check`, `npm test` and `npm run build` after each step, and add the named regression test before the fix.

1. **Bounded repairs (P1-3, P2-1, P2-2, P2-3).** Files: `src/runner/failures.ts`, `src/runner/engine.ts`.
   - Add a `classifyStageError()` used in both catch blocks.
   - Add a persisted repair budget per scope, with `maxRepairs` in `Plan` (default 3) that is shown at approval.
   - Add a final-phase `REPAIR` intent before BUILD.
   - Store the failure bundle per scope and clear it.
   - Bound the REVIEW diff.
   - Tests: R4, R5, R6, R7.
2. **Trusted execution (P1-1, P2-8, P2-9).** Files: `src/process.ts`, `src/adapters/index.ts`, `src/github/index.ts`, `src/git/index.ts`, `src/cli/index.ts`.
   - Resolve absolute paths excluding the cwd and repository roots.
   - Add the child-environment builder.
   - Add the node entry point for npm-installed Claude, or a `doctor` refusal.
   - Tests: R1, R3, R13.
3. **Codex MCP honesty (P1-2).** Files: `src/adapters/mcp-permissions.ts`, `src/contracts.ts`, `docs/mcp.md`.
   - Reject Codex `browserTools` now.
   - Remove the `mcp_servers={}` claim, fix key quoting and order.
   - Add an opt-in `codex mcp list --json` probe.
   - Test: R11 inverted.
4. **Baseline and setup (P1-4, P2-13).** Files: `src/contracts.ts`, `src/runner/engine.ts`, `src/cli/index.ts`, `src/persistence/store.ts`, `templates/project.yaml`, `skills/easy-init/SKILL.md`.
   - Add `project.setup`, `baseline --recapture` and `abandon` with ownership transfer.
   - Tests: R15 inverted; a fixture with an ignored dependency directory.
5. **Supervisor and resume (P2-4, P2-5).** Files: `src/runner/worker.ts`, `src/cli/index.ts`, `skills/easy-resume/SKILL.md`, `README.md`.
   - Tests: R8 and R9 inverted.
6. **Classification and merge terminal states (P2-6, P2-7).** Files: `src/adapters/index.ts`, `src/github/index.ts`, `src/runner/engine.ts`.
   - Use structured signals and a wait budget; reconcile async `failed`, 404 and dequeued.
   - Tests: R2, R10, R14 inverted.
7. **Authority boundaries (P2-10, P2-11, P2-12).** Files: `src/runner/planning.ts`, `src/util.ts`, `src/runner/context.ts`, `src/runner/engine.ts`, `src/cli/index.ts`.
   - Protect `verification`; hash nested instructions; add the protected-path guard; add TTY confirmation for merge, approve and cleanup.
   - Tests: R12 inverted plus new ones.
8. **P3 backlog** (notification subjects and failure events, GitHub scans with `since=`, redacting questions, VERIFY diagnostic discoverability, resource backoff, PID start times, PLAN procedure split, feedback on malformed commands, optional SHIP call, branch assertion, cleanup of setup outputs).
9. **Live opt-in validation** for H1–H5 on Windows with both providers, before any broader alpha announcement. Record the results in `docs/provider-compatibility/README.md`.

---

## 7. Release readiness

**Not ready for broader alpha testing.** It is suitable for maintainer-supervised dogfooding on a trusted, throwaway repository: native-installer Claude or Codex, small diffs, setup steps folded into the checks, and someone watching quota use.

Conditions that block a broader alpha:
1. Steps 1–6 of the plan done: P1-1 to P1-4 and P2-1 to P2-7 fixed, with their regression tests in CI on Windows and Linux.
2. The documentation corrected wherever it currently overstates behaviour, until the fixes land: the Codex MCP restriction (`docs/mcp.md`), "three identical failures" as a cost bound (README), and `resume` after reboot (`easy-resume`).
3. At least one authorized live end-to-end run per provider on native Windows: a feature with a dependency-requiring check, one REVIEW rejection, one quota interruption and one main-branch movement. It must also resolve H1 and H2.
4. Branch protection and CI requirements for `feature/*` checked during onboarding, so that the first intermediate merge does not stop unexpectedly.

Until then, the hosted CI result from the release commit and the 62 local tests should not be presented as evidence of autonomous reliability.
