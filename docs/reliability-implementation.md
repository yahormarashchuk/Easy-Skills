# Reliability implementation — 0.1.0-alpha.2

Baseline: `0899a374e8f25267ecf7f043c047cd10fb615674`, branch
`codex/reliable-autonomous-alpha`. Implementation started from a clean checkout.
This is an unreleased working tree. The independent audit and its defect-presence
reproductions remain historical inputs, outside the normal test suite.

## Finding ledger

All confirmed baseline defects below were checked against the current source.
"Fixture verified" means deterministic local evidence, not provider or GitHub
acceptance. The source regressions live under `tests/` and run through `npm test`.
The existing GitHub transport already recognized failed merge responses; this
implementation extends monitoring/recovery instead of claiming that handling was
absent. The historical R1–R15 defect assertions were not copied into CI: their
matching regressions assert the corrected behavior.

| Finding | Baseline evidence | Implementation | Regression evidence | Status |
| --- | --- | --- | --- | --- |
| P1-1 | R1, cwd-first lookup | Absolute tool discovery in fixed installation directories or reviewed external configuration; no arbitrary PATH lookup | execution-security: planted cwd and poisoned PATH | Fixture verified |
| P1-2 | R11, ineffective MCP reset | Enumerate actual Codex servers, replace each with a complete disabled definition, verify the effective set; hooks/apps disabled; named grants refused | execution-security effective-set fixture; configuration-only installed Codex check | Empty grants verified locally; real model validation outstanding |
| P1-3 | R4, changing REVIEW prose | Explicit total completed-repair policy in new plans, alongside identical failure identities | reliability-regressions changing prose/SHA | Fixture verified |
| P1-4 | R15, permanent failed baseline | Approved setup, fingerprints, child identity/resource locks, explicit recapture with history before implementation | setup/dependency and baseline recapture regressions | Fixture verified |
| P2-1 | R7, oversized diff becomes repair | Only typed code/check failures repair; complete file-by-file review with persisted coverage; oversized/binary inputs stop | oversized file regression | Fixture verified; unsupported file sizes require a decision |
| P2-2 | R6, final repair loses intent | Persist REPAIR before BUILD; interruption retains its ID/session; atomic completion/cursor update | final repair interrupted twice by quota | Fixture verified |
| P2-3 | R5, run-global stale bundle | Bundle belongs to its specific task/feature repair ID | second-task REVIEW repair excludes first-task bundle | Fixture verified |
| P2-4 | R8, escaped contention | Supervisor contains execution errors; no mutation of another run-lock owner; best-effort error reporting | contention regression | Fixture verified |
| P2-5 | R9, resume rejects running/approved | Consistent resumable states and attached-worker detection | CLI approved/running/ready tests | Fixture verified; physical reboot outstanding |
| P2-6 | R14, enqueued short circuit | Separate submission, async observation, actual queue membership and actual PR outcome; terminal/ambiguous submissions require a decision | dequeued regression; failed/404 monitor tests | Fixture verified; real GitHub acceptance outstanding |
| P2-7 | R2/R10, substring classification | Structured provider status/codes, gh exit 4, anchored fallback messages, typed stop reasons and separate waits | execution-security classification table | Fixture verified |
| P2-8 | R3, npm Claude shim | Verified official package entry point through the current Node executable; unsupported shims refused | Windows JSON/metacharacter argv regression | Fixture verified; real Claude launch remains blocked by isolation |
| P2-9 | R13, inherited secrets | Purpose-specific configurable environments; SMTP excluded from project/client/MCP children; public text redaction | credential profiles and child process regression | Fixture verified; no claim of complete arbitrary-secret detection |
| P2-10 | R12, planner expands VERIFY grants | User-supplied verification field protected in PLAN, including missing/empty cases | planning grant-expansion tests | Fixture verified |
| P2-11 | Mutable nested instructions/config | Hash nested instructions and client controls; guard actual worktree before/after writes and conflict repair; protect project/agreement controls | instruction mutation regression | Fixture verified; Claude managed hooks fail closed |
| P2-12 | Audit proposes mandatory TTY | Explicit local confirmation remains the product contract | Existing approval/head/hash gates retained | Not reproduced as a specification defect; TTY not introduced |
| P2-13 | R15, no replacement | Abandon retains resources/history; unresolved external intents block abandonment; replacement receives fresh branches/worktrees/documents and approval | baseline/abandon regression | Fixture verified; automatic adoption excluded |
| P3-1 | Raw subject and invisible failure | State-specific subjects, redacted failure event, status pending/retrying counts | Outbox SMTP boundary/subject/redaction/retry tests | Fixture verified |
| P3-2 | Full scans and excessive polling | One persisted network scheduler; comment cursor uses server update timestamps and does not advance past transient commands | scheduler call counts; remote replay tests | Partial: Issue marker recovery still uses a complete paginated scan |
| P3-3 | Raw public question | Shared redaction on Issue, PR, question and email boundaries | Public model question and SMTP boundary regressions | Fixture verified |
| P3-4 | Undisclosed/fragile diagnostics | VERIFY sees exact command arrays; permission arguments remain distinct argv entries; spaces/Unicode/(x86) accepted by renderer | adapter protocol tests | Fixture verified; actual Claude matching needs separate validation |
| P3-5 | ResourceBusy uses quota wait | Short resource wait and distinct state/reason | supervisor/resource branches | Implemented |
| P3-6 | PID reuse | OS birth identity on Windows; boot/start identity on Linux; unknown live owners remain conservative | store PID reuse regression | Fixture verified |
| P3-7 | Recursive PLAN procedure | Internal PLAN resource returns data; CLI alone owns attempt documents | planning tests; packaged resource map | Implemented |
| P3-8 | Malformed command silence | One syntax reply to an allowlisted author; ordinary prose ignored | remote durable syntax regression | Fixture verified |
| P3-9 | Audit proposes removing SHIP | Preserve agreed SHIP judgment | Full workflow fixture includes SHIP | Not reproduced as a specification defect; SHIP retained |
| P3-10 | Branch switch unnoticed | Path, owner intent, branch, common Git directory and registration checks | branch-switch regression | Fixture verified |
| P3-11 | Ignored setup outputs block cleanup | Optional exact inventory of unchanged setup-owned files; separate cleanup proposal hash; other ignored data blocks removal | dependency setup/cleanup regression | Fixture verified |
| N1 | Check can become no-op | Approved verification/control manifest; legitimate changes use a replacement approval | no-op check regression | Fixture verified; hashes do not prove all semantic weakening |
| N2 | Idle/merge retries ignore delay | Persisted poll deadlines; preserve in-flight authorization/evidence during target movement and block competing sync | controlled-clock scheduler; base movement during in-flight merge | Fixture verified |
| N3 | Undrained MCP stderr | Drain immediately before initialization and throughout calls | 4 MiB before init and during call | Fixture verified |
| N4 | New rules block historical merge | Record an already completed merge against saved approval/head/target/evidence before checking permission for new actions | completed merge after root-rule change | Fixture verified |
| N5 | Final review reproduced the same digest for byte `ff` and UTF-8 text `/w==` | Tag binary and UTF-8 content before hashing; preserve CRLF normalization only for UTF-8 | protected-input byte/encoding regression in failures.test.ts | Fixture verified |

