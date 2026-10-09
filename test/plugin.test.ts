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

test("apply: preset mode registers only the preset tools", () => {
	const mock = createMockContext();
	const agent = createMockAgent(createMockSession("mode-preset"), mock.ctx);
	(mock.ctx.agents as any).rootsList = [agent];

	apply(
		mock.ctx,
		liveConfig({
			mode: "preset",
			presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }]
		})
	);

	assert.ok(agent.ctx.tools.get("switch_preset"));
	assert.ok(agent.ctx.tools.get("list_presets"));
	assert.equal(agent.ctx.tools.get("set_model"), undefined);
	assert.equal(agent.ctx.tools.get("list_models"), undefined);
});

test("apply: enableAgentTools=false registers nothing", () => {
	const mock = createMockContext();
	const agent = createMockAgent(createMockSession("mode-off"), mock.ctx);
	(mock.ctx.agents as any).rootsList = [agent];

	apply(mock.ctx, liveConfig({ enableAgentTools: false }));

	assert.equal(agent.ctx.tools.get("set_model"), undefined);
	assert.equal(agent.ctx.tools.get("list_models"), undefined);
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
	const unmatched = (mock.ctx as any).systemPrompt.contexts[0].text({ agent });
	assert.equal(unmatched, "[Current active model: cpa/omni]");
});

test("apply: a volatile-only settings write re-registers the tool set without a reload", () => {
	const mock = createMockContext();
	const agent = createMockAgent(createMockSession("mode-live"), mock.ctx);
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

	assert.ok(agent.ctx.tools.get("set_model"));
	assert.equal(agent.ctx.tools.get("switch_preset"), undefined);
	assert.ok(handlers.has("loader/volatile-update"));

	updateVolatile(live.mode, createVolatile("preset"));
	handlers.get("loader/volatile-update")!([]);

	assert.equal(agent.ctx.tools.get("set_model"), undefined);
	assert.equal(agent.ctx.tools.get("list_models"), undefined);
	assert.ok(agent.ctx.tools.get("switch_preset"));
	assert.ok(agent.ctx.tools.get("list_presets"));

	// Turning the tools off removes them again.
	updateVolatile(live.enableAgentTools, createVolatile(false));
	handlers.get("loader/volatile-update")!([]);

	assert.equal(agent.ctx.tools.get("switch_preset"), undefined);
	assert.equal(agent.ctx.tools.get("list_presets"), undefined);
});
