# Fixture provenance

`client-events.json` uses official Codex JSONL and Claude stream-JSON event shapes.
Content, model IDs, session IDs and usage counters are synthetic and language-neutral.
The fixture is intentionally independent of account credentials and private transcripts.
Codex's authoritative result is supplied separately through its final-output file;
Claude's result comes from `structured_output`. Interim messages are not stage results.

Sources checked 2026-10-21:
[Codex noninteractive mode](https://developers.openai.com/codex/noninteractive),
[Claude programmatic execution](https://code.claude.com/docs/en/headless).
Passing these fixtures does not mean the revised adapter passed a live client probe.
