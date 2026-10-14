import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/index.js";
import { createVolatile, updateVolatile } from "@deepseek-ai/cosmokit";
import { createMockContext, createMockSession, createMockAgent, eventsOf, liveConfig } from "./helpers.js";

test("apply: free mode registers the model tools", () => {
	const mock = createMockContext();
	const agent = createMockAgent(createMockSession("mode-free"), mock.ctx);
	(mock.ctx.agents as any).rootsList = [agent];

	apply(mock.ctx, liveConfig());

	assert.ok(agent.ctx.tools.get("set_model"));
	assert.ok(agent.ctx.tools.get("list_models"));
	assert.equal(agent.ctx.tools.get("switch_preset"), undefined);
	assert.equal(agent.ctx.tools.get("list_presets"), undefined);
});

test("apply: each tool toggle registers exactly its own tool pair", () => {
	const presetOnly = createMockContext();
	const presetAgent = createMockAgent(createMockSession("tools-preset"), presetOnly.ctx);
	(presetOnly.ctx.agents as any).rootsList = [presetAgent];

	apply(
		presetOnly.ctx,
		liveConfig({
			enableModelTools: false,
			enablePresetTools: true,
			presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }]
		})
	);

	assert.ok(presetAgent.ctx.tools.get("switch_preset"));
	assert.ok(presetAgent.ctx.tools.get("list_presets"));
	assert.equal(presetAgent.ctx.tools.get("set_model"), undefined);
	assert.equal(presetAgent.ctx.tools.get("list_models"), undefined);

	const freeOnly = createMockContext();
	const freeAgent = createMockAgent(createMockSession("tools-free"), freeOnly.ctx);
	(freeOnly.ctx.agents as any).rootsList = [freeAgent];

	apply(freeOnly.ctx, liveConfig({ enableModelTools: true, enablePresetTools: false }));

	assert.ok(freeAgent.ctx.tools.get("set_model"));
	assert.ok(freeAgent.ctx.tools.get("list_models"));
	assert.equal(freeAgent.ctx.tools.get("switch_preset"), undefined);
});

test("apply: both tool toggles off registers nothing", () => {
	const mock = createMockContext();
	const agent = createMockAgent(createMockSession("tools-off"), mock.ctx);
	(mock.ctx.agents as any).rootsList = [agent];

	apply(mock.ctx, liveConfig({ enableModelTools: false, enablePresetTools: false }));

	assert.equal(agent.ctx.tools.get("set_model"), undefined);
	assert.equal(agent.ctx.tools.get("list_models"), undefined);
	assert.equal(agent.ctx.tools.get("switch_preset"), undefined);
	assert.equal(agent.ctx.tools.get("list_presets"), undefined);
});

test("apply: Plan Mode in preset mode switches by planPreset and restores on exit", async () => {
	const mock = createMockContext();
	const session = createMockSession("plan-preset-1");
	const agent = createMockAgent(session, mock.ctx, { provider: "deepseek", model: "deepseek-chat" });
	(mock.ctx.agents as any).rootsList = [agent];

	let preStepHook: any = null;
	(mock.ctx as any).on = (event: string, handler: any) => {
		if (event === "agent/pre-step") preStepHook = handler;
		return () => {};
	};

	apply(
		mock.ctx,
		liveConfig({
			mode: "preset",
			presets: [
				{ id: "daily", name: "日常执行", provider: "deepseek", model: "deepseek-chat" },
				{ id: "deep", name: "深度攻坚", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }
			],
			planPreset: "deep"
		})
	);

	assert.ok(preStepHook, "pre-step hook should be registered");

	const step = (turn: number, step: number) =>
		preStepHook({ agent, messages: [], turn, step, signal: new AbortController().signal }, async () => ({
			kind: "continue"
		}));
	const selections = (): any[] => eventsOf(session).filter((event: any) => event.type === "model/selection");

	// The hook tracks transitions, so it must observe the inactive state first.
	(mock.ctx as any).sessionProjections.setState(session, "plan", { active: false });
	await step(1, 1);
	assert.equal(selections().length, 0);

	(mock.ctx as any).sessionProjections.setState(session, "plan", { active: true });
	await step(1, 2);

	assert.equal(selections().length, 1);
	assert.equal(selections()[0]?.data.model, "deepseek-reasoner");
	assert.equal(selections()[0]?.data.reasoningEffort, "max");

	(mock.ctx as any).sessionProjections.setState(session, "plan", { active: false });
	await step(2, 1);

	assert.equal(selections().length, 2);
	assert.equal(selections()[1]?.data.model, "deepseek-chat");
});

