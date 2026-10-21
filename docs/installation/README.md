# Installation

Prerequisites: Node.js 24 LTS+, Git, GitHub CLI, and at least one independently installed
official Codex CLI or Claude Code. Windows works without WSL. Docker is optional.
Authenticate in the official tools yourself (`codex login`, `claude auth login`, `gh auth login`).

Install the compiled package from the
[GitHub prerelease](https://github.com/yahormarashchuk/Easy-Skills/releases/tag/v0.1.0-alpha.1):

```sh
npm install -g https://github.com/yahormarashchuk/Easy-Skills/releases/download/v0.1.0-alpha.1/easy-skills-0.1.0-alpha.1.tgz
easy-skills doctor
```

The release also provides `SHA256SUMS` for checking the downloaded tarball. To build
and install from a source checkout instead:

```sh
npm ci
npm run build
npm pack
npm install -g ./easy-skills-0.1.0-alpha.1.tgz
easy-skills doctor
```

The npm registry release is not published. The tarball includes compiled runner code,
schemas, skills, templates and docs; users of the package do not compile TypeScript.

Install client-discoverable skills with `easy-skills install-skills --client codex` or
`--client claude-code`. This prints complete before/after content and an approval hash;
repeat with `--apply-hash HASH`. Defaults are ~/.agents/skills and ~/.claude/skills;
`--target` supports another documented client location. Existing skill files get backups.
Only verified, unchanged installed files are removed by uninstall-skills; modified
skills and backups are retained. Both commands preview before applying.

The skill package is installed separately from npm's binary. To remove the binary use
`npm uninstall -g easy-skills`; to remove skills run uninstall-skills with the exact
installation target, review, and apply its hash. State and project context are retained.

Upgrades must not replace a package while its workers are active. Keep the pinned
tarball for recovery, compare package/skill changes, pause work at a safe point, back up
the private state, install the reviewed version, and leave user modifications intact.
Rollback uses the previous tarball and skill backups. Automated migrations, multi-version
worker installation and an automatic rollback manager are not implemented in this alpha.
