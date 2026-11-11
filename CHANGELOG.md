# Changelog

## Unreleased

- **Fix**: explicitly display council informational messages in OMP, including
  command output, update notices, roster changes, and dashboard/live URL fallbacks.

- **Fix**: `/council update` only offers npm versions with strictly newer SemVer
  precedence, ignoring downgrades and build-metadata-only differences.

- Remove the machine-specific tracked `node_modules` symlink so fresh clones can
  install dependencies normally.

## 0.4.3

- `/council update` — checks npm for the latest version; self-updates via
  `omp install` for plugin installs, prints instructions for manual installs.

## 0.4.2

- `/council list` — aligned table of every seat: position (member / chair),
  model, auth status, and each member's peer-rank from the most recent
  deliberation (persisted to `.omp/council/last-run.json`).

## 0.4.1

- **Fix**: auth now capability-detects the registry surface
  (`getApiKeyAndHeaders` → `getApiKey`+`getProviderHeaders` → `resolver`), fixing
  "ctx.modelRegistry.getApiKeyAndHeaders is not a function" on omp/pi builds whose
  extension-facing registry API differs.
- `/council doctor` — runtime compatibility report (auth surface, models facade,
  Bun.serve, config paths, roster) for bug reports.
- `/council help`, and `members` as an alias of `roster`.

## 0.4.0

- **Live communication graph**: agents as nodes, glowing animated lines while they
  talk — question fanning out to every seat, members reading each other's anonymized
  answers, everything converging into the chairman. Served from inside omp
  (`Bun.serve` + SSE), auto-opens in your browser when a council convenes.
- `/council live` opens the graph on demand; `liveGraph: false` disables auto-open.

## 0.3.0

- **Deliberation dashboard**: every run writes a self-contained `council-<ts>.html`
  next to the markdown transcript — roster + config panel, 3-stage flow, per-seat
  opinion cards with the anonymization map revealed, who-ranked-whom matrix,
  Borda leaderboard, chairman verdict. Light + dark, zero dependencies.
- `/council last` opens the latest dashboard in your browser.
- Live seat-status widget in the omp TUI while the council deliberates.

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
