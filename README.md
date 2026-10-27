# Easy Skills

A local TypeScript runner and engineering skills for Codex CLI and Claude Code.
Apache-2.0. Runs on native Windows and other Node.js 24+ hosts, using official client
authentication. No mandatory model API key, WSL, Docker, server or dashboard.

**Executable alpha; full live-provider acceptance is still pending.** The reliability
changes described here are unreleased. The published `v0.1.0-alpha.1` asset predates
them; use a tarball built from this checkout to try the current implementation.
See [implementation status](docs/implementation-status.md).

The `0.1.0-alpha.2` working tree uses project/plan v2 and SQLite v3. Real Claude
launches currently fail closed because managed hook exclusion cannot be verified
before execution. Codex supports verified empty MCP grants; named grants stop.
No model/provider fallback occurs. See the [implementation and migration record](docs/reliability-implementation.md).

## Install the packaged product

Install Node.js 24+, Git, GitHub CLI and the official AI clients you intend to use.
Install a compiled Easy Skills tarball; package users do not compile TypeScript:

```powershell
npm install -g .\easy-skills-0.1.0-alpha.2.tgz
easy-skills --version
easy-skills bootstrap --client codex
```

Bootstrap checks prerequisites and authentication without model requests and previews
skill installation. Review its full proposal, then repeat with `--apply-hash HASH`.
Claude skills can be installed, but current real execution remains blocked by the
isolation diagnostic. Existing skills get backups; modified
files are retained by conservative uninstall. [Installation and removal](docs/installation/README.md)

