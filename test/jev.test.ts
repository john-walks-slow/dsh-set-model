import test from "node:test";
import assert from "node:assert/strict";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import {
	JevInferenceManager,
	extractJevContext,
	probeJevEndpoint,
	queryJevPresetDecision,
	resolveJevCredentials,
	runJevModelInference,
	type JevCredentials
} from "../src/jev.js";
import { resolveConfig, type ResolvedModelPreset } from "../src/config.js";
import { createMockContext, createMockSession, createMockAgent, eventsOf } from "./helpers.js";

/** 还原环境变量：undefined 必须删除而不是赋值，否则会写成字符串 "undefined"。 */
function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

const samplePresets: ResolvedModelPreset[] = [
	{
		id: "coding",
		name: "代码实现",
		when: "常规代码编写、修改文件、单元测试",
		provider: "deepseek",
		model: "deepseek-chat"
	},
	{
		id: "reasoning",
		name: "深度推理",
		when: "复杂架构设计、重大决策、疑难排障",
		provider: "deepseek",
		model: "deepseek-reasoner",
		reasoningEffort: "high"
	}
];

test("resolveJevCredentials: prioritizes explicit config over environment variables", () => {
	const prevJevKey = process.env.JEV_API_KEY;
	const prevJevUrl = process.env.JEV_BASE_URL;
	const prevJevModel = process.env.JEV_MODEL;

	process.env.JEV_API_KEY = "env-jev-key";
	process.env.JEV_BASE_URL = "https://env.endpoint/decisions";
	process.env.JEV_MODEL = "env/jev-model";

	try {
		const creds = resolveJevCredentials({
			jevApiKey: "explicit-key",
			jevBaseUrl: "https://custom.endpoint/decisions",
			jevModel: "custom/jev-model"
		} as any);

		assert.ok(creds);
		assert.equal(creds.apiKey, "explicit-key");
		assert.equal(creds.baseUrl, "https://custom.endpoint/decisions");
		assert.equal(creds.model, "custom/jev-model");
	} finally {
		restoreEnv("JEV_API_KEY", prevJevKey);
		restoreEnv("JEV_BASE_URL", prevJevUrl);
		restoreEnv("JEV_MODEL", prevJevModel);
	}
});

test("resolveJevCredentials: falls back to JEV_API_KEY and defaults", () => {
	const prevJevKey = process.env.JEV_API_KEY;
	const prevJevUrl = process.env.JEV_BASE_URL;
	const prevJevModel = process.env.JEV_MODEL;

	process.env.JEV_API_KEY = "env-jev-key-only";
	delete process.env.JEV_BASE_URL;
	delete process.env.JEV_MODEL;

	try {
		const creds = resolveJevCredentials({} as any);
		assert.ok(creds);
		assert.equal(creds.apiKey, "env-jev-key-only");
		assert.equal(creds.baseUrl, "https://openrouter.ai/api/alpha/decisions");
		assert.equal(creds.model, "typesafe/jev-1.13");
	} finally {
		restoreEnv("JEV_API_KEY", prevJevKey);
		restoreEnv("JEV_BASE_URL", prevJevUrl);
		restoreEnv("JEV_MODEL", prevJevModel);
	}
});

test("resolveJevCredentials: returns null when no credentials configured in config or env", () => {
	const prevJevKey = process.env.JEV_API_KEY;
	delete process.env.JEV_API_KEY;

	try {
		const creds = resolveJevCredentials({} as any);
		assert.equal(creds, null);
	} finally {
		restoreEnv("JEV_API_KEY", prevJevKey);
	}
});

