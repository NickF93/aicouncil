# Changelog

## 0.2.0

- Roster management commands: `/council add <model> [nick]`, `/council remove <nick|model>`,
  `/council chair <model> [nick]` — persisted to `council.json` (project file when it owns
  the roster, user file otherwise).
- User config now honors `PI_CODING_AGENT_DIR` (omp profiles).
- Argument completions for member removal.

## 0.1.0

- Initial release.
- `/council <question>` — Karpathy-style 3-stage deliberation: parallel independent
  opinions → anonymized peer review with Borda-count ranking → chairman synthesis.
- `/council models` and `/council roster` for setup.
- `council` tool so the main agent can convene the council itself.
- Config via `council.json` (package dir → `~/.omp/agent/council.json` → `<project>/.omp/council.json`).
- Per-seat failure tolerance, per-call timeouts, full transcripts in `<cwd>/.omp/council/`.