The previous compiled release and checksums are available on
[GitHub](https://github.com/yahormarashchuk/Easy-Skills/releases/tag/v0.1.0-alpha.1).
There is no npm registry publication or new GitHub release for these local changes.

## Initial setup

1. Sign in yourself with `gh auth login`, `codex login` and/or `claude auth login`.
2. In the managed repository, invoke `easy-init`. It inspects current code and keeps
   an unresolved decision tree rather than repeating questions already answered.
3. Prepare [project.yaml](templates/project.yaml), including real checks and an agreed
   GitHub merge policy, approved setup and protected verification inputs.
   `easy-skills init --config FILE` previews the context files;
   repeat with `--apply-hash HASH` after review. Generated rules remain drafts.
4. Resolve rule conflicts, assumptions and required check prerequisites. Complete
   `.easy-skills/decisions/onboarding.json` with explicit answers and `status: agreed`.
   Preview `easy-skills agree-rules --file INTERVIEW.json`, review it, then apply its
   exact hash. Agreement records the rules/configuration revision; it does not approve
   a feature. Rule changes require a new agreement and plan.
   Commit the reviewed project context before creating feature worktrees.
5. Approve two small requests for each exact CLI/model configuration, then run
   `easy-skills doctor --provider codex --model EXACT_ID --probe` after its isolation
   diagnostic succeeds. Claude probes currently stop before a model request.
   This uses account quota and verifies launch plus exact-session continuation.

Automatic merge requires agreed GitHub checks plus server-enforced freshness: strict
up-to-date branch checks enforced for administrators, an active strict ruleset, or an
effective merge queue. Protection applies to intermediate target branches too.
Missing guarantees stop automatic merge with a reason. Easy Skills does not alter
branch protection or bypass it. [Merge gate](docs/merge-gate.md)

Optional MCP setup uses `mcp-config --path NATIVE_CONFIG --file SETUP.json` and a
reviewed apply hash. It renders Codex TOML or Claude JSON and verifies the actual
server's required tools. [MCP setup](docs/mcp.md)

## First feature

Invoke `easy-feature` to agree behavior, acceptance, scope and exact stage assignments.
Use [the request template](templates/feature-request.yaml):

```powershell
easy-skills feature plan --file request.yaml --out execution.yaml
easy-skills feature draft --file execution.yaml
easy-skills feature approve RUN_ID --hash PLAN_HASH
easy-skills start RUN_ID
easy-skills status RUN_ID
```

Review the complete plan before approval: specification, task scopes/dependencies,
rules agreement, models, checks, VERIFY capabilities, publication and intermediate
merge permissions, setup, protected inputs and the completed repair limit. The runner
prepares each worktree and captures a baseline before BUILD. Existing failures
or unavailable checks stop implementation for a decision; they never count as passing
feature evidence.

The detached worker survives terminal closure. Each task gets a PR into the feature
branch. Its Issue closes after implementation, checks/review and PR publication;
dependencies remain pending until the PR is actually merged. Features can run in
parallel, with one task executor per feature. Queued/accepted merge requests remain
pending. Final validation and review produce a PR into the configured main branch.

Authorize final merge separately with `easy-skills merge RUN_ID --head REVIEWED_SHA`,
or merge manually through GitHub. For remote control and email confirmation see
[remote commands](docs/remote-control.md). After confirmed merge, preview
`easy-skills cleanup RUN_ID` and apply the reviewed hash. Dirty/ignored private files
block worktree deletion; branches and data volumes are retained.

## Recovery and diagnostics

`status RUN_ID` and `events RUN_ID` show persisted state. `pause`, `resume`, `sync` and
`stop` operate at safe checkpoints. After reboot, use `resume RUN_ID` or `start RUN_ID`, including
for a ready feature. Startup-at-login is not installed automatically.

Quota/network waits preserve the exact session and assignment. A compatibility probe
does not expire merely because 24 hours passed: the worker compares CLI path/version
and the adapter execution policy, and checks authentication again. A changed client or
execution policy requires a reviewed probe; expired
authentication requires official login. Unknown quota reset times use capped backoff.
Three unresolved occurrences of the same normalized failure stop repairs even when
each attempt makes a new commit. A new revision alone is not progress.
New plans also approve an overall repair limit (three completed corrective BUILD
attempts by default). Quota/network interruptions retain the same repair ID and
session. Legacy approvals are never silently assigned this new condition.

`baseline --recapture`, `setup-reset`, `retry-merge` and `project-config` use concrete
preview/apply hashes. `abandon` preserves a failed run and frees its feature ID for
a fresh, separately approved attempt. See the [updated journey](docs/reliability-implementation.md#user-journey).

Ready-state monitoring detects main changes, revokes readiness and repeats sync,
checks and review. Old merge confirmations cannot authorize a different head. A live
recorded child prevents a replacement executor. Investigate the PID before recovery.

SQLite, sessions, logs and SMTP settings stay outside the repository under
`%LOCALAPPDATA%/EasySkills` on Windows (`EASY_SKILLS_HOME` overrides it). Agents receive
cleaned failure excerpts, not private log paths or session histories. Outbox claims
prevent concurrent sends and retry expired leases; SMTP delivery can repeat after a
send/acknowledgement crash, with a stable Message-ID.

Schema v1 upgrades create a database backup and preserve plan hashes. Old plans without
explicit rules agreement/merge policy stop with migration guidance. Keep the original
run and pinned package; complete onboarding and approve a replacement plan instead of
silently rewriting a previously approved plan. [Recovery contracts](docs/architecture/runner.md)

## Develop Easy Skills

```powershell
npm ci
npm run check
npm test
npm run build
npm pack
```

`check` includes tests/scripts. Tests use fixtures, temporary local Git repositories
and injected clients/GitHub/SMTP. CI runs Windows/Linux with real integration probes
disabled. The release commit passed both hosted jobs; this local branch has not been
pushed. [Observed CI run](https://github.com/yahormarashchuk/Easy-Skills/actions/runs/39625039980)

Real checks require separate explicit permission. Set `EASY_SKILLS_ALLOW_CLIENT_PROBES=1`
before `npm run smoke:clients -- codex EXACT_ID`. External smoke checks require both
`EASY_SKILLS_ALLOW_EXTERNAL=1` and `--allow-external`; see
[validation scenarios](docs/validation.md). Fixture passes do not establish real-client
E2E, real email delivery or v1 readiness.

See [product specification](docs/product-spec.md), [client compatibility](docs/provider-compatibility/README.md),
[procedure provenance](THIRD_PARTY_NOTICES.md) and [contributing](CONTRIBUTING.md).