test("probeJevEndpoint: uses the environment credential, not just plugin settings", async () => {
	const prevKey = process.env.JEV_API_KEY;
	const prevUrl = process.env.JEV_BASE_URL;
	delete process.env.JEV_BASE_URL;
	process.env.JEV_API_KEY = "env-key-for-probe";

	const originalFetch = globalThis.fetch;
	let seenAuth = "";
	let seenUrl = "";
	try {
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seenUrl = String(url);
			seenAuth = String((init.headers as Record<string, string>).Authorization);
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () =>
					JSON.stringify({ answers: { ping: { type: "choice", choice: "ok", confidence: 1 } } })
			};
		}) as any;

		// 插件设置里没有 Key，只有环境变量：必须同样能测通，且不加载插件配置。
		const result = await probeJevEndpoint();
		assert.equal(result.ok, true);
		assert.equal(result.status, 200);
		assert.equal(seenAuth, "Bearer env-key-for-probe");
		assert.equal(seenUrl, "https://openrouter.ai/api/alpha/decisions");
		assert.match(result.message, /typesafe\/jev-1\.13/);
	} finally {
		globalThis.fetch = originalFetch;
		restoreEnv("JEV_API_KEY", prevKey);
		restoreEnv("JEV_BASE_URL", prevUrl);
	}
});

test("probeJevEndpoint: form overrides win and missing key reports clearly", async () => {
	const prevKey = process.env.JEV_API_KEY;
	delete process.env.JEV_API_KEY;

	const originalFetch = globalThis.fetch;
	try {
		// 无 Key（配置与环境变量皆空）：明确报错，不发请求。
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return { ok: true, status: 200, text: async () => "{}" };
		}) as any;
		const missing = await probeJevEndpoint();
		assert.equal(missing.ok, false);
		assert.equal(called, false);
		assert.match(missing.message, /JEV_API_KEY/);

		// 表单覆盖 baseUrl / model 与配置 Key 时，按覆盖值请求。
		let seenUrl = "";
		let seenModel = "";
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seenUrl = String(url);
			seenModel = JSON.parse(String(init.body)).model;
			return { ok: true, status: 200, text: async () => "{}" };
		}) as any;
		const overridden = await probeJevEndpoint(
			{ baseUrl: "https://probe.example.com/decisions", model: "custom/model" },
			{ jevApiKey: "config-key" } as any
		);
		assert.equal(seenUrl, "https://probe.example.com/decisions");
		assert.equal(seenModel, "custom/model");
		assert.equal(overridden.ok, true);
		assert.match(overridden.message, /响应结构异常/);
	} finally {
		globalThis.fetch = originalFetch;
		restoreEnv("JEV_API_KEY", prevKey);
	}
});

test("extractJevContext: prioritizes payload.messages over session history in real pre-step timing", () => {
	const session = createMockSession("extract-ctx-timing");
	// Turn 1 committed to session
	session.append("turn/start" as any, { turn: 1 } as any);
	session.append(
		"user/message" as any,
		{ role: "user", content: "旧回合指令：写一个快速原型" } as any,
		{ surfaceOp: "append" } as any
	);
	session.append(
		"assistant/message" as any,
		{
			message: { role: "assistant", content: "这是上一回合的实现产物与解释说明" },
			stream: []
		} as any,
		{ surfaceOp: "append" } as any
	);

	// Turn 2: current prompt is in payload.messages and NOT yet in session!
	const currentPrompt: UserMessage = {
		role: "user",
		content: "新回合指令：进入复杂分布式架构设计与死锁分析",
		source: { kind: "user" }
	} as any;

	const ctx = extractJevContext([currentPrompt], session);
	assert.ok(ctx.includes("新回合指令：进入复杂分布式架构设计与死锁分析"));
	assert.ok(ctx.includes("这是上一回合的实现产物与解释说明"));
	assert.ok(!ctx.includes("旧回合指令：写一个快速原型"));
});

test("extractJevContext: end-align combines previous assistant response and current short prompt", () => {
	const session = createMockSession("extract-ctx-end-align");
	session.append("turn/start" as any, { turn: 1 } as any);
	session.append(
		"assistant/message" as any,
		{
			message: {
				role: "assistant",
				content: "我已准备好进行系统架构全面重构，方案包括改造网络通信层和并发事务锁。请问是否现在开始实施？"
			},
			stream: []
		} as any,
		{ surfaceOp: "append" } as any
	);

	// 用户只说了个极其简短的词：“好的，开始吧”
	const currentPrompt: UserMessage = {
		role: "user",
		content: "好的，开始吧",
		source: { kind: "user" }
	} as any;

	const ctx = extractJevContext([currentPrompt], session);
	assert.ok(ctx.includes("好的，开始吧"));
	assert.ok(ctx.includes("改造网络通信层和并发事务锁"));
	assert.ok(ctx.endsWith("好的，开始吧"));
});

