# Third-party procedures and provenance

The runner is an original TypeScript implementation. Skill text is newly written,
adapting selected procedures rather than combining upstream repositories. Source
revisions below were inspected on 2026-10-21. Their licenses remain applicable to
adapted material; Easy Skills' Apache-2.0 license does not supersede them.

| Source and pinned revision | Inspected material | Adaptation | License |
| --- | --- | --- | --- |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills/tree/aeac41d4d005999432bb7312f7ff06383a91d59d) | using-agent-skills, planning-and-task-breakdown, test-driven-development | DEFINE/PLAN/BUILD/VERIFY/REVIEW/SHIP routing; approval before execution; evidence gates and one TDD procedure | MIT; [notice](third-party/addyosmani-agent-skills-LICENSE) |
| [mattpocock/skills](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2) | productivity/grilling, engineering/implement | Interview unresolved decisions after code discovery; small dependent slices; explicit handoff context | MIT; [notice](third-party/mattpocock-skills-LICENSE) |
| [donvito/codex-astra-luna-orchestrator](https://github.com/donvito/codex-astra-luna-orchestrator/tree/f5efba0f957a1e3f0671e629ccc2c655725a7e7b) | profiles/pro/agents/skills/astra-orchestrator/SKILL.md | Separate implementation, validation and independent review contracts; bounded work and concise evidence | Apache-2.0; [license](third-party/donvito-orchestrator-LICENSE) |

Changes: model-specific routing and always-running lead-agent requirements are removed;
the deterministic runner owns persistence, GitHub, process supervision and waiting.
Tasks are sequential within each feature, each has its own PR, and cleanup waits for
confirmed final merge. Installation bundles shared references into every skill.
Upstream layouts and behaviors may change: these notes describe only pinned sources,
not claims about future HEADs. No upstream NOTICE file was listed at these revisions.

Runtime dependency licenses are declared by their respective npm packages and retained
by npm when installed. Official Codex and Claude Code clients are installed and
authenticated independently by the end user, unmodified, under their own terms.
