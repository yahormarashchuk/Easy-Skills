---
name: easy-mcp
description: Propose useful MCP integrations with permission review, config backup and a real connection check.
---

Read [the workflow contract](references/workflow.md). Inspect the project's actual
needs and existing client settings. For each proposed integration show purpose,
permissions, data sent, and the alternative without MCP. Avoid duplicate transports.

Prepare a complete JSON config preserving unrelated entries. `easy-skills mcp-config
--path <client-config> --file <proposal>` shows before/after and a hash. Apply the
reviewed hash with an explicit probe command that verifies the server connection.
Backup existing configuration; failed probes must not be reported as successful setup.

The current executable GitHub transport is gh. GitHub MCP can be evaluated but is
not an executable transport in this alpha. Do not claim support or silently switch.
Client formats other than JSON need their own documented, reviewed integration.
