# Claude Code isolation investigation

Status: **blocked for real execution and model discovery**. This is an investigation,
not a claim that Claude Code can safely run under the current execution policy.

On 2026-10-28, the installed Windows Claude Code 2.1.306 reported that `--safe-mode`
retains admin-managed policy, `--bare` does not use the ordinary subscription login,
and `--effort` accepts explicit levels. The existing Easy Skills adapter has fixture
coverage for its structured output, exact model/session, and tool permissions. Those
fixtures do not establish real launch isolation or model availability.

The official [CLI reference](https://code.claude.com/docs/en/cli-reference) confirms
that safe mode retains policy-configured hooks. The [hook reference](https://code.claude.com/docs/en/hooks)
states that a lower-level `disableAllHooks` cannot disable hooks from managed policy.
The [managed settings reference](https://code.claude.com/docs/en/managed-settings)
also describes remotely delivered and periodically refreshed policy. SDK parent
settings are ignored when an administrator source is present unless the administrator
enables merging; even then, the effective outcome needs verification before hooks run.
Inspecting local files alone cannot establish the remote policy, and inspecting a
running session is too late to exclude its initial hooks.

Before enabling the provider, establish an enforceable boundary that covers session
startup and every subsequent launch or resume. A candidate must preserve official
subscription authentication, exact model and effort assignments, approved tools and
operations, one Issue executor, and clean-worktree/evidence guards. It must not rely
on automatically switching provider, mutable model aliases, copying subscription
credentials, or assuming that a managed policy cannot change.

Possible routes to investigate are an official configuration-only API that proves and
enforces the effective policy before any hook can execute, or a separately verified
execution boundary that constrains hook side effects as well as model tools. SDK
parent settings or a container alone are not evidence of either guarantee. Also verify
how the official client reports account-specific exact model IDs and supported effort
levels without starting an unprotected session.

Acceptance needs isolated fixtures that exercise local and remote/managed hooks,
startup and resume, policy changes, prohibited filesystem/network/process effects,
tool grants, and explicit model/effort identity. A separate opt-in real-client check
must verify authentication, exact model execution and session resume after the boundary
is established. Tests and public CI must not contain subscription sessions or secrets.