test("apply: the runtime context line reports the running preset, effort included", () => {
	const mock = createMockContext();
	const agent = createMockAgent(createMockSession("context-line"), mock.ctx);
	(mock.ctx.agents as any).rootsList = [agent];
	(mock.ctx as any).agentDefaultModel.currentSelection = () => ({
		provider: "deepseek",
		model: "deepseek-reasoner",
		reasoningEffort: "max"
	});

	apply(
		mock.ctx,
		liveConfig({
			mode: "preset",
			presets: [
				{ id: "daily", provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" },
				{ id: "deep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }
			]
		})
	);

	const line = (mock.ctx as any).systemPrompt.contexts[0].text({ agent });
	assert.equal(line, "[Current active model: deepseek/deepseek-reasoner · reasoning: max · preset: deep]");

	// A route no preset covers still renders, just without the preset segment.
	(mock.ctx as any).agentDefaultModel.currentSelection = () => ({ provider: "cpa", model: "omni" });
	const contribution = (mock.ctx as any).systemPrompt.contexts[0];
	assert.equal(contribution.text({ agent }), "[Current active model: cpa/omni]");

	// No agent (e.g. a host-level turn) contributes nothing at all.
	assert.equal(contribution.text({}), "");

	// Plan Mode is appended to the same line.
	(mock.ctx as any).sessionProjections = {
		stateOf: (_session: unknown, kind: string) => (kind === "plan" ? { active: true } : undefined)
	};
	assert.equal(contribution.text({ agent }), "[Current active model: cpa/omni [Plan Mode Active]]");
});

test("apply: a volatile-only settings write re-registers the tool set without a reload", () => {
	const mock = createMockContext();
	const agent = createMockAgent(createMockSession("tools-live"), mock.ctx);
	(mock.ctx.agents as any).rootsList = [agent];

	const handlers = new Map<string, any>();
	(mock.ctx as any).on = (event: string, handler: any) => {
		handlers.set(event, handler);
		return () => {};
	};

	// The Loader commits volatile writes into the same references; a full
	// re-apply never happens for a settings save.
	const live = liveConfig({ presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }] });
	apply(mock.ctx, live);

	// 默认：自由调模工具开、档位工具关
	assert.ok(agent.ctx.tools.get("set_model"));
	assert.ok(agent.ctx.tools.get("list_models"));
	assert.equal(agent.ctx.tools.get("switch_preset"), undefined);
	assert.ok(handlers.has("loader/volatile-update"));

	// 两个开关彼此独立：可以同时开启，也可以只留一个
	updateVolatile(live.enablePresetTools, createVolatile(true));
	handlers.get("loader/volatile-update")!([]);

	assert.ok(agent.ctx.tools.get("set_model"));
	assert.ok(agent.ctx.tools.get("switch_preset"));
	assert.ok(agent.ctx.tools.get("list_presets"));

	updateVolatile(live.enableModelTools, createVolatile(false));
	handlers.get("loader/volatile-update")!([]);

	assert.equal(agent.ctx.tools.get("set_model"), undefined);
	assert.equal(agent.ctx.tools.get("list_models"), undefined);
	assert.ok(agent.ctx.tools.get("switch_preset"));

	// 全部关闭后不再注册任何调模工具
	updateVolatile(live.enablePresetTools, createVolatile(false));
	handlers.get("loader/volatile-update")!([]);

	assert.equal(agent.ctx.tools.get("switch_preset"), undefined);
	assert.equal(agent.ctx.tools.get("list_presets"), undefined);
});

