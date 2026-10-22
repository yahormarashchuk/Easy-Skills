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

For VERIFY, add exact tool names such as `mcp__browser__snapshot` to
`verification.browserTools` in the plan. Claude loads a project `.mcp.json` with strict
MCP configuration and a short-lived stdio tool filter that rejects unapproved tool
calls. It is not a listening server or a required background service. Codex loads
native configuration and sets `enabled_tools` for approved servers. Inline nested
TOML server options currently stop with a diagnostic; use environment references or
review a supported configuration. Other client/plugin/managed MCP behavior needs
validation in that installation; a failed launch must not be treated as verified.

Claude VERIFY exposes Read/Glob/Grep, only approved diagnostic commands through Bash,
and approved MCP tools. It does not expose Edit/Write. Deterministic checks still run
independently under the runner; agent observations do not replace their evidence.

Sources: [Codex MCP configuration](https://developers.openai.com/codex/mcp),
[Claude CLI tool/configuration controls](https://code.claude.com/docs/en/cli-reference),
[official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk).
