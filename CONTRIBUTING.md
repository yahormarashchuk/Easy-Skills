# Contributing

Use Node.js 24 LTS or later and a native Git installation. Windows does not require WSL.

```sh
npm ci
npm run check
npm test
npm run build
```

Behavior changes need focused tests for the relevant state, process or Git boundary.
Use fake CLI streams and temporary local Git remotes in CI. Never add authenticated
model sessions, real personal email settings or subscription credentials to fixtures.
Use the separate opt-in compatibility probes for real clients.

Keep a single maintained copy of shared workflow text in skills/_shared/workflow.md.
The build copies it to each skill. Update provenance if adapting additional sources.
Describe the concrete behavior, validation and remaining limits in pull requests.
