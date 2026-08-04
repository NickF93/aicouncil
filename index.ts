/**
 * aicouncil — a multi-model deliberation extension for oh-my-pi (omp).
 *
 * Implements the Karpathy llm-council flow on top of omp's provider layer, so
 * every seat runs on your existing subscriptions (Anthropic OAuth, Codex OAuth,
 * Antigravity OAuth, ...) — no extra API keys.
 *
 *   Stage 1  OPINIONS   — every member answers the question independently, in parallel
 *   Stage 2  REVIEW     — every member ranks the anonymized answers (A/B/C/...)
 *   Stage 3  SYNTHESIS  — the chairman reads answers + reviews and writes the final verdict
 *
 * Usage:
 *   /council <question>            convene the council
 *   /council models                list model IDs you are authenticated for
 *   /council roster                show the resolved seats + chairman
 *   /council live                  open the live agent-communication graph
 *   /council last                  open the latest deliberation dashboard
 *   /council add <model> [nick]    seat a new member (persisted to council.json)
 *   /council remove <nick|model>   unseat a member
 *   /council chair <model> [nick]  set the chairman
 *
 * The main agent also gets a `council` tool (read-only approval), so you can just
 * say "ask the council whether ..." mid-session.
 *
 * Config (later overrides earlier): `council.json` next to this file →
 * `~/.omp/agent/council.json` → `<cwd>/.omp/council.json`.
 * See DEFAULT_CONFIG below for the schema and defaults.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Effort, Model, UserMessage } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface MemberConfig {
	/** "provider/model-id" — run `/council models` for the exact IDs you have. */
	model: string;
	/** Display name in transcripts. Defaults to the model id. */
	nick?: string;
	/** Optional per-member reasoning effort: minimal|low|medium|high|xhigh|max */
	effort?: string;
}

interface CouncilConfig {
	members: MemberConfig[];
	/** "provider/model-id" of the synthesizing chairman. */
	chairman: string;
	chairmanNick?: string;
	chairmanEffort?: string;
	/** Reasoning effort for members without their own `effort`. */
	effort?: string;
	maxTokensOpinion: number;
	maxTokensReview: number;
	maxTokensSynthesis: number;
	/** Per-model-call timeout. */
	timeoutMs: number;
	/** Prepend recent session conversation to the question so the council has context. */
	includeSessionContext: boolean;
	/** Char budget for that context slice. */
	contextCharBudget: number;
	/** Write the full deliberation to <cwd>/.omp/council/. */
	writeTranscript: boolean;
	/** Also expose the council as a tool the main agent can call. */
	exposeTool: boolean;
	/** Serve a live communication graph (glowing agent-to-agent lines) and open it when a run starts. */
	liveGraph: boolean;
}

/**
 * Default roster: Fable 5 + Opus 5 (one Anthropic login covers both), Codex,
 * and Gemini via Antigravity. Opus 5 chairs.
 *
 * The model IDs below are best guesses — run `/council models` after
 * `/login`-ing each provider and fix any seat that reports "unresolved"
 * in `/council roster`. Fuzzy matching handles most drift (e.g.
 * "anthropic/opus" finds claude-opus-*).
 */
const DEFAULT_CONFIG: CouncilConfig = {
	members: [
		{ model: "anthropic/claude-fable-5", nick: "Fable 5" },
		{ model: "anthropic/claude-opus-5", nick: "Opus 5" },
		{ model: "openai-codex/gpt-5-codex", nick: "Codex" },
		{ model: "google-antigravity/gemini-3-pro", nick: "Gemini" },
	],
	chairman: "anthropic/claude-opus-5",
	chairmanNick: "Opus 5",
	chairmanEffort: "high",
	effort: "medium",
	maxTokensOpinion: 3000,
	maxTokensReview: 1500,
	maxTokensSynthesis: 4000,
	timeoutMs: 240_000,
	includeSessionContext: true,
	contextCharBudget: 24_000,
	writeTranscript: true,
	exposeTool: true,
	liveGraph: true,
};

function loadConfig(cwd: string): CouncilConfig {
	const merged: CouncilConfig = { ...DEFAULT_CONFIG };
	const here = (() => {
		try {
			return join(fileURLToPath(import.meta.url), "..");
		} catch {
			return undefined;
		}
	})();
	// Later entries override earlier ones: packaged defaults < user config < project config.
	const candidates = [
		here ? join(here, "council.json") : undefined,
		userConfigPath(),
		join(cwd, ".omp", "council.json"),
	];
	for (const path of candidates) {
		if (!path || !existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CouncilConfig>;
			Object.assign(merged, raw);
		} catch (error) {
			// Bad JSON should not brick the extension; surface it later via roster.
			configLoadError = `${path}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return merged;
}

let configLoadError: string | undefined;

const VERSION = "0.4.3";

// ---------------------------------------------------------------------------
// Roster mutation (/council add | remove | chair) — persisted to council.json
// ---------------------------------------------------------------------------

/** User-level config path — honors omp's PI_CODING_AGENT_DIR (profiles) like core does. */
function userConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	return join(agentDir, "council.json");
}

/**
 * Where a roster change should be written: the project config if it already
 * owns that key (it would override anything we write user-level), else the
 * user config.
 */
function pickWriteTarget(cwd: string, key: "members" | "chairman"): string {
	const projectPath = join(cwd, ".omp", "council.json");
	if (existsSync(projectPath)) {
		try {
			const json = JSON.parse(readFileSync(projectPath, "utf-8")) as Record<string, unknown>;
			if (json[key] !== undefined) return projectPath;
		} catch {
			// unreadable project config — fall through to user config
		}
	}
	return userConfigPath();
}

function updateConfigFile(path: string, mutate: (json: Record<string, unknown>) => void): void {
	let json: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			json = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		} catch (error) {
			throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}) — fix it before using roster commands`);
		}
	}
	mutate(json);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Model resolution + side-calls
// ---------------------------------------------------------------------------

interface Seat {
	nick: string;
	spec: string;
	model: Model | undefined;
	effort?: string;
}

/** Resolve "provider/id" exactly, then fall back to token containment over authenticated models. */
function resolveModel(ctx: ExtensionContext, spec: string): Model | undefined {
	const direct = ctx.models.resolve(spec);
	if (direct) return direct;
	const all = ctx.models.list();
	const slash = spec.indexOf("/");
	const provider = slash > 0 ? spec.slice(0, slash).toLowerCase() : undefined;
	const idPart = (slash > 0 ? spec.slice(slash + 1) : spec).toLowerCase();
	const tokens = idPart.split(/[^a-z0-9.]+/).filter(Boolean);
	if (tokens.length === 0) return undefined;
	const candidates = all.filter(
		m =>
			(!provider || m.provider.toLowerCase() === provider) &&
			tokens.every(t => m.id.toLowerCase().includes(t)),
	);
	// Shortest matching id ≈ the base model (avoids -thinking/-preview variants).
	candidates.sort((a, b) => a.id.length - b.id.length);
	return candidates[0];
}

function resolveSeats(ctx: ExtensionContext, config: CouncilConfig): { members: Seat[]; chairman: Seat } {
	const members = config.members.map(m => ({
		nick: m.nick ?? m.model,
		spec: m.model,
		model: resolveModel(ctx, m.model),
		effort: m.effort ?? config.effort,
	}));
	const chairman: Seat = {
		nick: config.chairmanNick ?? config.chairman,
		spec: config.chairman,
		model: resolveModel(ctx, config.chairman),
		effort: config.chairmanEffort ?? config.effort,
	};
	return { members, chairman };
}

interface CallResult {
	text: string;
	error?: string;
	inputTokens?: number;
	outputTokens?: number;
	elapsedMs: number;
}

/**
 * Resolve request auth against whatever surface this omp/pi build exposes.
 * The extension-facing registry API has drifted across versions
 * (getApiKeyAndHeaders → getApiKey/getProviderHeaders → resolver), so we
 * capability-detect instead of assuming one method exists.
 */
type ResolvedAuth = { ok: true; apiKey: unknown; headers?: Record<string, string> } | { ok: false; error: string };

