# Client compatibility

Observed locally on 2026-10-21, Windows, Node.js 24.22.0, Git 2.45.1:

| Client | Observation | Scope |
| --- | --- | --- |
| Codex CLI 0.163.0 | Installed; saved ChatGPT login; read-only `gpt-6.1-sol` request and exact-ID resume passed | Real provider, two small turns; not a full autonomous feature acceptance run |
| Claude Code 2.1.306 | Native Windows executable at ~/.local/bin/claude.exe; claude.ai login; read-only `claude-sonnet-5-5` request and exact-ID resume passed | Real provider, two small turns; assigned model matched reported events; not a full autonomous feature acceptance run |
| GitHub CLI 2.102.0 | Installed and authenticated | Production Issue/PR mutations were not performed during implementation |

Reproduce the opt-in client check using `npm run smoke:clients -- codex EXACT_ID` or
`claude-code EXACT_ID`. To allow a worker to use a configuration, use `easy-skills doctor
--provider codex --model EXACT_ID --probe`, which performs a request and exact session
resume and stores a 24-hour probe result outside the repo. No default/alias mapping is
maintained; availability is verified through the actual selected client's response.

Codex uses saved CLI login, `exec --json`, and `exec resume SESSION --json`, with global
workspace-write/read-only and noninteractive approval options. Claude uses stdin,
`-p --output-format stream-json --verbose --model ID`, explicit --resume, dontAsk and
stage-specific tool permissions. No --bare, continue-last or bypass-sandbox option is
used. Official client binaries and their authentication files remain unchanged.

Claude invocations use a temporary per-invocation settings file to disable configured
fallback chains and automatic content-based switching. Reported startup/assistant/result
models are checked against the exact assigned ID; a mismatch stops the task. A managed
policy or upstream client can still reject that configuration. This behavior follows
[Claude's documented model configuration](https://code.claude.com/docs/en/model-config)
and was exercised with authenticated Claude Code 2.1.306 and `claude-sonnet-5-5`.
Other installed versions and model configurations need their own probe.

These options follow [OpenAI non-interactive documentation](https://developers.openai.com/codex/noninteractive),
the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and
[Claude programmatic execution](https://code.claude.com/docs/en/headless).
Claude bare mode skips settings and subscription authentication and is unsuitable for
this workflow. Client details may change: probes establish installed behavior, not a
permanent compatibility guarantee. Review [Claude's applicable product conditions](https://code.claude.com/docs/en/legal-and-compliance)
before distributing integrations; users install and authenticate official clients themselves.