test("apply: Jev probe route is registered and serves the host-side probe result", async () => {
	const mock = createMockContext();
	const session = createMockSession("jev-probe-route");
	const agent = createMockAgent(session, mock.ctx);
	(mock.ctx.agents as any).rootsList = [agent];
	(mock.ctx as any).agentDefaultModel.currentSelection = () => ({ provider: "deepseek", model: "deepseek-chat" });

	// Capture the route the plugin registers on the host connection service.
	let route: any = null;
	(mock.ctx as any).connection = {
		fetch: {
			register(candidate: unknown) {
				route = candidate;
				return async () => {};
			}
		}
	};

	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => JSON.stringify({ answers: { ping: { type: "choice", choice: "ok" } } })
		})) as any;

		apply(
			mock.ctx,
			liveConfig({
				mode: "preset",
				jevEnabled: true,
				jevApiKey: "config-key",
				presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }]
			})
		);

		assert.ok(route, "the plugin must register the /api/dsh-set-model/jev-probe route");
		assert.equal(route.path, "/api/dsh-set-model/jev-probe");
		assert.deepEqual(route.methods, ["POST"]);
		assert.equal(route.requestBody, "buffered");

		// The client posts this exact path; the handler must accept a real Request.
		const request = new Request("http://127.0.0.1:4180/api/dsh-set-model/jev-probe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ baseUrl: "https://probe.example.com/decisions" })
		});
		const response = await route.fetch(request);
		const body = (await response.json()) as { ok: boolean; message: string };
		assert.equal(body.ok, true);
		assert.match(body.message, /typesafe\/jev-1\.13/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("apply: Jev auto-switch operates at step 1 using payload.messages independently of the tool toggles", async () => {
	const mock = createMockContext();
	const session = createMockSession("jev-indep-1");
	const agent = createMockAgent(session, mock.ctx, { provider: "deepseek", model: "deepseek-chat" });
	(mock.ctx.agents as any).rootsList = [agent];

	let preStepHook: any = null;
	(mock.ctx as any).on = (event: string, handler: any) => {
		if (event === "agent/pre-step") preStepHook = handler;
		return () => {};
	};

	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			({
				ok: true,
				json: async () => ({
					answers: {
						preset: {
							type: "choice",
							choice: "deep",
							confidence: 0.92
						}
					}
				})
			}) as any;

		session.append("turn/start" as any, { turn: 1 } as any);
		// 模拟宿主真实时序：当前回合 prompt 刚从 inbox claim，尚未写入 session
		const currentPrompt = {
			role: "user",
			content: "请排查极深层的内核并发崩溃问题",
			source: { kind: "user" }
		};

		// Tools disabled, Jev enabled
		apply(
			mock.ctx,
			liveConfig({
				enableModelTools: false,
				enablePresetTools: false,
				jevEnabled: true,
				jevApiKey: "test-api-key",
				presets: [
					{ id: "daily", provider: "deepseek", model: "deepseek-chat" },
					{ id: "deep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" }
				]
			})
		);

		// Verify tools are NOT registered
		assert.equal(agent.ctx.tools.get("switch_preset"), undefined);
		assert.equal(agent.ctx.tools.get("set_model"), undefined);

		// Execute pre-step at step 1 (real host turn-start step)
		assert.ok(preStepHook);
		await preStepHook(
			{ agent, messages: [currentPrompt as any], turn: 1, step: 1, signal: new AbortController().signal },
			async () => ({ kind: "continue" })
		);

		// Verify model switch event was appended
		const selections = (eventsOf(session) as any[]).filter((e: any) => e.type === "model/selection");
		assert.equal(selections.length, 1);
		assert.equal(selections[0]?.data.model, "deepseek-reasoner");
		assert.equal(selections[0]?.data.reasoningEffort, "high");

		// Execute pre-step at step 2 (subsequent steps must not re-trigger Jev)
		await preStepHook(
			{ agent, messages: [currentPrompt as any], turn: 1, step: 2, signal: new AbortController().signal },
			async () => ({ kind: "continue" })
		);
		assert.equal((eventsOf(session) as any[]).filter((e: any) => e.type === "model/selection").length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("apply: a Jev-chosen preset without a route changes only the thinking depth", async () => {
	const mock = createMockContext();
	const session = createMockSession("jev-inherit-route");
	const agent = createMockAgent(session, mock.ctx, { provider: "deepseek", model: "deepseek-reasoner" });
	(mock.ctx.agents as any).rootsList = [agent];
	// 当前会话：deepseek-reasoner @ low
	(mock.ctx as any).sessionProjections.setState(session, "modelSelection", {
		pending: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "low" }
	});

	let preStepHook: any = null;
	(mock.ctx as any).on = (event: string, handler: any) => {
		if (event === "agent/pre-step") preStepHook = handler;
		return () => {};
	};

	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			({
				ok: true,
				json: async () => ({
					answers: { preset: { type: "choice", choice: "high", confidence: 0.95 } }
				})
			}) as any;

		session.append("turn/start" as any, { turn: 1 } as any);
		const currentPrompt = {
			role: "user",
			content: "设计一套跨模块的并发架构",
			source: { kind: "user" }
		};

		// 档位不绑定模型：只钉思考深度
		apply(
			mock.ctx,
			liveConfig({
				mode: "preset",
				jevEnabled: true,
				jevApiKey: "test-api-key",
				presets: [
					{ id: "low", reasoningEffort: "low" },
					{ id: "medium", reasoningEffort: "medium" },
					{ id: "high", reasoningEffort: "high" }
				]
			})
		);

		assert.ok(preStepHook);
		await preStepHook(
			{ agent, messages: [currentPrompt as any], turn: 1, step: 1, signal: new AbortController().signal },
			async () => ({ kind: "continue" })
		);

		const selections = (eventsOf(session) as any[]).filter((e: any) => e.type === "model/selection");
		assert.equal(selections.length, 1);
		// 模型保持不变，只有思考深度变
		assert.equal(selections[0]?.data.provider, "deepseek");
		assert.equal(selections[0]?.data.model, "deepseek-reasoner");
		assert.equal(selections[0]?.data.reasoningEffort, "high");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

