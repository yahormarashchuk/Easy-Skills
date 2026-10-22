---
name: easy-mcp
description: Propose useful MCP integrations with permission review, config backup and a real connection check.
---

Read [the workflow contract](references/workflow.md). Inspect the project's actual
needs and existing client settings. For each proposed integration show purpose,
permissions, data sent, and the alternative without MCP. Avoid duplicate transports.

Prepare a JSON setup proposal with client, name, server, requiredTools and an optional
explicitly approved testCall. `easy-skills mcp-config --path <client-config> --file
<proposal>` renders native Codex TOML or Claude JSON while preserving unrelated
settings. Review the full diff and hash before applying it. The probe initializes
the actual server, lists required tools and runs only the reviewed testCall, if any.
Backup existing configuration; failed probes must not be reported as successful setup.

The current executable GitHub transport is gh. GitHub MCP can be evaluated but is
not an executable transport in this alpha. Do not claim support or silently switch.
For Claude VERIFY, use a project `.mcp.json`; the runner loads approved servers through
a per-assignment tool filter. Codex uses its native enabled_tools allow list. Include
exact `mcp__server__tool` names in the reviewed plan. A code-zero command alone does
not establish MCP connectivity. Keep credentials in official login or environment
references, never in feature documents.
