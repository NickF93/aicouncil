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
 *   /council <question>     convene the council
 *   /council models         list model IDs you are authenticated for (use these in config)
 *   /council roster         show the resolved seats + chairman
 *
 * The main agent also gets a `council` tool (read-only approval), so you can just
 * say "ask the council whether ..." mid-session.
 *
 * Config (later overrides earlier): `council.json` next to this file →
 * `~/.omp/agent/council.json` → `<cwd>/.omp/council.json`.
 * See DEFAULT_CONFIG below for the schema and defaults.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
		join(homedir(), ".omp", "agent", "council.json"),
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

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
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
				apiKey: auth.apiKey,
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
// The council run
// ---------------------------------------------------------------------------

interface CouncilRunResult {
	verdict: string;
	summaryMarkdown: string;
	transcriptPath?: string;
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

	// -- Stage 1: opinions ----------------------------------------------------
	onProgress?.(`council: ${shuffled.length} members deliberating…`);
	const opinions = await Promise.all(
		shuffled.map(seat =>
			callModel(ctx, seat, opinionSystemPrompt(seat.nick, shuffled.length), qBlock, config.maxTokensOpinion, config.timeoutMs, signal),
		),
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
		answered.map(a =>
			callModel(ctx, a.seat, reviewSystemPrompt(a.seat.nick, answered.length), reviewInput, config.maxTokensReview, config.timeoutMs, signal),
		),
	);
	const reviews: { seat: Seat; text: string }[] = [];
	reviewResults.forEach((res, i) => {
		const seat = answered[i]!.seat;
		if (res.error || !res.text) failures.push(`${seat.nick} (review): ${res.error ?? "empty"}`);
		else reviews.push({ seat, text: res.text });
	});

	const rankingScores = aggregateRankings(reviews.map(r => r.text), answered.length);
	const leaderboard = rankingScores
		? answered
				.map((a, i) => ({ ...a, score: rankingScores[i]! }))
				.sort((x, y) => y.score - x.score)
		: undefined;

	// -- Stage 3: chairman synthesis ------------------------------------------
	onProgress?.(`council: ${chairman.nick} synthesizing…`);
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

	// -- Transcript ------------------------------------------------------------
	let transcriptPath: string | undefined;
	if (config.writeTranscript) {
		try {
			const dir = join(ctx.cwd, ".omp", "council");
			mkdirSync(dir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
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
		return { verdict: fallback, summaryMarkdown: fallback, transcriptPath, failures };
	}

	const summaryMarkdown = [
		`## 🏛️ Council verdict`,
		``,
		synthesis.text,
		``,
		`---`,
		footerParts.map(p => `*${p}*`).join("\n"),
	].join("\n");

	return { verdict: synthesis.text, summaryMarkdown, transcriptPath, failures };
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.setLabel("Council");
	const { z } = pi.zod;

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
			const subs = [
				{ value: "models", label: "models", description: "List authenticated model IDs for council.json" },
				{ value: "roster", label: "roster", description: "Show resolved council seats" },
			].filter(s => s.value.startsWith(prefix.trim()));
			return subs.length ? subs : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			if (trimmed === "models") {
				ctx.ui.notify("Authenticated models written below", "info");
				pi.sendMessage({ customType: "council-info", content: `Models available for council.json:\n\n\`\`\`\n${listModels(ctx)}\n\`\`\`` });
				return;
			}
			if (trimmed === "roster" || trimmed === "config") {
				pi.sendMessage({ customType: "council-info", content: `Council roster:\n\n\`\`\`\n${rosterText(ctx)}\n\`\`\`` });
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
				}
			},
		});
	}
}
