# Native MCP setup

Create a JSON setup request, for example:

```json
{
  "client": "codex",
  "name": "browser",
  "server": {"command": "YOUR_NATIVE_SERVER_EXECUTABLE", "args": []},
  "requiredTools": ["snapshot"],
  "testCall": {"tool": "snapshot", "arguments": {}, "expectedText": "YOUR_EXPECTED_READ_ONLY_RESULT"}
}
```

Choose an actual server and a harmless test for its real protocol. `testCall` is
optional; it is an external tool action and belongs in the reviewed proposal.
Without it, verification establishes initialization and tool availability, not
the correctness of each operation.

`easy-skills mcp-config --path PATH --file SETUP.json` previews the complete native
configuration and binds both it and the capability test to a hash. Repeat with
`--apply-hash HASH` after review. Codex uses `mcp_servers` in TOML; Claude uses
`mcpServers` in JSON. Existing settings are retained semantically; TOML formatting
and comments may change in the reviewed serialization. Backups preserve original
text. Failed probes restore the previous file only if nobody has edited it meanwhile.

The runner negotiates MCP initialization, lists tools (including pagination), checks
every required tool and optionally calls the approved test. Merely returning code zero
from an arbitrary program does not verify a server. Stdio and streamable HTTP are
supported through the official MCP SDK. Bearer tokens can be referenced by environment
name for Codex; OAuth setup stays in the official client. No model OAuth tokens are read.

Current alpha.2 execution supports **empty Codex MCP grants only**. Before launch,
the adapter reads the effective server list with configuration-only commands, supplies
complete inert disabled server definitions and checks the effective list again.
It also verifies disabled hooks/apps. A remaining enabled server, unsupported identity
or failed configuration load refuses the launch. `mcp_servers={}` alone does not clear
all layers and is not used. No server is started by these checks. Named grants stop
with an unsupported-capability diagnostic.

Claude's project `.mcp.json` proxy filters remain covered by local MCP fixtures, but
safe-mode preserves managed policy, so Claude launches stop when a managed source
configures hooks, plugins, a policy helper, extra allow rules or `managed-mcp.json`. A strict MCP file
alone does not solve that separate problem. No user/project/plugin/managed isolation claim is inferred from
an argument string or a successful configuration write.

The fixture-tested Claude VERIFY invocation exposes Read/Glob/Grep, approved diagnostic
commands through Bash, and approved MCP tools, with no Edit/Write. Actual command
matching still needs authorized client validation. Deterministic checks run
independently under the runner; agent observations do not replace their evidence.

Sources: [Codex MCP configuration](https://developers.openai.com/codex/mcp),
[Claude CLI tool/configuration controls](https://code.claude.com/docs/en/cli-reference),
[official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk).
