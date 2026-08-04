/**
 * Smoke test: load the council extension with a stubbed ExtensionAPI and a
 * mocked provider layer, then run the full 3-stage pipeline.
 */
import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z as realZod } from "zod";

// ---- mock the provider layer BEFORE importing the extension ----------------
let callLog: { system: string; user: string; model: string }[] = [];

mock.module("@oh-my-pi/pi-ai", () => ({
	completeSimple: async (
		model: { provider: string; id: string },
		context: { systemPrompt?: string[]; messages: { content: string }[] },
		_options: unknown,
	) => {
		const system = context.systemPrompt?.join("\n") ?? "";
		const user = String(context.messages[0]?.content ?? "");
		callLog.push({ system, user, model: `${model.provider}/${model.id}` });

		let text: string;
		if (system.includes("chairman of an AI council")) {
			text = `FINAL VERDICT from ${model.id}: the sky is blue due to Rayleigh scattering.\n\nWhere the council split: none.`;
		} else if (system.includes("RANKING:")) {
			text = `Response A is solid. Response B is weaker.\n\nRANKING: A > B > C > D`;
		} else {
			text = `Opinion from ${model.id}: Rayleigh scattering.`;
		}
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
			api: "test",
			provider: model.provider,
			model: model.id,
		};
	},
}));

const factory = (await import("../index.ts")).default;

// ---- fake ExtensionAPI / ctx ----------------------------------------------
const MODELS = [
	{ provider: "anthropic", id: "claude-fable-5" },
	{ provider: "anthropic", id: "claude-opus-5" },
	{ provider: "anthropic", id: "claude-opus-5-thinking" },
	{ provider: "openai-codex", id: "gpt-5-codex" },
	{ provider: "google-antigravity", id: "gemini-3-pro" },
];

