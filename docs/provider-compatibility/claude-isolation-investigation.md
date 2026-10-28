# Claude managed policy

Status: **enabled with a managed-policy gate**. Claude Code can be selected and run
when no admin or organization policy configures a process-starting key.

## Launch controls

Every Claude launch, resume and model-discovery process uses `--safe-mode`,
`--setting-sources ''` and `--settings` with `disableAllHooks: true`, plus
`--strict-mcp-config`. These exclude user, project, local and plugin hooks. The
[CLI reference](https://code.claude.com/docs/en/cli-reference) and
[hook reference](https://code.claude.com/docs/en/hooks) state that managed policy
still applies, so Easy Skills inspects every documented managed source from the
[managed settings reference](https://code.claude.com/docs/en/managed-settings):

- `managed-settings.json` and `managed-settings.d/*.json` in the system directory
  (`C:\Program Files\ClaudeCode`, `/Library/Application Support/ClaudeCode`, `/etc/claude-code`);
- the `Settings` value under `HKLM` and `HKCU\SOFTWARE\Policies\ClaudeCode` on Windows. A key
  that exists but cannot be queried is an error, never an absent policy;
- under WSL, the Windows policy files under `/mnt/c/Program Files/ClaudeCode`; Windows
  registry values are not visible from WSL and are not inspected;
- the `com.anthropic.claudecode` managed preferences profile on macOS (presence refuses,
  because its content is not yet parsed);
- the server-managed settings cache, `remote-settings.json` in the client's reported
  config directory. Team and Enterprise accounts without a synced cache are refused.

Launch is refused when any source sets active `hooks`, `enabledPlugins` or `policyHelper`,
or a non-empty `permissions.allow` (managed allow rules merge with the per-stage grants and
could authorize tools a stage was never given), when `managed-mcp.json` exists, or when a
source cannot be read or parsed. Inert values such as empty lists or disabled plugins do
not refuse. The format of the organization cache is client-internal, so nested objects are
searched as well. Other managed settings, such as authentication helpers and environment
variables, are administrator-run configuration and are not inspected. The check runs before each launch and again after it; a result produced after
such a key appears is discarded. There is no bypass switch or provider fallback.

## Residual limit

Server-managed settings are fetched by the client at startup. An organization policy
change published between the check and that fetch can run a hook before Easy Skills
sees it; the post-run check then rejects the work. Organization and machine
administrators are treated as part of the trusted host, as they are for the client
itself.

## Models and effort

Models come from the official client's `initialize` control request, which reports
the account's picker entries with exact resolved IDs and supported effort levels. No
prompt is sent. Aliases are collapsed onto their exact IDs; entries without effort
levels are omitted, so a model listed without effort support cannot be selected. The chosen effort is passed with `--effort`, and the reported
model is still compared with the assigned exact ID on every event.

## Observations

On 2026-10-28, native Windows / Node.js 24.22.0 / Claude Code 2.1.306 with a Team
account and an empty organization policy: model discovery returned eleven exact IDs
with effort levels; a read-only `claude-haiku-5-5` request at effort `low` and its
exact-session resume passed; `diagnose` reported `isolation: true`. Fixtures cover
policy sources, catalog parsing and effort arguments. Tests and public CI contain no
subscription sessions or secrets.
