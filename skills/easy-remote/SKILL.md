---
name: easy-remote
description: Configure GitHub control and email notifications for a locally running Easy Skills feature.
---

Read [the workflow contract](references/workflow.md). Explain the local worker lifecycle:
the computer must remain on and awake. The detached worker survives terminal closure;
automatic startup after reboot is not installed. Resume persisted runs after reboot.

Prepare local SMTP/remote settings using [references/settings.json](references/settings.json). Use password
environment variable names, never tracked credentials. Review and apply the configure
proposal and run mail-test. Without configured mail, notifications remain pending.

Control uses an allowlisted GitHub author and exact run/plan identifiers; see
[the remote control reference](references/remote-control.md) for command syntax. Ordinary Issue prose is not a shell. To
authorize final merge remotely, request-merge sends a single-use code to the human;
do not request or read that code as an agent. It binds action, plan and head.

Claude Code's native Remote Control may supplement an interactive Claude session;
inspect its installed documentation and availability first. It does not control all
runner sessions. Do not require incoming ports or a hosted server for the runner.