## Changed implementation files

- Execution boundaries: `src/execution.ts`, `src/process.ts`,
  `src/process-identity.ts`, `src/git/index.ts`, `src/git/remotes.ts`,
  `src/adapters/index.ts`, `src/adapters/mcp-permissions.ts`,
  `src/integrations/mcp.ts` and `src/integrations/mcp-proxy.ts`.
- Integrity and recovery: `src/runner/engine.ts`, `src/runner/protected-inputs.ts`,
  `src/runner/repairs.ts`, `src/runner/setup-outputs.ts`, `src/runner/worker.ts`,
  `src/runner/remote.ts`, `src/runner/cleanup.ts`, `src/runner/planning.ts`,
  `src/runner/context.ts`, `src/runner/compatibility.ts`, `src/github/index.ts`,
  `src/notifications/index.ts`, `src/persistence/store.ts` and `src/util.ts`.
- Contracts and entry points: `src/contracts.ts`, `src/cli/index.ts`,
  `src/cli/project.ts`, `src/cli/bootstrap.ts`, `src/skills.ts`, package metadata,
  generated `schemas/`, project/feature templates and the four updated skills.
  `skills/_shared/plan-stage.md` is the new internal PLAN resource.
- Tests: new `tests/integration/execution-security.test.ts` and
  `tests/recovery/reliability-regressions.test.ts`; existing adapter, CLI, planning,
  MCP, merge, migration, outbox, remote, store, ready-worker and unit suites were
  extended. Shared fixtures now require explicit local remote/client injection;
  `scripts/package-acceptance.ts` uses the installed compiled implementation.
- Documentation: README, runner architecture, implementation status, installation,
  MCP, merge gate, provider compatibility and validation instructions.