test("extractJevContext: end-align truncates from end when combined text exceeds MAX_JEV_CONTEXT_CHARS", () => {
	const session = createMockSession("extract-ctx-truncate");
	session.append("turn/start" as any, { turn: 1 } as any);
	const longAssistant = "头部旧分析内容：这里是早期的超长讨论" + "A".repeat(2500) + "关键尾部技术方案：引入分布式死锁检测器";
	session.append(
		"assistant/message" as any,
		{
			message: { role: "assistant", content: longAssistant },
			stream: []
		} as any,
		{ surfaceOp: "append" } as any
	);

	const currentPrompt: UserMessage = {
		role: "user",
		content: "go",
		source: { kind: "user" }
	} as any;

	const ctx = extractJevContext([currentPrompt], session);
	assert.equal(ctx.length, 2000);
	assert.ok(ctx.endsWith("Current user instruction:\ngo"));
	assert.ok(ctx.includes("关键尾部技术方案：引入分布式死锁检测器"));
	assert.ok(!ctx.includes("头部旧分析内容"));
});

test("extractJevContext: falls back to session history when messages are empty", () => {
	const session = createMockSession("extract-ctx-fallback");
	session.append("turn/start" as any, { turn: 1 } as any);
	session.append(
		"user/message" as any,
		{ role: "user", content: "历史会话单条指令" } as any,
		{ surfaceOp: "append" } as any
	);

	const ctx = extractJevContext([], session);
	assert.ok(ctx.includes("历史会话单条指令"));
});

