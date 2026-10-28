# Client compatibility

For the managed-policy gate, model discovery and current observations for Claude Code,
see [Claude managed policy](claude-isolation-investigation.md).

On 2026-10-27, native Windows / Node.js 24.22.0 / Codex CLI 0.163.0 returned eight
picker-visible models through the official app-server initialization and paginated
`model/list` path. Hooks/apps/MCP restrictions were verified before launching the
metadata process. No thread or inference turn was requested. This observation validates
catalog discovery only; listing does not establish entitlement or authorize execution.
The interactive picker stores the returned exact model ID after numeric selection.
Hidden models, malformed/empty responses, repeated cursors and discovery failures
have fixture coverage. Claude discovery uses the client's `initialize` metadata request.

**Alpha.2:** the adapter execution policy changed, so these historical model probes
do not authorize current execution. Real Claude launches are refused when managed
policy configures hooks, plugins or a policy helper. Codex's configuration-only empty
MCP/hook restriction check passed locally on 2026-10-22; no revised model launch/resume
probe was performed. See [the current implementation record](../reliability-implementation.md).

Observed locally on 2026-10-21, Windows, Node.js 24.22.0, Git 2.45.1:

| Client | Observation | Scope |
| --- | --- | --- |
| Codex CLI 0.163.0 | Installed; saved ChatGPT login; read-only `gpt-6.1-sol` request and exact-ID resume passed | Real provider, two small turns; not a full autonomous feature acceptance run |
| Claude Code 2.1.306 | Native Windows executable at ~/.local/bin/claude.exe; claude.ai login; read-only `claude-sonnet-5-5` request and exact-ID resume passed | Real provider, two small turns; assigned model matched reported events; not a full autonomous feature acceptance run |
| GitHub CLI 2.102.0 | Installed and authenticated | Production Issue/PR mutations were not performed during implementation |

These are historical observations of the original alpha adapter. The revised schema,
final-output and MCP permission paths have fixture coverage and need fresh real-client
probes; the table does not claim those revisions passed live E2E.

After explicit permission, set `EASY_SKILLS_ALLOW_CLIENT_PROBES=1` and reproduce the
opt-in client check using `npm run smoke:clients -- codex EXACT_ID` or
`claude-code EXACT_ID`. To allow a worker to use a configuration, use `easy-skills doctor
--provider codex --model EXACT_ID --probe`, which performs a request and exact session
resume and stores the exact assignment, executable path and version outside the repo.
Execution compares that identity plus its execution-policy generation and checks authentication again, without expiring
compatibility solely because a quota wait lasted more than 24 hours. Changed clients
and older identity-less probes require a reviewed fresh probe. No default/alias mapping is
maintained; availability is verified through the actual selected client's response.

Codex uses saved CLI login, `exec --json --output-schema ... --output-last-message ...`
and explicit resume with the same output channels, with global
workspace-write/read-only and noninteractive approval options. Claude uses stdin,
`-p --output-format stream-json --verbose --json-schema ... --model ID --effort LEVEL`, explicit --resume, dontAsk and
stage-specific tool permissions. No --bare, continue-last or bypass-sandbox option is
used. Official client binaries and their authentication files remain unchanged.
Interim agent messages never establish completion. Small structured schemas are
runtime-validated; PLAN serializes its complex Plan for separate validation. VERIFY
can use plan-approved diagnostics/browser capabilities. See [MCP details](../mcp.md).

Claude invocations use a temporary per-invocation settings file to disable configured
fallback chains and automatic content-based switching. Reported startup/assistant/result
models are checked against the exact assigned ID; a mismatch stops the task. A managed
policy or upstream client can still reject that configuration. The intended controls
follow [Claude's documented model configuration](https://code.claude.com/docs/en/model-config).
Model identity alone was checked in the original tool-free probe with Claude Code 2.1.306 and
`claude-sonnet-5-5`. The revised configuration with effort passed a read-only request and resume on
2026-10-28 (`claude-haiku-5-5`, effort `low`), not a full autonomous feature run. Other versions/configurations need their own authorized validation.

These options follow [OpenAI non-interactive documentation](https://developers.openai.com/codex/noninteractive),
the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and
[Claude programmatic execution](https://code.claude.com/docs/en/headless).
Claude bare mode skips settings and subscription authentication and is unsuitable for
this workflow. Client details may change: probes establish installed behavior, not a
permanent compatibility guarantee. Review [Claude's applicable product conditions](https://code.claude.com/docs/en/legal-and-compliance)
before distributing integrations; users install and authenticate official clients themselves.
