# Easy Skills

A local runner and engineering skills for Codex CLI and Claude Code, licensed under
Apache-2.0. Work runs on the user's computer, including Windows without WSL. Users
authenticate with their own model accounts; no separate server or mandatory model
API keys are required.

**Status: executable alpha, not a completed v1 release.** It includes sequential task
execution, SQLite persistence, recovery, checks tied to commits, worktrees, GitHub
through gh, notifications, remote commands and 13 installable skills. The full acceptance
scenario still needs validation with both real clients and GitHub. See the
[implementation matrix](docs/implementation-status.md) for the current boundaries.

```powershell
npm ci
npm run build
node dist/cli/index.js --help
node dist/cli/index.js doctor
npm test
npm pack
```

Download the compiled package from the
[v0.1.0-alpha.1 GitHub prerelease](https://github.com/yahormarashchuk/Easy-Skills/releases/tag/v0.1.0-alpha.1),
or install it directly:

```sh
npm install -g https://github.com/yahormarashchuk/Easy-Skills/releases/download/v0.1.0-alpha.1/easy-skills-0.1.0-alpha.1.tgz
easy-skills doctor
```

It has not been published to the npm registry. The package contains compiled JavaScript,
so installed-package users do not need to compile TypeScript.
See [installation and removal](docs/installation/README.md).

Typical workflow after installation:

1. Install Git, gh and the official AI clients, then authenticate with the clients and gh.
2. Run `easy-skills install-skills --client codex` or use `--client claude-code`.
   Review the installation proposal and repeat with `--apply-hash HASH`.
3. Invoke `easy-init` to inspect the project, agree rules and prepare project.yaml.
   `init --config FILE` previews changes; `--apply-hash HASH` applies them.
4. Use `easy-feature` to agree requirements and exact CLI/model assignments. Verify
   each selected configuration with `doctor --provider codex --model EXACT_ID --probe`,
   or use `--provider claude-code`. This uses account quota to check execution and
   continuation of a specific session.
5. Run the selected PLAN model with `feature plan --file request.yaml --out execution.yaml`
   using the [request template](templates/feature-request.yaml), or prepare execution.yaml
   using the [plan template](templates/feature.yaml). Then run
   `feature draft --file FILE`, review the entire plan and approve it with
   `feature approve RUN_ID --hash PLAN_HASH`.
6. `easy-skills start RUN_ID` launches a detached worker. Use `status RUN_ID`,
   `events RUN_ID`, `pause RUN_ID` and `resume RUN_ID` for local control.
7. Receive a PR for each task into the feature branch and a final PR into the main
   branch. Authorize the final merge separately with `merge RUN_ID --head REVIEWED_COMMIT`,
   or merge manually on GitHub.
8. After confirmed merge, run `cleanup RUN_ID`, review the resources and repeat with
   `--apply-hash HASH`. Dirty or unowned worktrees and database contents are not removed.

One task executes within a feature. A dependency is satisfied after its PR merges into
the feature branch. Different features use separate workers and worktrees. On quota
exhaustion, the runner preserves the session and waits without replacing the model.
Reviews and check results refer to a specific commit; code changes require validation
again. Main-branch merge always needs separate authorization, and GitHub protections apply.

SQLite, sessions, logs and email settings live outside the repository, under
`%LOCALAPPDATA%/EasySkills` on Windows. Override the path with `EASY_SKILLS_HOME`.
Closing the terminal does not stop the detached worker. After a reboot, restart from
persisted state; installation does not automatically enable startup at login.

See the [product specification](docs/product-spec.md),
[architecture](docs/architecture/runner.md), [remote control](docs/remote-control.md),
[verified compatibility](docs/provider-compatibility/README.md),
[procedure provenance](THIRD_PARTY_NOTICES.md) and [contributing guide](CONTRIBUTING.md).