## Contracts and migration

- Package/runtime/skills version: `0.1.0-alpha.2`.
- New project/plan generation: schemaVersion 2. Setup, protected inputs, capabilities
  and total completed repairs belong to the reviewed plan. Default three applies
  only when drafting a new request; it is never inserted into an old approval.
- A repair completes after validated BUILD output, protected/ownership guards and
  the runner-owned commit succeed. Each repair ID counts once. Quota, network,
  authentication and process interruptions do not complete it. A blocked/refused
  corrective BUILD stops for a decision. An initial BUILD is not a repair. The total
  is per task scope and, separately, per final feature scope; prose or SHA changes
  never reset that scope's completed count.
- SQLite schema 3 adds process birth identity. Migration backs up the database,
  rechecks under BEGIN IMMEDIATE and preserves run JSON, approvals and pending
  operations. Old v1 plans remain readable and unchanged, but execution requires a
  replacement approval. The preceding schema-2 binary rejects schema 3.
- Compatibility keys include the versioned adapter execution policy. Old probes
  do not authorize the changed flags/isolation policy merely because path/version
  match. Fresh model probes require separate authorization.
- New run states include `waiting_resource`, `waiting_external` and `abandoned`.
  Stop reasons and REPAIR cursors are persisted. `status` includes notification
  pending/retrying counts. Existing completed evidence is never inferred anew.
- A replacement keeps old documents and resources and gets a fresh branch name
  and task branches. Documents are written by `feature draft` under
  `.easy-skills/features/FEATURE/attempts/RUN/`.
- Protected digests distinguish binary from UTF-8 content. Any draft made by an
  intermediate, unreleased build using the earlier digest representation must be
  regenerated and approved again. Existing approved JSON and hashes are never
  rewritten to accommodate this change; a mismatch stops execution.

## Client restrictions and remaining validation

The installed Codex 0.163.0 configuration-only check succeeded after generating
complete inert server definitions: all four discovered servers disabled, hooks and
apps disabled. No server was initialized and no model request was made. The initial
leaf-only override failed to parse its transport, and was corrected before use.
Every actual launch rechecks its effective configuration. Named Codex MCP grants
remain unsupported and stop explicitly.