function makeHarness() {
	const commands = new Map<string, { handler: Function; getArgumentCompletions?: Function }>();
	const tools = new Map<string, any>();
	const sent: any[] = [];
	const notifications: string[] = [];

	const pi = {
		zod: { z: realZod },
		setLabel: () => {},
		on: () => {},
		registerCommand: (name: string, options: any) => commands.set(name, options),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendMessage: (msg: any) => sent.push(msg),
		logger: { debug: () => {}, warn: () => {}, error: () => {} },
	};

	const cwd = mkdtempSync(join(tmpdir(), "council-test-"));
	// Sandbox the user-level config into the temp dir so roster-mutation tests
	// never touch the real HOME (the extension honors PI_CODING_AGENT_DIR).
	process.env.PI_CODING_AGENT_DIR = join(cwd, ".omp", "agent");
	// Keep the live-graph server out of unit tests.
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(join(cwd, ".omp", "council.json"), JSON.stringify({ liveGraph: false }));
	const ctx = {
		cwd,
		hasUI: false,
		models: {
			list: () => MODELS,
			resolve: (spec: string) => MODELS.find(m => `${m.provider}/${m.id}` === spec),
			current: () => MODELS[0],
			family: () => "x",
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
		},
		sessionManager: {
			getEntries: () => [
				{ type: "message", message: { role: "user", content: "hello there", timestamp: 1 } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi!" }], timestamp: 2 } },
				{ type: "other" },
			],
		},
		ui: {
			notify: (m: string) => notifications.push(m),
			setStatus: () => {},
			setWorkingMessage: () => {},
			editor: async () => "",
		},
	};

	return { pi, ctx, commands, tools, sent, notifications, cwd };
}

// ---------------------------------------------------------------------------
describe("council extension", () => {
	test("factory registers command and tool", () => {
		const h = makeHarness();
		factory(h.pi as any);
		expect(h.commands.has("council")).toBe(true);
		expect(h.tools.has("council")).toBe(true);
		expect(h.tools.get("council").approval).toBe("read");
	});

	test("subcommand completions", () => {
		const h = makeHarness();
		factory(h.pi as any);
		const items = h.commands.get("council")!.getArgumentCompletions!("mo");
		expect(items?.[0]?.value).toBe("models");
	});

	test("/council models lists authenticated models", async () => {
		const h = makeHarness();
		factory(h.pi as any);
		await h.commands.get("council")!.handler("models", h.ctx);
		const msg = h.sent.find(m => m.customType === "council-info");
		expect(msg.content).toContain("anthropic/claude-opus-5");
		expect(msg.content).toContain("google-antigravity/gemini-3-pro");
	});

	test("/council roster resolves all four default seats", async () => {
		const h = makeHarness();
		factory(h.pi as any);
		await h.commands.get("council")!.handler("roster", h.ctx);
		const msg = h.sent.find(m => m.customType === "council-info");
		expect(msg.content).toContain("Fable 5");
		expect((msg.content.match(/✓/g) ?? []).length).toBe(5); // 4 members + chairman
		expect(msg.content).not.toContain("UNRESOLVED");
	});

	test("full council run: 4 opinions + 4 reviews + 1 synthesis, verdict + transcript", async () => {
		callLog = [];
		const h = makeHarness();
		factory(h.pi as any);
		await h.commands.get("council")!.handler("why is the sky blue?", h.ctx);

		// 4 opinions + 4 reviews + 1 chairman = 9 calls
		expect(callLog.length).toBe(9);
		const chairCalls = callLog.filter(c => c.system.includes("chairman"));
		expect(chairCalls.length).toBe(1);
		expect(chairCalls[0]!.model).toBe("anthropic/claude-opus-5");
		// members saw session context
		expect(callLog[0]!.user).toContain("session-context");
		expect(callLog[0]!.user).toContain("why is the sky blue?");

		const verdict = h.sent.find(m => m.customType === "council-verdict");
		expect(verdict.content).toContain("Council verdict");
		expect(verdict.content).toContain("Rayleigh scattering");
		expect(verdict.content).toContain("Peer ranking");
		expect(verdict.display).toBe(true);

		// transcript + dashboard written
		const dir = join(h.cwd, ".omp", "council");
		expect(existsSync(dir)).toBe(true);
		const files = readdirSync(dir).sort();
		expect(files.length).toBe(2);
		const html = files.find(f => f.endsWith(".html"))!;
		const md = files.find(f => f.endsWith(".md"))!;
		const transcript = readFileSync(join(dir, md), "utf-8");
		expect(transcript).toContain("Stage 1 — opinions");
		expect(transcript).toContain("Stage 3 — chairman synthesis");
		const dashboard = readFileSync(join(dir, html), "utf-8");
		expect(dashboard).toContain("Council deliberation");
		expect(dashboard).toContain("Fable 5");
		expect(dashboard).toContain("Peer ranking — Borda average");
		expect(dashboard).toContain("Who ranked whom");
		expect(dashboard).toContain("Rayleigh scattering");
		expect(verdict.content).toContain("Dashboard:");
	});

	test("/council last surfaces the latest dashboard", async () => {
		const h = makeHarness();
		factory(h.pi as any);
		await h.commands.get("council")!.handler("what is 2+2?", h.ctx);
		await h.commands.get("council")!.handler("last", h.ctx);
		// fake pi has no exec → falls back to sending the path
		const info = h.sent.filter(m => m.customType === "council-info").pop();
		expect(info.content).toContain(".html");
	});

	test("council tool execute returns verdict text", async () => {
		const h = makeHarness();
		factory(h.pi as any);
		const result = await h.tools.get("council").execute("id1", { question: "tabs or spaces?" }, undefined, undefined, h.ctx);
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("Council verdict");
	});

	test("fuzzy resolution: 'anthropic/opus' finds claude-opus-5 (not -thinking)", async () => {
		const h = makeHarness();
		// project config with fuzzy specs
		writeFileSync(
			join(h.cwd, ".omp", "council.json"),
			JSON.stringify({ members: [{ model: "anthropic/opus" }, { model: "codex" }], chairman: "anthropic/opus", liveGraph: false }),
		);
		factory(h.pi as any);
		await h.commands.get("council")!.handler("roster", h.ctx);
		const msg = h.sent.find(m => m.customType === "council-info");
		expect(msg.content).toContain("anthropic/claude-opus-5");
		expect(msg.content).not.toContain("claude-opus-5-thinking");
		expect(msg.content).toContain("openai-codex/gpt-5-codex");
		expect(msg.content).not.toContain("UNRESOLVED");
	});

	test("/council add seats a new member and persists to user config", async () => {
		const h = makeHarness();
		factory(h.pi as any);
		await h.commands.get("council")!.handler("add anthropic/claude-opus-5-thinking Thinker", h.ctx);
		const configPath = join(h.cwd, ".omp", "agent", "council.json");
		expect(existsSync(configPath)).toBe(true);
		const saved = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(saved.members.length).toBe(5);
		expect(saved.members[4]).toEqual({ model: "anthropic/claude-opus-5-thinking", nick: "Thinker" });
		const msg = h.sent.find(m => m.customType === "council-info");
		expect(msg.content).toContain("Thinker");
	});

	test("/council add rejects unknown models and duplicates", async () => {
		const h = makeHarness();
		factory(h.pi as any);
		await h.commands.get("council")!.handler("add mistral/le-chat", h.ctx);
		expect(h.notifications.some(n => n.includes("No authenticated model"))).toBe(true);
		await h.commands.get("council")!.handler("add anthropic/claude-opus-5", h.ctx);
		expect(h.notifications.some(n => n.includes("already seated"))).toBe(true);
		expect(existsSync(join(h.cwd, ".omp", "agent", "council.json"))).toBe(false);
	});

	test("/council remove unseats by nick and persists", async () => {
		const h = makeHarness();
		factory(h.pi as any);
		await h.commands.get("council")!.handler("remove Codex", h.ctx);
		const saved = JSON.parse(readFileSync(join(h.cwd, ".omp", "agent", "council.json"), "utf-8"));
		expect(saved.members.length).toBe(3);
		expect(saved.members.some((m: any) => m.nick === "Codex")).toBe(false);
		await h.commands.get("council")!.handler("remove nobody-here", h.ctx);
		expect(h.notifications.some(n => n.includes("No member matches"))).toBe(true);
	});

	test("/council chair changes the chairman and persists", async () => {
		const h = makeHarness();
		factory(h.pi as any);
		await h.commands.get("council")!.handler("chair google-antigravity/gemini-3-pro", h.ctx);
		const saved = JSON.parse(readFileSync(join(h.cwd, ".omp", "agent", "council.json"), "utf-8"));
		expect(saved.chairman).toBe("google-antigravity/gemini-3-pro");
		expect(saved.chairmanNick).toBe("Gemini");
		// next run's chairman call goes to gemini
		callLog = [];
		await h.commands.get("council")!.handler("quick check", h.ctx);
		const chairCalls = callLog.filter(c => c.system.includes("chairman"));
		expect(chairCalls[0]!.model).toBe("google-antigravity/gemini-3-pro");
	});

	test("live graph page is self-contained and demo-capable", async () => {
		const { liveGraphPageHtml } = await import("../index.ts");
		const page = liveGraphPageHtml();
		expect(page).toContain("EventSource");
		expect(page).toContain("aicouncil live");
		expect(page).toContain("@keyframes march");
		const demo = liveGraphPageHtml([[0, { type: "run_start", question: "q", seats: [], chair: { nick: "X", color: "#fff" } }]]);
		expect(demo).toContain("window.__DEMO__=");
		expect(demo).not.toContain("undefined");
	});

	test("auth fallback: registry with only getApiKey + getProviderHeaders", async () => {
		const h = makeHarness();
		(h.ctx as any).modelRegistry = {
			getApiKey: async () => "legacy-key",
			getProviderHeaders: () => ({}),
		};
		factory(h.pi as any);
		await h.commands.get("council")!.handler("test question", h.ctx);
		const verdict = h.sent.find(m => m.customType === "council-verdict");
		expect(verdict.content).toContain("Council verdict");
	});

	test("auth fallback: registry with only resolver", async () => {
		const h = makeHarness();
		(h.ctx as any).modelRegistry = { resolver: () => async () => "resolved-key" };
		factory(h.pi as any);
		await h.commands.get("council")!.handler("test question", h.ctx);
		const verdict = h.sent.find(m => m.customType === "council-verdict");
		expect(verdict.content).toContain("Council verdict");
	});

	test("auth fallback: bare registry reports actionable error", async () => {
		const h = makeHarness();
		(h.ctx as any).modelRegistry = {};
		factory(h.pi as any);
		await h.commands.get("council")!.handler("test question", h.ctx);
		expect(h.notifications.some(n => n.includes("no known auth API"))).toBe(true);
	});

	test("/council doctor reports capabilities", async () => {
		const h = makeHarness();
		factory(h.pi as any);
		await h.commands.get("council")!.handler("doctor", h.ctx);
		const msg = h.sent.find(m => m.customType === "council-info");
		expect(msg.content).toContain("auth surface");
		expect(msg.content).toContain("aicouncil 0.4.1");
	});

	test("degrades gracefully when a member fails auth", async () => {
		callLog = [];
		const h = makeHarness();
		let calls = 0;
		h.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
			calls++;
			// fail auth for the codex seat only
			return calls === 3
				? ({ ok: false, error: "no oauth token" } as any)
				: { ok: true, apiKey: "k", headers: {} };
		};
		factory(h.pi as any);
		await h.commands.get("council")!.handler("test question", h.ctx);
		const verdict = h.sent.find(m => m.customType === "council-verdict");
		expect(verdict).toBeTruthy();
		expect(verdict.content).toContain("Issues:");
	});
});
