# Remote control

The local worker must remain running on an awake computer. It polls GitHub outbound;
no incoming port is opened. Restart persisted runs after reboot; autostart is not installed.

Configure allowlisted GitHub logins and SMTP using templates/settings.json, then run
`configure --file <settings.json>`, review its before/after proposal and repeat with
`--apply-hash <hash>`. The stored settings live outside the repository. Export the named
password variable in the environment inherited by the worker. `mail-test` verifies the
SMTP connection. `notify` attempts pending deliveries and reports when mail is absent.
SMTP acceptance is not a promise of inbox delivery. Failed outbox items remain pending;
retry after a crash may deliver duplicates with the same Message-ID.

Post one exact command as the entire comment on the feature's parent Issue:

```text
/easy-skills status RUN_UUID PLAN_SHA256
/easy-skills pause RUN_UUID PLAN_SHA256
/easy-skills resume RUN_UUID PLAN_SHA256
/easy-skills stop RUN_UUID PLAN_SHA256
/easy-skills answer RUN_UUID PLAN_SHA256 REQUEST_UUID "Answer as a JSON string"
```

The author must be allowlisted, run and plan must match, and every comment ID is
consumed once. Other prose is never executed. Pause and stop apply at safe checkpoints,
not in the middle of file edits. Resume preserves the previously approved scope.

When a stage returns a blocking question, its request appears on the parent Issue and
in `status`. An answer is accepted once for that exact request, plan and inspected
revision, then delivered to the same stage session. It clarifies the approved scope;
it cannot change model assignments, checks or permissions. The local equivalent is
`easy-skills answer RUN_UUID --request REQUEST_UUID --value "Answer"`.

For final merge, `easy-skills request-merge RUN_UUID` emails a short-lived single-use
command containing request ID, plan hash, reviewed commit and an eight-digit code.
The human posts it on the parent Issue after reviewing the PR. Only the code hash is
stored. The worker validates the current commit/base/evidence before attempting merge.
Alternatively, `easy-skills merge RUN_UUID --head REVIEWED_COMMIT` is an explicit local
decision. Neither path bypasses CI or GitHub branch protections.

Because automation can use the same GitHub identity as the human, checking author
names alone is insufficient for expanding permissions. This extra code is a workflow
safeguard, not host isolation against an agent with unrestricted shell/account access.