async function resolveAuth(ctx: ExtensionContext, model: Model): Promise<ResolvedAuth> {
	const reg = ctx.modelRegistry as unknown as {
		getApiKeyAndHeaders?: (m: Model) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
		getApiKey?: (m: Model, sessionId?: string) => Promise<string | undefined>;
		getProviderHeaders?: (provider: string) => Record<string, string> | undefined;
		resolver?: (m: Model, sessionId?: string) => unknown;
	};
	const headers = (() => {
		try {
			return typeof reg?.getProviderHeaders === "function" ? reg.getProviderHeaders(model.provider) : undefined;
		} catch {
			return undefined;
		}
	})();
	try {
		if (typeof reg?.getApiKeyAndHeaders === "function") {
			const auth = await reg.getApiKeyAndHeaders(model);
			if (auth?.ok && auth.apiKey) return { ok: true, apiKey: auth.apiKey, headers: auth.headers ?? headers };
			return { ok: false, error: auth?.error ?? `no credentials for ${model.provider} — try /login ${model.provider}` };
		}
		if (typeof reg?.getApiKey === "function") {
			const key = await reg.getApiKey(model);
			if (key) return { ok: true, apiKey: key, headers };
			return { ok: false, error: `no credentials for ${model.provider} — try /login ${model.provider}` };
		}
		if (typeof reg?.resolver === "function") {
			return { ok: true, apiKey: reg.resolver(model), headers };
		}
		return {
			ok: false,
			error: "this omp/pi build exposes no known auth API on ctx.modelRegistry — run /council doctor and report the output at github.com/mynenikoteshwarrao/aicouncil/issues",
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** One tool-less side-call. Never throws — errors come back in `.error`. */
async function callModel(
	ctx: ExtensionContext,
	seat: Seat,
	systemPrompt: string,
	userText: string,
	maxTokens: number,
	timeoutMs: number,
	outerSignal?: AbortSignal,
): Promise<CallResult> {
	const started = Date.now();
	const model = seat.model;
	if (!model) return { text: "", error: `model "${seat.spec}" not resolved`, elapsedMs: 0 };

	const auth = await resolveAuth(ctx, model);
	if (!auth.ok) return { text: "", error: auth.error, elapsedMs: Date.now() - started };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
	const onOuterAbort = () => controller.abort(outerSignal?.reason);
	outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
	if (outerSignal?.aborted) controller.abort(outerSignal.reason);

	try {
		const message: UserMessage = { role: "user", content: userText, timestamp: Date.now() };
		const response: AssistantMessage = await completeSimple(
			model,
			{ systemPrompt: [systemPrompt], messages: [message], tools: [] },
			{
				// string or ApiKeyResolver depending on which registry surface answered
				apiKey: auth.apiKey as string,
				headers: auth.headers,
				signal: controller.signal,
				maxTokens,
				reasoning: seat.effort as Effort | undefined,
			},
		);
		const elapsedMs = Date.now() - started;
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return {
				text: "",
				error: response.errorMessage ?? `stopReason=${response.stopReason}`,
				elapsedMs,
			};
		}
		let text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n")
			.trim();
		if (!text) {
			// Reasoning models occasionally emit only thinking blocks; salvage those.
			text = response.content
				.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking")
				.map(c => c.thinking)
				.join("\n")
				.trim();
		}
		if (!text) return { text: "", error: "empty response", elapsedMs };
		return {
			text,
			inputTokens: response.usage?.input,
			outputTokens: response.usage?.output,
			elapsedMs,
		};
	} catch (error) {
		return {
			text: "",
			error: error instanceof Error ? error.message : String(error),
			elapsedMs: Date.now() - started,
		};
	} finally {
		clearTimeout(timer);
		outerSignal?.removeEventListener("abort", onOuterAbort);
	}
}

// ---------------------------------------------------------------------------
// Session context
// ---------------------------------------------------------------------------

/** Recent user/assistant text from the session, newest-last, capped by charBudget. */
function collectSessionContext(ctx: ExtensionContext, charBudget: number): string | undefined {
	const lines: string[] = [];
	let used = 0;
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0 && used < charBudget; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message;
		let text = "";
		if (msg.role === "user") {
			text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("\n");
		} else if (msg.role === "assistant") {
			text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("\n");
		} else {
			continue;
		}
		text = text.trim();
		if (!text) continue;
		const line = `${msg.role === "user" ? "User" : "Assistant"}: ${text}`;
		used += line.length;
		lines.push(line.length > charBudget ? `${line.slice(0, charBudget)}…` : line);
	}
	if (lines.length === 0) return undefined;
	lines.reverse();
	return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const LETTERS = "ABCDEFGHIJKLMNOP";

function opinionSystemPrompt(nick: string, n: number): string {
	return [
		`You are ${nick}, one of ${n} independent members of an AI council convened to answer a question.`,
		`Give YOUR best answer. Rules:`,
		`- Be direct and concrete. Commit to positions; if something is uncertain, flag it in one line rather than hedging everything.`,
		`- If the question involves code or a technical decision, be precise and show the key reasoning or snippet.`,
		`- No preamble, no "as an AI". Answer as a sharp domain expert would.`,
	].join("\n");
}

function reviewSystemPrompt(nick: string, n: number): string {
	return [
		`You are ${nick}, a member of an AI council. The question and ${n} anonymized responses follow (one may be your own — you do not know which).`,
		`Evaluate each response for accuracy, insight, and completeness. Be adversarial: hunt for factual errors, weak reasoning, and missed considerations. Praise only what earns it.`,
		`For each response give 1-3 sentences of assessment.`,
		`Then end with EXACTLY one final line in this format (best first):`,
		`RANKING: A > B > C`,
	].join("\n");
}

function chairmanSystemPrompt(nick: string): string {
	return [
		`You are ${nick}, chairman of an AI council. You have the question, the members' independent answers (anonymized), and their peer reviews of each other.`,
		`Write the council's FINAL answer:`,
		`- Synthesize the strongest, correct material. Weigh arguments by substance, not popularity.`,
		`- Where members disagreed, name the disagreement explicitly and make the call yourself, with reasoning. Do not average positions into mush — a false consensus is worse than an honest split.`,
		`- Correct any factual errors the reviews exposed.`,
		`- Structure: the answer itself first; then, if relevant, a short "Where the council split" section.`,
	].join("\n");
}

function questionBlock(question: string, sessionContext: string | undefined): string {
	const parts: string[] = [];
	if (sessionContext) {
		parts.push(`<session-context>\nRecent conversation for background (may or may not be relevant):\n\n${sessionContext}\n</session-context>\n`);
	}
	parts.push(`Question for the council:\n\n${question}`);
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Ranking aggregation (Borda count over parsed RANKING lines)
// ---------------------------------------------------------------------------

function parseRanking(text: string, n: number): number[] | undefined {
	const matches = [...text.matchAll(/RANKING:\s*([A-Z](?:\s*>\s*[A-Z])*)/gi)];
	const last = matches[matches.length - 1];
	if (!last?.[1]) return undefined;
	const order = last[1]
		.split(">")
		.map(s => LETTERS.indexOf(s.trim().toUpperCase()))
		.filter(i => i >= 0 && i < n);
	return new Set(order).size >= 2 ? [...new Set(order)] : undefined;
}

/** Returns average Borda points per seat index (higher = better), or undefined if nothing parsed. */
function aggregateRankings(reviews: string[], n: number): number[] | undefined {
	const points = new Array<number>(n).fill(0);
	let voters = 0;
	for (const review of reviews) {
		const order = parseRanking(review, n);
		if (!order) continue;
		voters++;
		order.forEach((seatIdx, pos) => {
			points[seatIdx] = (points[seatIdx] ?? 0) + (n - pos);
		});
	}
	if (voters === 0) return undefined;
	return points.map(p => p / voters);
}

// ---------------------------------------------------------------------------
// Deliberation dashboard (self-contained HTML, one per run)
// ---------------------------------------------------------------------------

export interface SeatRecord {
	letter: string;
	nick: string;
	model: string;
	answer?: string;
	answerMs?: number;
	answerTokens?: number;
	review?: string;
	reviewMs?: number;
	/** Rank order this seat gave (array of seat indices, best first), if parsed. */
	rankingGiven?: number[];
	error?: string;
}

export interface DeliberationRecord {
	question: string;
	startedAtIso: string;
	durationMs: number;
	chairman: { nick: string; model: string; error?: string; ms?: number };
	seats: SeatRecord[];
	/** Average Borda points per seat index, if any rankings parsed. */
	borda?: number[];
	verdict?: string;
	failures: string[];
	settings: { effort?: string; chairmanEffort?: string; timeoutMs: number; contextIncluded: boolean };
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Tiny markdown renderer for answer bodies — headers, fences, inline code, bold, lists. */
function mdToHtml(md: string): string {
	const fences: string[] = [];
	let s = md.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
		fences.push(`<pre class="code">${escapeHtml(code.replace(/^[a-z]*\n/, ""))}</pre>`);
		return ` ${fences.length - 1} `;
	});
	s = escapeHtml(s);
	s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
	s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/gm, "$1<em>$2</em>");
	s = s.replace(/^######? (.+)$/gm, "<h5>$1</h5>").replace(/^#{1,4} (.+)$/gm, "<h4>$1</h4>");
	s = s.replace(/^[-*] (.+)$/gm, "<li>$1</li>").replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
	s = s
		.split(/\n{2,}/)
		.map(p => (/^\s*<(h4|h5|ul|pre)/.test(p) ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`))
		.join("\n");
	return s.replace(/ (\d+) /g, (_m, i: string) => fences[Number(i)]!);
}

function fmtMs(ms: number | undefined): string {
	if (ms === undefined) return "–";
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Categorical slots (validated reference palette; color follows the seat, fixed order). */
const SEAT_COLORS_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const SEAT_COLORS_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export function renderDashboardHtml(rec: DeliberationRecord): string {
	const n = rec.seats.length;
	const answered = rec.seats.filter(s => s.answer);
	const reviewed = rec.seats.filter(s => s.review);
	const seatVars = rec.seats
		.map((_s, i) => `--seat-${i}: ${SEAT_COLORS_LIGHT[i % 8]}; --seat-${i}-d: ${SEAT_COLORS_DARK[i % 8]};`)
		.join(" ");

	// Borda leaderboard, sorted by score, colors stay with the seat entity.
	const maxScore = rec.borda ? Math.max(...rec.borda, 0.001) : 0;
	const leaderboard = rec.borda
		? rec.seats
				.map((s, i) => ({ s, i, score: rec.borda![i] ?? 0 }))
				.filter(e => e.s.answer)
				.sort((a, b) => b.score - a.score)
				.map(
					e => `
      <div class="lb-row" title="${escapeHtml(e.s.nick)} — avg ${e.score.toFixed(1)} Borda pts from peer rankings">
        <span class="lb-name"><i class="chip" style="background:var(--seat-${e.i})"></i>${escapeHtml(e.s.nick)}</span>
        <span class="lb-track"><span class="lb-bar" style="width:${Math.max(3, (e.score / maxScore) * 100)}%;background:var(--seat-${e.i})"></span></span>
        <span class="lb-val">${e.score.toFixed(1)}</span>
      </div>`,
				)
				.join("")
		: `<p class="muted">No parseable rankings this run.</p>`;

	// Reviewer × subject rank matrix. rank 1 = strongest ordinal step.
	const ordinal = ["#86b6ef", "#9ec5f4", "#b7d3f6", "#cde2fb", "#e7f0fc", "#f1f6fd", "#f6f9fe", "#fafcff"];
	const matrixHead = answered.map(s => `<th title="${escapeHtml(s.nick)}">${s.letter}</th>`).join("");
	const matrixRows = reviewed
		.map(r => {
			const cells = answered
				.map(subject => {
					const subjectIdx = rec.seats.indexOf(subject);
					const pos = r.rankingGiven?.indexOf(subjectIdx);
					if (pos === undefined || pos < 0) return `<td class="na">–</td>`;
					const bg = ordinal[Math.min(pos, ordinal.length - 1)]!;
					return `<td style="background:${bg}" title="${escapeHtml(r.nick)} ranked ${escapeHtml(subject.nick)} #${pos + 1}">${pos + 1}</td>`;
				})
				.join("");
			const ri = rec.seats.indexOf(r);
			return `<tr><th><i class="chip" style="background:var(--seat-${ri})"></i>${escapeHtml(r.nick)}</th>${cells}</tr>`;
		})
		.join("");

	const seatCards = rec.seats
		.map((s, i) => {
			const status = s.answer
				? `<span class="ok">✓ answered</span> · ${fmtMs(s.answerMs)}${s.answerTokens ? ` · ${s.answerTokens} tok` : ""}`
				: `<span class="fail">✗ ${escapeHtml(s.error ?? "no answer")}</span>`;
			const review = s.review
				? `<details><summary>Peer review (${fmtMs(s.reviewMs)})</summary><div class="body">${mdToHtml(s.review)}</div></details>`
				: "";
			const answer = s.answer
				? `<details><summary>Opinion — Seat ${s.letter}</summary><div class="body">${mdToHtml(s.answer)}</div></details>`
				: "";
			return `
    <article class="card seat">
      <header><i class="chip big" style="background:var(--seat-${i})"></i>
        <div><h3>${escapeHtml(s.nick)} <span class="badge">Seat ${s.letter}</span></h3>
        <p class="model">${escapeHtml(s.model)}</p></div>
      </header>
      <p class="status">${status}</p>
      ${answer}${review}
    </article>`;
		})
		.join("");

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Council — ${escapeHtml(rec.question.slice(0, 60))}</title>
<style>
  :root { color-scheme: light dark;
    --surface:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
    --grid:#e1e0d9; --border:rgba(11,11,11,.10); --good:#0ca30c; --critical:#d03b3b; ${seatVars} }
  @media (prefers-color-scheme: dark) { :root {
    --surface:#1a1a19; --page:#0d0d0d; --ink:#ffffff; --ink2:#c3c2b7; --grid:#2c2c2a; --border:rgba(255,255,255,.10);
    ${rec.seats.map((_s, i) => `--seat-${i}: var(--seat-${i}-d);`).join(" ")} } }
  * { box-sizing:border-box } body { margin:0; background:var(--page); color:var(--ink);
    font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; padding:28px; }
  main { max-width:1080px; margin:0 auto; display:grid; gap:16px }
  h1 { font-size:21px; margin:0 0 2px } h2 { font-size:15px; margin:0 0 10px } h3 { font-size:15px; margin:0 }
  h4,h5 { margin:12px 0 4px } .muted { color:var(--muted) } .meta { color:var(--ink2); font-size:13px }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px 18px }
  .flow { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:13px; color:var(--ink2) }
  .stage { border:1px solid var(--grid); border-radius:999px; padding:4px 12px; background:var(--surface) }
  .stage b { color:var(--ink) } .arrow { color:var(--muted) }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px }
  .seat header { display:flex; gap:10px; align-items:center; margin-bottom:6px }
  .chip { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:7px; flex:none }
  .chip.big { width:14px; height:14px; border-radius:4px; margin:0 }
  .badge { font-size:11px; color:var(--ink2); border:1px solid var(--grid); border-radius:999px; padding:1px 8px; margin-left:6px; vertical-align:2px }
  .model { margin:0; font-size:12px; color:var(--muted); font-family:ui-monospace,monospace }
  .status { font-size:13px; color:var(--ink2); margin:4px 0 8px }
  .ok { color:var(--good); font-weight:600 } .fail { color:var(--critical); font-weight:600 }
  details { border-top:1px solid var(--grid); padding:7px 0 } summary { cursor:pointer; font-size:13px; color:var(--ink2) }
  .body { font-size:14px } .body p { margin:8px 0 }
  .code, code { font-family:ui-monospace,monospace; font-size:12.5px; background:var(--page); border:1px solid var(--grid); border-radius:6px }
  code { padding:1px 5px } .code { padding:10px 12px; overflow:auto; white-space:pre-wrap }
  .lb-row { display:grid; grid-template-columns:170px 1fr 46px; gap:10px; align-items:center; margin:7px 0; font-size:13px }
  .lb-name { display:flex; align-items:center; color:var(--ink2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .lb-track { background:var(--page); border-radius:4px; height:14px; border-left:2px solid var(--grid) }
  .lb-bar { display:block; height:100%; border-radius:0 4px 4px 0 }
  .lb-val { text-align:right; font-variant-numeric:tabular-nums; color:var(--ink) }
  table { border-collapse:separate; border-spacing:2px; font-size:13px; font-variant-numeric:tabular-nums }
  th { font-weight:600; color:var(--ink2); text-align:left; padding:4px 8px }
  td { width:38px; text-align:center; padding:4px 0; border-radius:4px; color:#0b0b0b } td.na { color:var(--muted); background:transparent }
  .verdict { border-left:3px solid var(--seat-0) } .fails { border-left:3px solid var(--critical) }
  footer { color:var(--muted); font-size:12px; text-align:center; padding:8px }
</style></head><body><main>
  <div class="card">
    <h1>🏛️ Council deliberation</h1>
    <p class="meta">${escapeHtml(rec.startedAtIso)} · total ${fmtMs(rec.durationMs)} · effort ${escapeHtml(rec.settings.effort ?? "default")} · chair effort ${escapeHtml(rec.settings.chairmanEffort ?? "default")} · timeout ${Math.round(rec.settings.timeoutMs / 1000)}s · session context ${rec.settings.contextIncluded ? "on" : "off"}</p>
    <p><strong>Q:</strong> ${escapeHtml(rec.question)}</p>
    <div class="flow">
      <span class="stage"><b>1 · Opinions</b> ${answered.length}/${n} answered</span><span class="arrow">→</span>
      <span class="stage"><b>2 · Anonymized review</b> ${reviewed.length} reviewers</span><span class="arrow">→</span>
      <span class="stage"><b>3 · Synthesis</b> ${escapeHtml(rec.chairman.nick)}${rec.chairman.error ? " ✗" : " ✓"}</span>
    </div>
  </div>
  <div class="card verdict">
    <h2>Verdict — chaired by ${escapeHtml(rec.chairman.nick)} <span class="model">${escapeHtml(rec.chairman.model)}</span></h2>
    <div class="body">${rec.verdict ? mdToHtml(rec.verdict) : `<p class="fail">✗ Chairman failed: ${escapeHtml(rec.chairman.error ?? "unknown")}</p>`}</div>
  </div>
  <div class="card">
    <h2>Peer ranking — Borda average (higher is better)</h2>
    ${leaderboard}
    ${matrixRows ? `<h2 style="margin-top:16px">Who ranked whom (1 = best)</h2><table><thead><tr><th>reviewer ↓</th>${matrixHead}</tr></thead><tbody>${matrixRows}</tbody></table>` : ""}
  </div>
  <div class="grid">${seatCards}</div>
  ${rec.failures.length ? `<div class="card fails"><h2>⚠ Issues</h2><ul>${rec.failures.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>` : ""}
  <footer>generated by aicouncil · the letters are what reviewers saw; identities were revealed only after ranking</footer>
</main></body></html>`;
}

// ---------------------------------------------------------------------------
// Live communication graph — agents as nodes, glowing lines while they talk.
// Served from inside omp (Bun.serve) with SSE; auto-opens on run start.
// ---------------------------------------------------------------------------

export function liveGraphPageHtml(demoEvents?: [number, Record<string, unknown>][]): string {
	const demo = demoEvents ? `<script>window.__DEMO__=${JSON.stringify(demoEvents)};</script>` : "";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>aicouncil — live</title>
<style>
  body{margin:0;background:#0d0d0d;color:#fff;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
  header{display:flex;gap:8px;padding:14px 18px 6px;align-items:center;flex-wrap:wrap}
  h1{font-size:15px;margin:0 14px 0 0}
  .chipS{border:1px solid #2c2c2a;border-radius:999px;padding:3px 12px;color:#898781;font-size:12px;transition:all .3s}
  .chipS.on{color:#fff;border-color:#3987e5;box-shadow:0 0 14px rgba(57,135,229,.4)}
  #q{padding:2px 18px 0;color:#c3c2b7;font-size:13px;max-width:920px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #wrap{display:flex;justify-content:center}
  svg{display:block}
  .lane{fill:none;stroke:#1f1f1e;stroke-width:1}
  .flow{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-dasharray:5 14;animation:march .7s linear infinite;filter:drop-shadow(0 0 7px currentColor)}
  @keyframes march{to{stroke-dashoffset:-19}}
  .node circle{fill:#1a1a19;stroke-width:3;transition:filter .3s}
  .node.active circle{animation:pulse 1.1s ease-in-out infinite}
  @keyframes pulse{0%,100%{filter:drop-shadow(0 0 4px currentColor)}50%{filter:drop-shadow(0 0 16px currentColor)}}
  .node text{fill:#c3c2b7;font-size:12px;text-anchor:middle}
  .node .glyph{font-size:13px;fill:#fff;text-anchor:middle;dominant-baseline:central}
  .node .sub{fill:#898781;font-size:10px}
  #log{position:fixed;left:0;right:0;bottom:0;padding:12px 18px;font:12px ui-monospace,monospace;color:#898781}
  #log div:first-child{color:#c3c2b7}
  #banner{position:fixed;top:64px;right:18px;background:#1a1a19;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:12px 16px;font-size:13px;display:none;max-width:280px}
  #banner b{color:#0ca30c}
</style>${demo}</head><body>
<header><h1>🏛️ aicouncil live</h1>
  <span class="chipS" id="c1">1 · Opinions</span><span class="chipS" id="c2">2 · Anonymized review</span><span class="chipS" id="c3">3 · Synthesis</span>
  <span class="chipS" id="clock"></span></header>
<div id="q">waiting for a council to convene… run /council &lt;question&gt; in omp</div>
<div id="wrap"><svg id="g" width="980" height="540" viewBox="0 0 980 540"></svg></div>
<div id="banner"></div><div id="log"></div>
<script>
(function(){
  var NS="http://www.w3.org/2000/svg";
  var S={seats:[],chair:null,hub:{x:390,y:270,nick:"Q",color:"#898781"},flows:{},stage:0,t0:0,done:false};
  var svg=document.getElementById("g");
  function el(n,a){var e=document.createElementNS(NS,n);for(var k in a)e.setAttribute(k,a[k]);return e}
  function layout(){
    var cx=390,cy=270,R=190;
    for(var i=0;i<S.seats.length;i++){
      var ang=-Math.PI/2+i*2*Math.PI/S.seats.length;
      S.seats[i].x=cx+R*Math.cos(ang);S.seats[i].y=cy+R*Math.sin(ang);
    }
    if(S.chair){S.chair.x=840;S.chair.y=270}
  }
  function curve(a,b){
    var mx=(a.x+b.x)/2,my=(a.y+b.y)/2,dx=b.x-a.x,dy=b.y-a.y,l=Math.sqrt(dx*dx+dy*dy)||1;
    var off=Math.min(46,l/5),px=-dy/l*off,py=dx/l*off;
    return "M"+a.x+" "+a.y+" Q "+(mx+px)+" "+(my+py)+" "+b.x+" "+b.y;
  }
  function nodeOf(nick){if(nick==="Q")return S.hub;if(nick==="\\u2696")return S.chair;
    for(var i=0;i<S.seats.length;i++)if(S.seats[i].nick===nick)return S.seats[i];
    if(S.chair&&S.chair.nick===nick)return S.chair;return null}
  function render(){
    svg.innerHTML="";
    var i,s;
    for(i=0;i<S.seats.length;i++){s=S.seats[i];
      svg.appendChild(el("path",{class:"lane",d:curve(S.hub,s)}));
      if(S.chair)svg.appendChild(el("path",{class:"lane",d:curve(s,S.chair)}));
    }
    for(var id in S.flows){var f=S.flows[id];var a=nodeOf(f.from),b=nodeOf(f.to);if(!a||!b)continue;
      var p=el("path",{class:"flow",d:curve(a,b),stroke:f.color});p.style.color=f.color;svg.appendChild(p);
    }
    drawNode(S.hub,"#898781","Q","",false,18);
    for(i=0;i<S.seats.length;i++){s=S.seats[i];drawNode(s,s.color,s.nick,s.glyph||"",!!s.active,22)}
    if(S.chair)drawNode(S.chair,S.chair.color,S.chair.nick+" ⚖",S.chair.glyph||"",!!S.chair.active,26);
  }
  function drawNode(n,color,label,glyph,active,r){
    var g=el("g",{class:"node"+(active?" active":"")});g.style.color=color;
    var c=el("circle",{cx:n.x,cy:n.y,r:r,stroke:color});g.appendChild(c);
    var t1=el("text",{class:"glyph",x:n.x,y:n.y});t1.textContent=glyph;g.appendChild(t1);
    var t2=el("text",{x:n.x,y:n.y+r+16});t2.textContent=label;g.appendChild(t2);
    if(n.sub){var t3=el("text",{class:"sub",x:n.x,y:n.y+r+30});t3.textContent=n.sub;g.appendChild(t3)}
    svg.appendChild(g);
  }
  var logEl=document.getElementById("log"),logs=[];
  function log(m){logs.unshift(m);logs=logs.slice(0,5);logEl.innerHTML="";
    for(var i=0;i<logs.length;i++){var d=document.createElement("div");d.textContent=logs[i];logEl.appendChild(d)}}
  function stageChips(){for(var i=1;i<=3;i++)document.getElementById("c"+i).className="chipS"+(S.stage===i?" on":"")}
  setInterval(function(){if(S.t0&&!S.done)document.getElementById("clock").textContent=((Date.now()-S.t0)/1000).toFixed(0)+"s"},500);
  function onEvent(ev){
    var n;
    switch(ev.type){
      case "run_start":
        S.seats=ev.seats.map(function(x){return{nick:x.nick,color:x.color}});
        S.chair={nick:ev.chair.nick,color:ev.chair.color};S.stage=1;S.flows={};S.done=false;S.t0=Date.now();
        document.getElementById("q").textContent="Q: "+ev.question;
        document.getElementById("banner").style.display="none";
        layout();log("council convened — "+S.seats.length+" seats, chaired by "+ev.chair.nick);break;
      case "op_start":n=nodeOf(ev.seat);if(!n)break;n.active=true;
        S.flows["q-"+ev.seat]={from:"Q",to:ev.seat,color:n.color};log(ev.seat+" is forming an opinion…");break;
      case "op_end":n=nodeOf(ev.seat);if(!n)break;n.active=false;n.glyph=ev.ok?"✓":"✗";n.sub=ev.ms?(ev.ms/1000).toFixed(1)+"s":"";
        delete S.flows["q-"+ev.seat];log(ev.seat+(ev.ok?" answered ("+(ev.ms/1000).toFixed(1)+"s)":" failed"));break;
      case "review_start":S.stage=2;n=nodeOf(ev.seat);if(!n)break;n.active=true;
        for(var i=0;i<S.seats.length;i++){var o=S.seats[i];if(o.nick!==ev.seat&&o.glyph==="✓")
          S.flows["r-"+ev.seat+"-"+o.nick]={from:o.nick,to:ev.seat,color:o.color}}
        log(ev.seat+" is reading the anonymized answers…");break;
      case "review_end":n=nodeOf(ev.seat);if(!n)break;n.active=false;
        for(var id in S.flows)if(id.indexOf("r-"+ev.seat+"-")===0)delete S.flows[id];
        log(ev.seat+(ev.ok?" submitted rankings":" review failed"));break;
      case "synth_start":S.stage=3;if(S.chair)S.chair.active=true;
        for(var j=0;j<S.seats.length;j++){var sj=S.seats[j];if(sj.glyph==="✓")
          S.flows["s-"+sj.nick]={from:sj.nick,to:"\\u2696",color:sj.color}}
        log(S.chair.nick+" is synthesizing the verdict…");break;
      case "synth_end":if(S.chair){S.chair.active=false;S.chair.glyph=ev.ok?"✓":"✗"}
        for(var id2 in S.flows)if(id2.indexOf("s-")===0)delete S.flows[id2];
        log(ev.ok?"verdict ready":"synthesis failed");break;
      case "done":S.done=true;
        var b=document.getElementById("banner");b.style.display="block";
        b.innerHTML="<b>✓ deliberation complete</b> · "+(ev.durationMs/1000).toFixed(0)+"s"+
          (ev.ranking&&ev.ranking.length?"<br>peer ranking: "+ev.ranking.join(" › "):"");
        log("done in "+(ev.durationMs/1000).toFixed(0)+"s — see the dashboard for the full record");break;
    }
    stageChips();render();
  }
  render();stageChips();
  if(window.__DEMO__){for(var i=0;i<window.__DEMO__.length;i++)(function(p){setTimeout(function(){onEvent(p[1])},p[0])})(window.__DEMO__[i])}
  else{var es=new EventSource("/events");es.onmessage=function(m){try{onEvent(JSON.parse(m.data))}catch(e){}}}
})();
</script></body></html>`;
}

interface LiveServerHandle {
	port: number;
	push: (ev: Record<string, unknown>) => void;
	stop: () => void;
}

let liveServer: LiveServerHandle | undefined;
let liveHistory: Record<string, unknown>[] = [];
let liveOpened = false;

/** Start (or reuse) the SSE server on a random localhost port. Returns undefined off-Bun. */
function ensureLiveServer(): LiveServerHandle | undefined {
	if (liveServer) return liveServer;
	const BunRt = (globalThis as { Bun?: { serve?: (opts: unknown) => { port: number; stop: (force?: boolean) => void } } }).Bun;
	if (!BunRt?.serve) return undefined;
	const encoder = new TextEncoder();
	const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	try {
		const server = BunRt.serve({
			port: 0,
			fetch: (req: Request) => {
				const path = new URL(req.url).pathname;
				if (path === "/") {
					return new Response(liveGraphPageHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
				}
				if (path === "/events") {
					let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
					const stream = new ReadableStream<Uint8Array>({
						start(c) {
							ctrl = c;
							clients.add(c);
							for (const ev of liveHistory) c.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
						},
						cancel() {
							if (ctrl) clients.delete(ctrl);
						},
					});
					return new Response(stream, {
						headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		liveServer = {
			port: server.port,
			push: ev => {
				liveHistory = ev.type === "run_start" ? [ev] : [...liveHistory, ev];
				const data = encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
				for (const c of [...clients]) {
					try {
						c.enqueue(data);
					} catch {
						clients.delete(c);
					}
				}
			},
			stop: () => {
				try {
					server.stop(true);
				} catch {
					// already down
				}
				liveServer = undefined;
			},
		};
		return liveServer;
	} catch {
		return undefined;
	}
}

function livePush(ev: Record<string, unknown>): void {
	liveServer?.push(ev);
}

/** Open a file or URL in the default browser/app, best-effort. */
async function openExternal(pi: ExtensionAPI | undefined, target: string): Promise<boolean> {
	if (!pi) return false;
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try {
		await pi.exec(opener, [target]);
		return true;
	} catch {
		return false;
	}
}

let piRef: ExtensionAPI | undefined;

// ---------------------------------------------------------------------------
// The council run
// ---------------------------------------------------------------------------

interface CouncilRunResult {
	verdict: string;
	summaryMarkdown: string;
	transcriptPath?: string;
	dashboardPath?: string;
	failures: string[];
}

async function runCouncil(
	ctx: ExtensionContext,
	question: string,
	signal?: AbortSignal,
	onProgress?: (status: string) => void,
): Promise<CouncilRunResult> {
	const config = loadConfig(ctx.cwd);
	const { members, chairman } = resolveSeats(ctx, config);
	const failures: string[] = [];
	const startedAt = Date.now();

	// Live TUI widget: per-seat status through the three stages.
	const seatStage = new Map<string, string>();
	const renderWidget = ctx.hasUI
		? () => {
				const lines = [`🏛️ council · ${question.slice(0, 60)}${question.length > 60 ? "…" : ""}`];
				for (const [nick, state] of seatStage) lines.push(`   ${nick.padEnd(12)} ${state}`);
				ctx.ui.setWidget("council", lines);
			}
		: () => {};
	const setStage = (nick: string, state: string) => {
		seatStage.set(nick, state);
		renderWidget();
	};

	const active = members.filter(m => m.model).slice(0, LETTERS.length);
	for (const m of members.filter(m => !m.model)) {
		failures.push(`${m.nick}: model "${m.spec}" not found among authenticated models (run /council models, then /login the provider or fix council.json)`);
	}
	if (active.length < 2) {
		throw new Error(
			`Council needs at least 2 resolvable members, got ${active.length}.\n${failures.join("\n")}`,
		);
	}
	if (!chairman.model) {
		throw new Error(`Chairman "${chairman.spec}" not resolved. Run /council models and fix council.json.`);
	}

	const sessionContext = config.includeSessionContext
		? collectSessionContext(ctx, config.contextCharBudget)
		: undefined;
	const qBlock = questionBlock(question, sessionContext);

	// Shuffle seat → letter assignment so letter order carries no information.
	const shuffled = [...active];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
	}

	// Live graph: start/reuse the SSE server and announce the run.
	if (config.liveGraph) {
		const srv = ensureLiveServer();
		if (srv) {
			const chairIdx = shuffled.findIndex(
				s => s.model && `${s.model.provider}/${s.model.id}` === `${chairman.model!.provider}/${chairman.model!.id}`,
			);
			livePush({
				type: "run_start",
				question: question.slice(0, 160),
				seats: shuffled.map((s, i) => ({ nick: s.nick, color: SEAT_COLORS_DARK[i % 8] })),
				chair: { nick: chairman.nick, color: chairIdx >= 0 ? SEAT_COLORS_DARK[chairIdx % 8] : "#9085e9" },
			});
			if (!liveOpened) {
				liveOpened = true;
				void openExternal(piRef, `http://localhost:${srv.port}/`);
			}
		}
	}

	// -- Stage 1: opinions ----------------------------------------------------
	onProgress?.(`council: ${shuffled.length} members deliberating…`);
	const opinions = await Promise.all(
		shuffled.map(seat => {
			setStage(seat.nick, "⏳ forming opinion…");
			livePush({ type: "op_start", seat: seat.nick });
			return callModel(ctx, seat, opinionSystemPrompt(seat.nick, shuffled.length), qBlock, config.maxTokensOpinion, config.timeoutMs, signal).then(res => {
				setStage(seat.nick, res.error ? `✗ ${res.error.slice(0, 40)}` : `✓ answered ${fmtMs(res.elapsedMs)}`);
				livePush({ type: "op_end", seat: seat.nick, ok: !res.error, ms: res.elapsedMs });
				return res;
			});
		}),
	);

	const answered: { seat: Seat; letter: string; answer: string }[] = [];
	opinions.forEach((res, i) => {
		const seat = shuffled[i]!;
		if (res.error || !res.text) {
			failures.push(`${seat.nick} (opinion): ${res.error ?? "no answer"}`);
		} else {
			answered.push({ seat, letter: LETTERS[answered.length]!, answer: res.text });
		}
	});
	if (answered.length < 2) {
		throw new Error(`Only ${answered.length} member(s) answered — not enough to deliberate.\n${failures.join("\n")}`);
	}

	const answersBlock = answered
		.map(a => `### Response ${a.letter}\n\n${a.answer}`)
		.join("\n\n---\n\n");

	// -- Stage 2: anonymized peer review -------------------------------------
	onProgress?.(`council: peer review (${answered.length} reviewers)…`);
	const reviewInput = `${qBlock}\n\n---\n\nThe ${answered.length} responses:\n\n${answersBlock}`;
	const reviewResults = await Promise.all(
		answered.map(a => {
			setStage(a.seat.nick, "⏳ reviewing peers…");
			livePush({ type: "review_start", seat: a.seat.nick });
			return callModel(ctx, a.seat, reviewSystemPrompt(a.seat.nick, answered.length), reviewInput, config.maxTokensReview, config.timeoutMs, signal).then(res => {
				setStage(a.seat.nick, res.error ? `✓ answered · ✗ review failed` : `✓ answered · ✓ reviewed ${fmtMs(res.elapsedMs)}`);
				livePush({ type: "review_end", seat: a.seat.nick, ok: !res.error, ms: res.elapsedMs });
				return res;
			});
		}),
	);
	const reviews: { seat: Seat; text: string; elapsedMs: number }[] = [];
	reviewResults.forEach((res, i) => {
		const seat = answered[i]!.seat;
		if (res.error || !res.text) failures.push(`${seat.nick} (review): ${res.error ?? "empty"}`);
		else reviews.push({ seat, text: res.text, elapsedMs: res.elapsedMs });
	});

	const rankingScores = aggregateRankings(reviews.map(r => r.text), answered.length);
	const leaderboard = rankingScores
		? answered
				.map((a, i) => ({ ...a, score: rankingScores[i]! }))
				.sort((x, y) => y.score - x.score)
		: undefined;

	// -- Stage 3: chairman synthesis ------------------------------------------
	onProgress?.(`council: ${chairman.nick} synthesizing…`);
	setStage(`⚖ ${chairman.nick}`, "⏳ synthesizing verdict…");
	livePush({ type: "synth_start" });
	const reviewsBlock =
		reviews.length > 0
			? reviews.map((r, i) => `### Review by member ${i + 1}\n\n${r.text}`).join("\n\n---\n\n")
			: "(no peer reviews completed)";
	const synthesisInput = `${qBlock}\n\n---\n\n## Member responses\n\n${answersBlock}\n\n---\n\n## Peer reviews\n\n${reviewsBlock}`;
	const synthesis = await callModel(
		ctx,
		chairman,
		chairmanSystemPrompt(chairman.nick),
		synthesisInput,
		config.maxTokensSynthesis,
		config.timeoutMs,
		signal,
	);

	setStage(`⚖ ${chairman.nick}`, synthesis.error ? "✗ synthesis failed" : `✓ verdict ${fmtMs(synthesis.elapsedMs)}`);
	livePush({ type: "synth_end", ok: !synthesis.error, ms: synthesis.elapsedMs });

	// -- Deliberation record (feeds the HTML dashboard) ------------------------
	const seatRecords: SeatRecord[] = shuffled.map((seat, i) => {
		const op = opinions[i]!;
		const a = answered.find(x => x.seat === seat);
		const rv = reviews.find(x => x.seat === seat);
		const order = rv ? parseRanking(rv.text, answered.length) : undefined;
		return {
			letter: a?.letter ?? "–",
			nick: seat.nick,
			model: seat.model ? `${seat.model.provider}/${seat.model.id}` : seat.spec,
			answer: a?.answer,
			answerMs: a ? op.elapsedMs : undefined,
			answerTokens: a ? op.outputTokens : undefined,
			review: rv?.text,
			reviewMs: rv?.elapsedMs,
			rankingGiven: order?.map(ai => shuffled.indexOf(answered[ai]!.seat)).filter(x => x >= 0),
			error: op.error,
		};
	});
	const record: DeliberationRecord = {
		question,
		startedAtIso: new Date(startedAt).toISOString().slice(0, 19).replace("T", " "),
		durationMs: Date.now() - startedAt,
		chairman: {
			nick: chairman.nick,
			model: `${chairman.model.provider}/${chairman.model.id}`,
			error: synthesis.error,
			ms: synthesis.elapsedMs,
		},
		seats: seatRecords,
		borda: rankingScores
			? shuffled.map(seat => {
					const ai = answered.findIndex(x => x.seat === seat);
					return ai >= 0 ? (rankingScores[ai] ?? 0) : 0;
				})
			: undefined,
		verdict: synthesis.text || undefined,
		failures,
		settings: {
			effort: config.effort,
			chairmanEffort: config.chairmanEffort,
			timeoutMs: config.timeoutMs,
			contextIncluded: Boolean(sessionContext),
		},
	};

	livePush({
		type: "done",
		durationMs: record.durationMs,
		ranking: leaderboard?.map(e => e.seat.nick) ?? [],
	});

	// Small machine-readable summary of the latest run, for /council list.
	try {
		const stateDir = join(ctx.cwd, ".omp", "council");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "last-run.json"),
			`${JSON.stringify(
				{
					at: record.startedAtIso,
					question: question.slice(0, 120),
					ranking: leaderboard?.map(e => ({ nick: e.seat.nick, score: Number(e.score.toFixed(2)) })) ?? [],
				},
				null,
				2,
			)}\n`,
		);
	} catch {
		// best-effort
	}

	// -- Transcript + dashboard ------------------------------------------------
	let transcriptPath: string | undefined;
	let dashboardPath: string | undefined;
	if (config.writeTranscript) {
		try {
			const dir = join(ctx.cwd, ".omp", "council");
			mkdirSync(dir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			dashboardPath = join(dir, `${stamp}.html`);
			writeFileSync(dashboardPath, renderDashboardHtml(record));
			transcriptPath = join(dir, `${stamp}.md`);
			const identity = answered.map(a => `- Response ${a.letter} = **${a.seat.nick}** (${a.seat.model?.provider}/${a.seat.model?.id})`).join("\n");
			writeFileSync(
				transcriptPath,
				[
					`# Council transcript`,
					``,
					`**Question:** ${question}`,
					``,
					`**Seats:**`,
					identity,
					``,
					`Chairman: **${chairman.nick}** (${chairman.model.provider}/${chairman.model.id})`,
					``,
					`## Stage 1 — opinions`,
					``,
					...answered.map(a => `### ${a.seat.nick} (Response ${a.letter})\n\n${a.answer}\n`),
					`## Stage 2 — peer reviews`,
					``,
					...(reviews.length ? reviews.map(r => `### ${r.seat.nick}\n\n${r.text}\n`) : ["(none)"]),
					`## Stage 3 — chairman synthesis (${chairman.nick})`,
					``,
					synthesis.text || `FAILED: ${synthesis.error}`,
					``,
					failures.length ? `## Failures\n\n${failures.map(f => `- ${f}`).join("\n")}` : ``,
				].join("\n"),
			);
		} catch {
			transcriptPath = undefined; // transcript is best-effort
			dashboardPath = undefined;
		}
	}

	// -- Assemble output -------------------------------------------------------
	const seatLine = answered
		.map(a => `${a.letter}=${a.seat.nick}`)
		.join(", ");
	const rankLine = leaderboard
		? leaderboard.map((e, i) => `${i + 1}. ${e.seat.nick}`).join("  ")
		: "not parseable";

	const footerParts = [
		`Chair: ${chairman.nick} · Seats: ${seatLine}`,
		`Peer ranking: ${rankLine}`,
	];
	if (dashboardPath) footerParts.push(`Dashboard: ${dashboardPath} (or /council last)`);
	if (transcriptPath) footerParts.push(`Full transcript: ${transcriptPath}`);
	if (failures.length) footerParts.push(`Issues: ${failures.join(" | ")}`);

	if (!synthesis.text) {
		// Chairman down: publish the raw material rather than nothing.
		const fallback = [
			`⚠️ Chairman (${chairman.nick}) failed: ${synthesis.error}. Raw council output below.`,
			``,
			answersBlock,
			``,
			`---`,
			footerParts.join("\n"),
		].join("\n");
		return { verdict: fallback, summaryMarkdown: fallback, transcriptPath, dashboardPath, failures };
	}

	const summaryMarkdown = [
		`## 🏛️ Council verdict`,
		``,
		synthesis.text,
		``,
		`---`,
		footerParts.map(p => `*${p}*`).join("\n"),
	].join("\n");

	return { verdict: synthesis.text, summaryMarkdown, transcriptPath, dashboardPath, failures };
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.setLabel("Council");
	const { z } = pi.zod;
	piRef = pi;
	pi.on("session_shutdown", () => {
		liveServer?.stop();
	});

	const listModels = (ctx: ExtensionContext): string => {
		const models = ctx.models.list();
		if (models.length === 0) return "No authenticated models. Use /login first (anthropic, openai-codex, google-antigravity, …).";
		const byProvider = new Map<string, string[]>();
		for (const m of models) {
			const list = byProvider.get(m.provider) ?? [];
			list.push(m.id);
			byProvider.set(m.provider, list);
		}
		return [...byProvider.entries()]
			.map(([provider, ids]) => `${provider}:\n${ids.map(id => `  ${provider}/${id}`).join("\n")}`)
			.join("\n");
	};

	const rosterText = (ctx: ExtensionContext): string => {
		const config = loadConfig(ctx.cwd);
		const { members, chairman } = resolveSeats(ctx, config);
		const line = (s: Seat, role: string) =>
			s.model
				? `✓ ${role} ${s.nick} → ${s.model.provider}/${s.model.id}`
				: `✗ ${role} ${s.nick} → "${s.spec}" UNRESOLVED (login or fix council.json)`;
		const out = [
			...members.map(m => line(m, "member  ")),
			line(chairman, "chairman"),
		];
		if (configLoadError) out.push(`⚠️ config error: ${configLoadError}`);
		return out.join("\n");
	};

	pi.registerCommand("council", {
		description: "Convene the model council: opinions → peer review → chairman synthesis",
		getArgumentCompletions: prefix => {
			const p = prefix.trimStart();
			if (p.toLowerCase().startsWith("remove ")) {
				const needle = p.slice("remove ".length).trim().toLowerCase();
				const config = loadConfig(process.cwd());
				const items = config.members
					.map(m => ({
						value: `remove ${m.nick ?? m.model}`,
						label: m.nick ?? m.model,
						description: m.model,
					}))
					.filter(i => !needle || i.label.toLowerCase().includes(needle));
				return items.length ? items : null;
			}
			const subs = [
				{ value: "models", label: "models", description: "List authenticated model IDs" },
				{ value: "roster", label: "roster", description: "Show resolved council seats" },
				{ value: "list", label: "list", description: "Table of members, position, and last peer rank" },
				{ value: "last", label: "last", description: "Open the latest deliberation dashboard" },
				{ value: "live", label: "live", description: "Open the live agent-communication graph" },
				{ value: "doctor", label: "doctor", description: "Runtime compatibility report" },
				{ value: "update", label: "update", description: "Check npm for a newer aicouncil and install it" },
				{ value: "help", label: "help", description: "List council commands" },
				{ value: "add ", label: "add", description: "add <model> [nick] — seat a new member" },
				{ value: "remove ", label: "remove", description: "remove <nick|model> — unseat a member" },
				{ value: "chair ", label: "chair", description: "chair <model> [nick] — set the chairman" },
			].filter(s => s.value.trimEnd().startsWith(p) || s.value.startsWith(p));
			return subs.length ? subs : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			if (trimmed === "models") {
				ctx.ui.notify("Authenticated models written below", "info");
				pi.sendMessage({ customType: "council-info", content: `Models available for council.json:\n\n\`\`\`\n${listModels(ctx)}\n\`\`\`` });
				return;
			}
			if (trimmed === "update") {
				ctx.ui.setStatus("council", "checking npm for updates…");
				let latest: string | undefined;
				try {
					const res = await fetch("https://registry.npmjs.org/@codeninza/aicouncil/latest", {
						signal: AbortSignal.timeout(10_000),
					});
					latest = ((await res.json()) as { version?: string }).version;
				} catch (error) {
					ctx.ui.notify(`Could not reach npm: ${error instanceof Error ? error.message : String(error)}`, "error");
				} finally {
					ctx.ui.setStatus("council", undefined);
				}
				if (!latest) return;
				if (latest === VERSION) {
					ctx.ui.notify(`aicouncil ${VERSION} is up to date`, "info");
					return;
				}
				// Manual folder installs shouldn't be shadowed by a surprise plugin install.
				const installedAsPlugin = (() => {
					try {
						return /[/\\]plugins[/\\]/.test(fileURLToPath(import.meta.url));
					} catch {
						return false;
					}
				})();
				if (!installedAsPlugin) {
					pi.sendMessage({
						customType: "council-info",
						content: `aicouncil ${latest} is available (you have ${VERSION}). This copy was installed manually, so update it by replacing the folder — or switch to npm installs with \`omp install @codeninza/aicouncil\`.`,
					});
					return;
				}
				ctx.ui.setStatus("council", `updating to ${latest}…`);
				try {
					const result = await pi.exec("omp", ["install", "@codeninza/aicouncil@latest"]);
					if (result.code === 0) {
						pi.sendMessage({
							customType: "council-info",
							content: `✓ aicouncil updated ${VERSION} → ${latest}. Restart omp (or /reload) to load the new version.`,
						});
					} else {
						ctx.ui.notify(`Update failed (exit ${result.code}) — run \`omp install @codeninza/aicouncil\` manually`, "error");
					}
				} catch {
					pi.sendMessage({
						customType: "council-info",
						content: `aicouncil ${latest} is available (you have ${VERSION}). Update with: \`omp install @codeninza/aicouncil\``,
					});
				} finally {
					ctx.ui.setStatus("council", undefined);
				}
				return;
			}

			if (trimmed === "doctor") {
				const reg = ctx.modelRegistry as unknown as Record<string, unknown>;
				const cap = (o: unknown, k: string) => (o && typeof (o as Record<string, unknown>)[k] === "function" ? "✓" : "✗");
				const BunRt = (globalThis as { Bun?: { serve?: unknown; version?: string } }).Bun;
				const modelCount = (() => {
					try {
						return String(ctx.models.list().length);
					} catch {
						return "?";
					}
				})();
				const report = [
					`aicouncil ${VERSION}`,
					`runtime: bun ${BunRt?.version ?? "unknown"} · ${process.platform}`,
					`auth surface on ctx.modelRegistry:`,
					`  getApiKeyAndHeaders ${cap(reg, "getApiKeyAndHeaders")}   getApiKey ${cap(reg, "getApiKey")}   getProviderHeaders ${cap(reg, "getProviderHeaders")}   resolver ${cap(reg, "resolver")}`,
					`models facade: list ${cap(ctx.models, "list")} (${modelCount} authenticated) · resolve ${cap(ctx.models, "resolve")}`,
					`live graph: Bun.serve ${BunRt?.serve ? "✓" : "✗"}`,
					`user config: ${existsSync(userConfigPath()) ? userConfigPath() : "(none)"}`,
					`project config: ${existsSync(join(ctx.cwd, ".omp", "council.json")) ? join(ctx.cwd, ".omp", "council.json") : "(none)"}`,
					``,
					rosterText(ctx),
				].join("\n");
				pi.sendMessage({ customType: "council-info", content: `Council doctor:\n\n\`\`\`\n${report}\n\`\`\`` });
				return;
			}

			if (trimmed === "help") {
				pi.sendMessage({
					customType: "council-info",
					content: [
						"aicouncil commands:",
						"```",
						"/council <question>            convene the council",
						"/council models                list authenticated model IDs",
						"/council roster                show resolved seats + chairman",
						"/council list                  members table: position + last peer rank",
						"/council add <model> [nick]    seat a member",
						"/council remove <nick|model>   unseat a member",
						"/council chair <model> [nick]  set the chairman",
						"/council last                  open the latest dashboard",
						"/council live                  open the live communication graph",
						"/council doctor                runtime compatibility report",
						"/council update                check npm and self-update",
						"```",
					].join("\n"),
				});
				return;
			}

			if (trimmed === "list") {
				const config = loadConfig(ctx.cwd);
				const { members, chairman } = resolveSeats(ctx, config);
				const chairCanonical = chairman.model ? `${chairman.model.provider}/${chairman.model.id}` : chairman.spec;

				// Last-run peer ranking, if a deliberation has happened in this project.
				let lastRun: { at?: string; question?: string; ranking?: { nick: string; score: number }[] } = {};
				try {
					const p = join(ctx.cwd, ".omp", "council", "last-run.json");
					if (existsSync(p)) lastRun = JSON.parse(readFileSync(p, "utf-8"));
				} catch {
					// unreadable state — list without rankings
				}
				const posOf = (nick: string): string => {
					const idx = lastRun.ranking?.findIndex(r => r.nick === nick) ?? -1;
					if (idx < 0) return "–";
					const suffix = ["st", "nd", "rd"][idx] ?? "th";
					return `${idx + 1}${suffix} (${lastRun.ranking![idx]!.score} pts)`;
				};

				const rows = members.map((m, i) => {
					const canonical = m.model ? `${m.model.provider}/${m.model.id}` : m.spec;
					const role = canonical === chairCanonical ? "member · chair ⚖" : "member";
					const status = m.model ? "✓" : "✗ unresolved";
					return [`${i + 1}`, m.nick, canonical, role, status, posOf(m.nick)];
				});
				if (!members.some(m => (m.model ? `${m.model.provider}/${m.model.id}` : m.spec) === chairCanonical)) {
					rows.push(["–", chairman.nick, chairCanonical, "chair ⚖", chairman.model ? "✓" : "✗ unresolved", "–"]);
				}
				const headers = ["#", "Seat", "Model", "Position", "Auth", "Last peer rank"];
				const widths = headers.map((h, c) => Math.max(h.length, ...rows.map(r => r[c]!.length)));
				const fmt = (r: string[]) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ");
				const table = [fmt(headers), fmt(widths.map(w => "─".repeat(w))), ...rows.map(fmt)].join("\n");
				const footer = lastRun.ranking?.length
					? `\nlast deliberation: ${lastRun.at ?? "?"} — "${lastRun.question ?? ""}"`
					: "\nno deliberations in this project yet — peer ranks appear after the first /council run";
				pi.sendMessage({ customType: "council-info", content: `Council seats:\n\n\`\`\`\n${table}${footer}\n\`\`\`` });
				return;
			}

			if (trimmed === "roster" || trimmed === "config" || trimmed === "members") {
				pi.sendMessage({ customType: "council-info", content: `Council roster:\n\n\`\`\`\n${rosterText(ctx)}\n\`\`\`` });
				return;
			}

			if (trimmed === "last") {
				const dir = join(ctx.cwd, ".omp", "council");
				const dashboards = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".html")).sort() : [];
				const latest = dashboards[dashboards.length - 1];
				if (!latest) {
					ctx.ui.notify("No council dashboards yet — run /council <question> first", "warning");
					return;
				}
				const fullPath = join(dir, latest);
				if (await openExternal(pi, fullPath)) ctx.ui.notify(`Opened ${latest}`, "info");
				else pi.sendMessage({ customType: "council-info", content: `Latest council dashboard: ${fullPath}` });
				return;
			}

			if (trimmed === "live") {
				const srv = ensureLiveServer();
				if (!srv) {
					ctx.ui.notify("Live graph unavailable (Bun.serve not found in this runtime)", "error");
					return;
				}
				const url = `http://localhost:${srv.port}/`;
				liveOpened = true;
				if (await openExternal(pi, url)) ctx.ui.notify(`Live council graph: ${url}`, "info");
				else pi.sendMessage({ customType: "council-info", content: `Live council graph: ${url}` });
				return;
			}

			const [sub = "", ...restTokens] = trimmed.split(/\s+/);
			const rest = restTokens.join(" ").trim();
			const canonicalOf = (spec: string): string | undefined => {
				const m = resolveModel(ctx, spec);
				return m ? `${m.provider}/${m.id}` : undefined;
			};
			const showRoster = (headline: string) =>
				pi.sendMessage({ customType: "council-info", content: `${headline}\n\n\`\`\`\n${rosterText(ctx)}\n\`\`\`` });

			// -- /council add <model> [nick…] ------------------------------------
			if (sub === "add" && rest) {
				const spec = restTokens[0]!;
				const nick = restTokens.slice(1).join(" ").trim() || undefined;
				const canonical = canonicalOf(spec);
				if (!canonical) {
					ctx.ui.notify(`No authenticated model matches "${spec}" — run /council models to see what's available`, "error");
					return;
				}
				const config = loadConfig(ctx.cwd);
				if (config.members.some(m => canonicalOf(m.model) === canonical)) {
					ctx.ui.notify(`${canonical} is already seated`, "warning");
					return;
				}
				const members = [...config.members, { model: canonical, ...(nick ? { nick } : {}) }];
				try {
					updateConfigFile(pickWriteTarget(ctx.cwd, "members"), json => {
						json.members = members;
					});
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				showRoster(`Seated ${nick ?? canonical} on the council.`);
				return;
			}

			// -- /council remove <nick-or-model> ---------------------------------
			if (sub === "remove" && rest) {
				const needle = rest.toLowerCase();
				const config = loadConfig(ctx.cwd);
				const matches = config.members.filter(
					m => (m.nick ?? "").toLowerCase() === needle || m.model.toLowerCase().includes(needle),
				);
				if (matches.length === 0) {
					ctx.ui.notify(
						`No member matches "${rest}". Current seats: ${config.members.map(m => m.nick ?? m.model).join(", ")}`,
						"error",
					);
					return;
				}
				if (matches.length > 1) {
					ctx.ui.notify(
						`"${rest}" is ambiguous: ${matches.map(m => m.nick ?? m.model).join(", ")} — be more specific`,
						"warning",
					);
					return;
				}
				const members = config.members.filter(m => m !== matches[0]);
				try {
					updateConfigFile(pickWriteTarget(ctx.cwd, "members"), json => {
						json.members = members;
					});
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				if (members.length < 2) {
					ctx.ui.notify("Fewer than 2 seats remain — the council needs at least 2 members to run", "warning");
				}
				showRoster(`Removed ${matches[0]!.nick ?? matches[0]!.model} from the council.`);
				return;
			}

			// -- /council chair <model> [nick…] ----------------------------------
			if (sub === "chair" && rest) {
				const spec = restTokens[0]!;
				const canonical = canonicalOf(spec);
				if (!canonical) {
					ctx.ui.notify(`No authenticated model matches "${spec}" — run /council models to see what's available`, "error");
					return;
				}
				const config = loadConfig(ctx.cwd);
				const nick =
					restTokens.slice(1).join(" ").trim() ||
					config.members.find(m => canonicalOf(m.model) === canonical)?.nick ||
					canonical.split("/")[1]!;
				try {
					updateConfigFile(pickWriteTarget(ctx.cwd, "chairman"), json => {
						json.chairman = canonical;
						json.chairmanNick = nick;
					});
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				showRoster(`${nick} now chairs the council.`);
				return;
			}

			let question = trimmed;
			if (!question) {
				question = (await ctx.ui.editor("Ask the council", "")) ?? "";
				question = question.trim();
				if (!question) return;
			}

			ctx.ui.setStatus("council", "🏛️ council convening…");
			try {
				const result = await runCouncil(ctx, question, undefined, status => {
					ctx.ui.setStatus("council", `🏛️ ${status}`);
					ctx.ui.setWorkingMessage(status);
				});
				pi.sendMessage({ customType: "council-verdict", content: result.summaryMarkdown, display: true });
				ctx.ui.notify(
					result.failures.length
						? `Council done with ${result.failures.length} issue(s) — see verdict footer`
						: "Council verdict delivered",
					result.failures.length ? "warning" : "info",
				);
			} catch (error) {
				ctx.ui.notify(`Council failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus("council", undefined);
				ctx.ui.setWorkingMessage();
				if (ctx.hasUI) ctx.ui.setWidget("council", undefined);
			}
		},
	});

	// Let the main agent convene the council itself ("ask the council whether …").
	const config = loadConfig(process.cwd());
	if (config.exposeTool) {
		// Cast: zod schemas are accepted at runtime (see examples/extensions/api-demo.ts),
		// but tsc 5.x blows its instantiation-depth budget unifying them with TSchema.
		const registerTool = pi.registerTool.bind(pi) as (tool: unknown) => void;
		registerTool({
			name: "council",
			label: "Model Council",
			description:
				"Convene a council of frontier models (parallel independent answers → anonymized peer review → chairman synthesis) and return the final verdict. Use when the user asks for the council's opinion, a second opinion across models, or when a hard/contested decision would benefit from independent deliberation. Costs several model calls — do not use for trivial questions.",
			parameters: z.object({
				question: z.string().describe("The full, self-contained question for the council, including any needed context"),
			}),
			approval: "read",
			async execute(
				_toolCallId: string,
				params: { question: string },
				signal: AbortSignal | undefined,
				onUpdate: ((update: { content: { type: "text"; text: string }[] }) => void) | undefined,
				ctx: ExtensionContext,
			) {
				try {
					const result = await runCouncil(ctx, params.question, signal, status => {
						onUpdate?.({ content: [{ type: "text", text: status }] });
					});
					const text = result.transcriptPath
						? `${result.summaryMarkdown}\n\n(full deliberation: ${result.transcriptPath})`
						: result.summaryMarkdown;
					return { content: [{ type: "text", text }] };
				} catch (error) {
					return {
						content: [{ type: "text", text: `Council failed: ${error instanceof Error ? error.message : String(error)}` }],
						isError: true,
					};
				} finally {
					if (ctx.hasUI) ctx.ui.setWidget("council", undefined);
				}
			},
		});
	}
}