test("queryJevPresetDecision: parses choice and validates confidence", async () => {
	const originalFetch = globalThis.fetch;
	const creds: JevCredentials = {
		apiKey: "test-token",
		baseUrl: "https://openrouter.ai/api/alpha/decisions",
		model: "typesafe/jev-1.13"
	};

	try {
		globalThis.fetch = async (input, init) => {
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, "typesafe/jev-1.13");
			assert.ok(body.questions.preset.criteria.reasoning);
			assert.ok(body.questions.preset.criteria.keep);
			// 没有策略时 state 保持纯字符串
			assert.equal(body.state, "需要解决复杂死锁问题");

			return {
				ok: true,
				json: async () => ({
					answers: {
						preset: {
							type: "choice",
							choice: "reasoning",
							confidence: 0.88,
							probabilities: { reasoning: 0.88, coding: 0.1, keep: 0.02 }
						}
					}
				})
			} as any;
		};

		const result = await queryJevPresetDecision(
			{ context: "需要解决复杂死锁问题", presets: samplePresets },
			creds
		);
		assert.ok(result);
		assert.equal(result.choice, "reasoning");
		assert.equal(result.confidence, 0.88);
		assert.equal(result.probabilities.reasoning, 0.88);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("queryJevPresetDecision: rejects invalid confidence and unknown choice", async () => {
	const originalFetch = globalThis.fetch;
	const creds: JevCredentials = {
		apiKey: "test-token",
		baseUrl: "https://openrouter.ai/api/alpha/decisions",
		model: "typesafe/jev-1.13"
	};

	try {
		// 1. confidence is NaN
		globalThis.fetch = async () =>
			({
				ok: true,
				json: async () => ({
					answers: { preset: { type: "choice", choice: "reasoning", confidence: Number.NaN } }
				})
			}) as any;

		assert.equal(await queryJevPresetDecision({ context: "context", presets: samplePresets }, creds), null);

		// 2. choice is unknown key
		globalThis.fetch = async () =>
			({
				ok: true,
				json: async () => ({
					answers: { preset: { type: "choice", choice: "unknown-key", confidence: 0.9 } }
				})
			}) as any;

		assert.equal(await queryJevPresetDecision({ context: "context", presets: samplePresets }, creds), null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("queryJevPresetDecision: sends the deployment policy next to the context", async () => {
	const originalFetch = globalThis.fetch;
	const creds: JevCredentials = {
		apiKey: "test-token",
		baseUrl: "https://openrouter.ai/api/alpha/decisions",
		model: "typesafe/jev-1.13"
	};
	let sent: any;

	try {
		globalThis.fetch = async (_input, init) => {
			sent = JSON.parse(String(init?.body));
			return {
				ok: true,
				json: async () => ({
					answers: { preset: { type: "choice", choice: "keep", confidence: 0.91 } }
				})
			} as any;
		};

		const result = await queryJevPresetDecision(
			{ context: "改一处文案", presets: samplePresets, policyPrompt: "  改文案用 coding。 " },
			creds
		);

		assert.ok(result);
		assert.deepEqual(sent.state, { policy: "改文案用 coding。", context: "改一处文案" });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("JevInferenceManager: manages generation and aborts superseded runs", () => {
	const mgr = new JevInferenceManager();
	assert.equal(mgr.getGeneration("s1"), 0);

	const run1 = mgr.nextGeneration("s1");
	assert.equal(run1.generation, 1);
	assert.equal(run1.controller.signal.aborted, false);

	const run2 = mgr.nextGeneration("s1");
	assert.equal(run2.generation, 2);
	assert.equal(run1.controller.signal.aborted, true);
	assert.equal(run2.controller.signal.aborted, false);

	mgr.abortSession("s1");
	assert.equal(run2.controller.signal.aborted, true);
	assert.equal(mgr.getGeneration("s1"), 3);
});

test("runJevModelInference: switches model using current payload.messages in real pre-step timing", async () => {
	const { ctx } = createMockContext();
	const session = createMockSession("run-jev-switch");
	const agent = createMockAgent(session, ctx, { provider: "deepseek", model: "deepseek-chat" });

	session.append("turn/start" as any, { turn: 1 } as any);
	// 真实宿主时序：当前回合 prompt 刚从 inbox claim，尚未写入 session
	const currentPrompt: UserMessage = {
		role: "user",
		content: "请对整个系统进行深度理论推导与架构设计",
		source: { kind: "user" }
	} as any;

	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			({
				ok: true,
				json: async () => ({
					answers: {
						preset: {
							type: "choice",
							choice: "reasoning",
							confidence: 0.85
						}
					}
				})
			}) as any;

		const config = resolveConfig({
			mode: "preset",
			presets: samplePresets,
			jevEnabled: true,
			jevApiKey: "test-key",
			jevConfidenceThreshold: 0.7
		});

		const switched = await runJevModelInference(ctx, agent, [currentPrompt], config);
		assert.equal(switched, true);

		const events = eventsOf(session) as any[];
		const selectionEvent = events.find((e) => e.type === "model/selection");
		assert.ok(selectionEvent);
		assert.equal(selectionEvent.data.provider, "deepseek");
		assert.equal(selectionEvent.data.model, "deepseek-reasoner");
		assert.equal(selectionEvent.data.reasoningEffort, "high");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("runJevModelInference: does nothing if choice is keep or identical to active model", async () => {
	const { ctx } = createMockContext();
	const session = createMockSession("run-jev-keep");
	const agent = createMockAgent(session, ctx, { provider: "deepseek", model: "deepseek-chat" });

	session.append("turn/start" as any, { turn: 1 } as any);
	const prompt: UserMessage = {
		role: "user",
		content: "继续写这个普通函数",
		source: { kind: "user" }
	} as any;

	const originalFetch = globalThis.fetch;
	try {
		// 1. choice is keep
		globalThis.fetch = async () =>
			({
				ok: true,
				json: async () => ({
					answers: {
						preset: { type: "choice", choice: "keep", confidence: 0.9 }
					}
				})
			}) as any;

		const config = resolveConfig({
			mode: "preset",
			presets: samplePresets,
			jevEnabled: true,
			jevApiKey: "test-key"
		});

		const switchedKeep = await runJevModelInference(ctx, agent, [prompt], config);
		assert.equal(switchedKeep, false);

		// 2. choice matches active model (coding -> deepseek-chat)
		globalThis.fetch = async () =>
			({
				ok: true,
				json: async () => ({
					answers: {
						preset: { type: "choice", choice: "coding", confidence: 0.95 }
					}
				})
			}) as any;

		const switchedIdentical = await runJevModelInference(ctx, agent, [prompt], config);
		assert.equal(switchedIdentical, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("runJevModelInference: bypasses Plan Mode sessions", async () => {
	const { ctx } = createMockContext();
	const session = createMockSession("run-jev-plan");
	const agent = createMockAgent(session, ctx);

	// Mark Plan Mode active
	(ctx as any).sessionProjections.setState(session, "plan", { active: true });

	const config = resolveConfig({
		mode: "preset",
		presets: samplePresets,
		jevEnabled: true,
		jevApiKey: "test-key"
	});

	const res = await runJevModelInference(ctx, agent, [], config);
	assert.equal(res, false);
});

test("runJevModelInference: discards pending switch if jevEnabled was turned off in flight", async () => {
	const { ctx } = createMockContext();
	const session = createMockSession("run-jev-abort-inflight");
	const agent = createMockAgent(session, ctx, { provider: "deepseek", model: "deepseek-chat" });

	session.append("turn/start" as any, { turn: 1 } as any);
	const prompt: UserMessage = {
		role: "user",
		content: "深入分析并重构此架构",
		source: { kind: "user" }
	} as any;

	let currentJevEnabled = true;
	const dynamicConfigProvider = () =>
		resolveConfig({
			mode: "preset",
			presets: samplePresets,
			jevEnabled: currentJevEnabled,
			jevApiKey: "test-key",
			toolEnabled: false
		});

	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => {
			// 在网络等待期间模拟用户通过设置面板关闭了 jevEnabled
			currentJevEnabled = false;
			return {
				ok: true,
				json: async () => ({
					answers: {
						preset: { type: "choice", choice: "reasoning", confidence: 0.95 }
					}
				})
			} as any;
		};

		const switched = await runJevModelInference(ctx, agent, [prompt], dynamicConfigProvider);
		assert.equal(switched, false);

		// 确保没有产生切换事件
		const events = eventsOf(session) as any[];
		const selectionEvent = events.find((e) => e.type === "model/selection");
		assert.equal(selectionEvent, undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("runJevModelInference works independently when toolEnabled is false", async () => {
	const { ctx } = createMockContext();
	const session = createMockSession("run-jev-tool-disabled");
	const agent = createMockAgent(session, ctx, { provider: "deepseek", model: "deepseek-chat" });

	session.append("turn/start" as any, { turn: 1 } as any);
	const prompt: UserMessage = {
		role: "user",
		content: "请对整个系统进行深度理论推导",
		source: { kind: "user" }
	} as any;

	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			({
				ok: true,
				json: async () => ({
					answers: {
						preset: {
							type: "choice",
							choice: "reasoning",
							confidence: 0.9
						}
					}
				})
			}) as any;

		// 显式关闭工具，但开启 Jev
		const config = resolveConfig({
			mode: "preset",
			presets: samplePresets,
			enableModelTools: false,
			enablePresetTools: false,
			jevEnabled: true,
			jevApiKey: "test-key"
		});

		assert.equal(config.enableModelTools, false);
		assert.equal(config.enablePresetTools, false);
		assert.equal(config.jevEnabled, true);

		const switched = await runJevModelInference(ctx, agent, [prompt], config);
		assert.equal(switched, true);

		const events = eventsOf(session) as any[];
		const selectionEvent = events.find((e) => e.type === "model/selection");
		assert.ok(selectionEvent);
		assert.equal(selectionEvent.data.model, "deepseek-reasoner");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
