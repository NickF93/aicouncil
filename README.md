# aicouncil

**A council of frontier models for [oh-my-pi](https://github.com/can1357/oh-my-pi).**
[Karpathy's llm-council](https://github.com/karpathy/llm-council) flow, inside your
coding agent, on the subscriptions you already pay for — no API keys, no OpenRouter.

```
/council <question>
   │
   ├─ Stage 1  OPINIONS    every member answers independently, in parallel
   ├─ Stage 2  REVIEW      every member ranks the anonymized answers (A/B/C/D)
   └─ Stage 3  SYNTHESIS   the chairman reads everything and writes the verdict
```

One model can be confidently wrong. Several independent answers plus adversarial,
anonymized cross-review catch what a single model misses — and the chairman is
instructed to surface disagreements, not paper over them.

## Install

```bash
omp install @codeninza/aicouncil
```

Or manually: drop this folder into `~/.omp/agent/extensions/`.

## Setup

Log into the providers you want seated (inside omp):

```
/login anthropic
/login openai-codex
/login google-antigravity
```

Check the seats:

```
/council roster
```

The default roster is Claude Fable + Claude Opus + Codex + Gemini (Antigravity),
chaired by Opus. If a seat shows `UNRESOLVED`, run `/council models` to see the exact
model IDs your logins expose and set them in your config (below). Model specs are
fuzzy — `"anthropic/opus"` finds `claude-opus-*` — but exact IDs are safest.

## Use

```
/council should we use SQLite or Postgres for this service?
```

Manage the roster without touching config files:

```
/council add anthropic/claude-haiku-5 Haiku    # seat a member
/council remove Codex                          # unseat a member
/council chair google-antigravity/gemini-3-pro # change the chairman
/council roster                                # see the result
```

Changes persist to your `council.json` (project-level config wins if it defines the roster).

By default the council also sees a slice of your current session, so "is this plan
sound?" works mid-task. The main agent gets a `council` tool too, so plain
conversation works:

> ask the council whether this migration strategy is safe

The verdict lands in the chat (and in context, so the agent can act on it). Every run
also writes a **self-contained HTML dashboard** — roster, the 3-stage flow, each seat's
opinion with timing/tokens, the anonymization map, a who-ranked-whom matrix, and the
Borda leaderboard — plus a markdown transcript, to `<cwd>/.omp/council/`. Open the
latest with:

```
/council last
```

While the council deliberates, a live status widget in omp shows each seat thinking,
answering, reviewing, and the chair synthesizing.

## Config

Create `~/.omp/agent/council.json` (user-wide) or `<project>/.omp/council.json`
(per-project, wins). Any subset of keys; the rest fall back to defaults:

```json
{
  "members": [
    { "model": "anthropic/claude-fable-5", "nick": "Fable 5" },
    { "model": "anthropic/claude-opus-5", "nick": "Opus 5" },
    { "model": "openai-codex/gpt-5-codex", "nick": "Codex" },
    { "model": "google-antigravity/gemini-3-pro", "nick": "Gemini" }
  ],
  "chairman": "anthropic/claude-opus-5"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `members` | 4 seats | `{ model, nick?, effort? }` — any number of seats ≥ 2 |
| `chairman` | `anthropic/claude-opus-5` | who writes the final synthesis |
| `chairmanEffort` | `high` | reasoning effort: minimal/low/medium/high/xhigh/max |
| `effort` | `medium` | default member reasoning effort |
| `maxTokensOpinion` / `maxTokensReview` / `maxTokensSynthesis` | 3000 / 1500 / 4000 | per-stage output caps |
| `timeoutMs` | 240000 | per model call |
| `includeSessionContext` | `true` | prepend recent conversation to the question |
| `contextCharBudget` | 24000 | size of that slice |
| `writeTranscript` | `true` | full deliberation to `.omp/council/` |
| `exposeTool` | `true` | let the main agent convene the council itself |

## Cost

One run = `2N + 1` model calls (9 with four seats), each drawing on that provider's
subscription limits. Reviews are capped small; opinions and synthesis dominate.
A failed seat (rate limit, expired login) doesn't sink the council — it deliberates
with whoever showed up, and the verdict footer tells you who was missing.

## Development

```bash
bun install
bun test          # mocked-provider pipeline tests
bunx tsc --noEmit # typecheck against the real omp packages
```

## License

MIT © Koteshwar Rao M
