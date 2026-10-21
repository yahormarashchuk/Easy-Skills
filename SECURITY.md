# Security

Do not report credentials, session transcripts or private source in public Issues.
Report a suspected vulnerability privately to the repository owner through GitHub's
private vulnerability reporting when available, or request a private channel first.

Easy Skills runs official clients on the user's computer. Approval hashes, worktree
ownership and provider permissions are workflow safeguards; agents with broad shell
access are not contained by a VM or container. Treat repositories, hooks, checks and
MCP configuration as executable code. Review them before authorizing execution.

State, logs and mail settings belong outside the repository. On Windows protect the
state directory using your account's ACLs; POSIX mode bits alone do not set Windows
ACLs. Logs are local and may contain sensitive code even after best-effort redaction.
The runner never extracts official CLI tokens or sends email inbox requests.

Remote commands are allowlisted and scoped to run/plan versions. Final merge needs
a separate exact-head CLI decision or an expiring single-use email code. Code hashes
are stored; codes are not put in model context. An agent with unrestricted account
or filesystem access is outside this protection boundary.