Real Claude launches are disabled. The official safe-mode description preserves
managed hooks; neither inspecting local files nor checking tools after initialization
proves their exclusion before a SessionStart hook. `doctor` reports installation and
authentication separately from `isolation: false`. There is no bypass switch or
provider substitution. Preserving official subscription authentication rules out
using bare mode as a shortcut. An authorized client isolation investigation and an
enforceable pre-execution contract are required before enabling real Claude again.
See the [official Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
for the safe-mode/managed-policy boundary. No new real-client behavior is inferred
from that documentation alone.

H1 (auxiliary models), H2 (actual transient Codex streams), H3 (compaction context),
H4 (native hooks/settings) and H5 (GitHub base observation timing) remain live
hypotheses, not confirmed observations. Synthetic completed-turn recovery is tested
for H2. The runner resends current context instead of depending on delta placeholders
for H3. H4 is mitigated by verified Codex flags and Claude refusal. H5 retains the
conservative base check. No real model, GitHub mutation, email or publication was
performed for this implementation.

Issue creation still reconciles stable markers through a complete paginated scan.
Changing this safely needs a durable lookup index or a server-derived creation
boundary; a creator filter or local-time cursor could miss an existing Issue after
credential/clock changes. That optimization remains open. Comment polling already
uses server timestamps, overlap and replay protection.

Other limits: file review stops above the supported per-file capture bound or for
binary changes; setup retries with partial outputs require reviewed intervention;
protected-file changes require a replacement plan; unknown live process identities
remain conservative. Host agents with broad shell access are not absolutely isolated
from the user's machine.

## User journey

1. Install the new tarball and run `bootstrap`/`doctor` without probes. Install skills
   through its reviewed proposal. Explain unsupported client isolation before launch.
2. `easy-init` handles the interview, prepares project v2, setup and protected inputs,
   and records rules agreement. For an existing project, preview/apply
   `project-config --file PROJECT.yaml`, renew agreement and commit the selected base.
3. `easy-feature` resolves requirements, CLI/model choices and capabilities. Preserve
   exact choices. Only run fresh launch/resume probes after authorization.
4. `feature plan --file REQUEST.yaml --out execution.yaml` returns an unapproved plan.
   Internal PLAN does not orchestrate itself or write draft documents.
5. `feature draft --file execution.yaml` owns document creation. Review its complete
   plan and hash; `feature approve RUN --hash HASH` is the one feature approval.
6. `start RUN` begins setup, baseline and sequential task execution. `resume RUN`
   recovers approved/running/waiting/paused/decision states and reattaches ready
   monitoring. It refuses draft, stopped, merged and abandoned runs.
7. Before implementation, `baseline RUN --recapture BASE_SHA` previews a clean
   fast-forward and preserves old results; apply with `--apply-hash HASH`.
   `setup-reset RUN --worktree integration` (or task ID) previews a retry against
   retained partial outputs. It also requires the reviewed apply hash.
8. Final merge still needs `merge RUN --head REVIEWED_SHA` or the bound remote
   confirmation. Terminal merge attempts can be reviewed through
   `retry-merge RUN --pr NUMBER --head SHA`; apply only its exact hash. Ambiguous
   requests must first be reconciled, never resubmitted blindly.
9. `abandon RUN` preserves data and permits a separately approved replacement after
   outstanding external operations are accounted for. It never adopts old sessions.
10. After actual final merge, preview/apply cleanup. `--setup-outputs` includes only
    unchanged ignored files created by approved setup in the exact proposal.

## Acceptance record

Implementation began on 2026-10-22 and verification resumed on 2026-10-27. The
97-file source/test/package fingerprint matched the interrupted checkpoint before
the additional encoding regression above was fixed. The suite uses explicit
CLI/GitHub/SMTP fixtures, temporary real Git repositories and local MCP servers;
it does not use account quota. Linux verification uses Ubuntu under WSL with a
temporary, checksum-verified Linux Node 24.22.0 runtime. WSL is not a product
requirement. Windows also uses Node 24.22.0.

| Command or diagnostic | Platform | Result |
| --- | --- | --- |
| `npm run check` | Windows and Linux | Pass after the final encoding fix |
| `npm test` | Linux | Pass: 95 tests, 93 passed, 2 Windows-only skips, 0 failed; 46.865 seconds |
| `npm run build` | Windows and Linux | Pass after the final encoding fix |
| `npm test` | Windows | Pass: 95 passed, 0 skipped, 0 failed; 455.149 seconds |
| `npm pack --ignore-scripts --pack-destination TEMP --json`; `npm install --prefix CLEAN --ignore-scripts --no-audit --no-fund TARBALL`; installed CLI `--version`; `node --import tsx scripts/package-acceptance.ts CLEAN/node_modules/easy-skills` | Windows and Linux | The adjacent final validation record contains each exact tarball path/digest, clean-install result and compiled workflow/skill/protocol acceptance result. Earlier package candidates also passed; none were published |
| Official Node archive checksum, `sha256sum --check`; `npm ci --ignore-scripts --no-audit --no-fund` | Linux | Pass: Node 24.22.0 checksum matched; 111 packages installed |
| Installed Codex configuration-only preflight | Windows, initial implementation session | Pass: 0.163.0, all 4 discovered MCP servers disabled, hooks/apps disabled; no model request or server initialization |
| Protected-input encoding reproduction | Windows | Before fix: `differentBytesSameDigest: true`; corrected regression passes on Windows and Linux |
| `git -c core.safecrlf=false diff --check` | Windows | Pass |
| `git diff --numstat -- docs/audits docs/reliability-audit.md`; `git rev-parse HEAD` | Windows | Historical audit inputs unchanged; HEAD remains `0899a374e8f25267ecf7f043c047cd10fb615674` |

The interrupted implementation session had already completed a 95/95 Windows run
and Linux/package fixture runs. They were superseded when the encoding defect was
found during final review. Earlier failing fixture/classification cases were fixed
and rerun; they are not counted as passes. The resumed Linux setup initially found
no retained temporary runtime and no `rg`; it was recreated and used `grep` for the
checksum selection. Docker was not used. No platform result is inferred from the
other platform, hosted CI or the prior alpha release.

Local tarballs are validation candidates for unreleased alpha.2. No published asset
was overwritten, and no commit, push, release, account mutation, model call or real
email was performed. Final package paths and SHA-256 values are kept in the adjacent
validation record, outside the tarballs, to avoid a self-referential package digest.

The broader-alpha gate remains unpassed: real revised client launch/resume, Claude
isolation, protected/queued GitHub merges, real SMTP/remote delivery, physical reboot
and the complete parallel two-provider/two-stack acceptance path still need separate
authorization and observation. Green fixtures and an installed tarball do not replace
that gate.
