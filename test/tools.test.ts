import test from "node:test";
import assert from "node:assert/strict";
import { setModelTool, listModelsTool, switchPresetTool, listPresetsTool } from "../src/tools.js";
import { resolveConfig } from "../src/config.js";
import { createMockContext, createMockSession, createMockAgent, eventsOf, liveConfig } from "./helpers.js";

const presetConfig = () =>
	resolveConfig({
		mode: "preset",
		presets: [
			{ id: "daily", name: "日常执行", when: "常规实现", provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" },
			{ id: "deep", name: "深度攻坚", when: "疑难排查", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }
		],
		planPreset: "deep"
	});

test("Tools: set_model executes valid model change and renders feedback", async () => {
	const mock = createMockContext();
	const session = createMockSession("tool-s2");
	const agent = createMockAgent(session, mock.ctx);
	const config = resolveConfig();

	const setTool = setModelTool(mock.ctx, () => config);
	assert.equal(setTool.name, "set_model");

	const res: any = await setTool.execute(
		{ provider: "anthropic", model: "claude-3-7-sonnet", reasoningEffort: "high", reason: "phase change to deep analysis" },
		{ agent } as any
	);

	assert.equal(res.success, true);
	assert.equal(res.previous.provider, "deepseek");
	assert.equal(res.current.provider, "anthropic");
	assert.equal(res.current.model, "claude-3-7-sonnet");
	assert.equal(res.current.reasoningEffort, "high");

	const rendered = setTool.output.render({} as any, res);
	const text = (rendered[0] as any)?.text;
	assert.ok(text?.includes("Model successfully switched to anthropic/claude-3-7-sonnet"));
	assert.ok(text?.includes("reasoning: high"));
	assert.ok(text?.includes("Reason: phase change to deep analysis"));
});

test("Tools: set_model rejects empty input", async () => {
	const mock = createMockContext();
	const session = createMockSession("tool-s3");
	const agent = createMockAgent(session, mock.ctx);
	const config = resolveConfig();

	const setTool = setModelTool(mock.ctx, () => config);

	await assert.rejects(
		async () => {
			await setTool.execute({}, { agent } as any);
		},
		/missing required property "reason"|at least one of `provider`, `model`, or `reasoningEffort` must be provided/
	);
});

test("Tools: list_models formats readable overview", async () => {
	const mock = createMockContext();
	const config = resolveConfig();

	const listTool = listModelsTool(mock.ctx, () => config);
	assert.equal(listTool.name, "list_models");

	const res: any = await listTool.execute({}, {} as any);
	assert.ok(res.providers.length >= 2);

	const rendered = listTool.output.render({}, res);
	const text = (rendered[0] as any)?.text;
	assert.ok(text?.includes("Provider: deepseek"));
	assert.ok(text?.includes("deepseek-reasoner"));
	assert.ok(text?.includes("Reasoning: [low, high, max]"));
});

test("Tools: switch_preset applies a declared preset and renders feedback", async () => {
	const mock = createMockContext();
	const session = createMockSession("preset-s1");
	const agent = createMockAgent(session, mock.ctx);
	const tool = switchPresetTool(mock.ctx, presetConfig);

	const res: any = await tool.execute({ preset: "deep", reason: "疑难并发排查" }, { agent } as any);

	assert.equal(res.success, true);
	assert.equal(res.preset.id, "deep");
	assert.equal(res.preset.name, "深度攻坚");
	assert.equal(res.current.provider, "deepseek");
	assert.equal(res.current.model, "deepseek-reasoner");
	assert.equal(res.current.reasoningEffort, "max");

	const rendered = tool.output.render({} as any, res);
	const text = (rendered[0] as any)?.text;
	assert.ok(text?.includes("Model preset switched to deep (深度攻坚) — deepseek/deepseek-reasoner"));
	assert.ok(text?.includes("Reason: 疑难并发排查"));

	const selections = eventsOf(session).filter((event: any) => event.type === "model/selection");
	assert.equal(selections.length, 1);
});

test("Tools: switch_preset rejects an unknown preset and lists the available ones", async () => {
	const mock = createMockContext();
	const agent = createMockAgent(createMockSession("preset-s2"), mock.ctx);
	const tool = switchPresetTool(mock.ctx, presetConfig);

	await assert.rejects(
		async () => {
			await tool.execute({ preset: "nope", reason: "typo" }, { agent } as any);
		},
		/unknown preset "nope"\. Available presets: daily, deep\./
	);
});

test("Tools: list_presets reports the roster and the running preset", async () => {
	const mock = createMockContext();
	const session = createMockSession("preset-s3");
	const agent = createMockAgent(session, mock.ctx);
	(mock.ctx as any).sessionProjections.setState(session, "modelSelection", {
		lastUsed: null,
		pending: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }
	});
	(mock.ctx as any).sessionProjections.setState(session, "plan", { active: true });

	const tool = listPresetsTool(mock.ctx, presetConfig);
	const res: any = await tool.execute({}, { agent } as any);

	assert.equal(res.mode, "preset");
	assert.equal(res.planMode, true);
	assert.equal(res.current.preset, "deep");
	assert.deepEqual(
		res.presets.map((preset: any) => [preset.id, preset.current]),
		[
			["daily", false],
			["deep", true]
		]
	);

	const text = (tool.output.render({}, res)[0] as any)?.text;
	assert.ok(text?.includes("Mode: preset · Plan Mode active"));
	assert.ok(text?.includes("**deep（深度攻坚）** — deepseek/deepseek-reasoner · reasoning max — 适用：疑难排查 ← current"));
});
