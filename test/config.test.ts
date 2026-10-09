import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../src/config.js";
import { snapshotConfig } from "../src/config.js";
import { liveConfig } from "./helpers.js";

test("resolveConfig: defaults to free mode with no policy", () => {
	const config = resolveConfig();

	assert.equal(config.mode, "free");
	assert.deepEqual(config.presets, []);
	assert.equal(config.policyPrompt, "");
	assert.equal(config.planPreset, undefined);
	assert.equal(config.planModel, undefined);
	assert.equal(config.autoRestorePlanModel, true);
	assert.equal(config.enableAgentTools, true);
	assert.deepEqual(config.allowedProviders, []);
	assert.deepEqual(config.problems, []);
});

test("resolveConfig: parses presets and trims optional fields", () => {
	const config = resolveConfig({
		mode: "preset",
		presets: [
			{
				id: " daily ",
				name: " 日常执行 ",
				when: " 常规实现、修改、测试 ",
				provider: " deepseek ",
				model: " deepseek-chat ",
				reasoningEffort: "low"
			},
			{ id: "deep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }
		],
		planPreset: "deep"
	});

	assert.equal(config.mode, "preset");
	assert.deepEqual(config.problems, []);
	assert.equal(config.presets.length, 2);
	assert.deepEqual(config.presets[0], {
		id: "daily",
		name: "日常执行",
		when: "常规实现、修改、测试",
		provider: "deepseek",
		model: "deepseek-chat",
		reasoningEffort: "low"
	});
	assert.deepEqual(config.presets[1], {
		id: "deep",
		provider: "deepseek",
		model: "deepseek-reasoner",
		reasoningEffort: "max"
	});
	assert.equal(config.planPreset, "deep");
});

test("resolveConfig: reports every unusable preset and keeps the rest", () => {
	const config = resolveConfig({
		mode: "preset",
		presets: [
			{ id: "daily", provider: "deepseek", model: "deepseek-chat" },
			{ id: "daily", provider: "deepseek", model: "deepseek-reasoner" },
			{ id: "broken", provider: "", model: "deepseek-chat" },
			{ id: "wrong-effort", provider: "deepseek", model: "deepseek-chat", reasoningEffort: "ludicrous" }
		]
	});

	assert.deepEqual(
		config.presets.map((preset) => preset.id),
		["daily", "wrong-effort"]
	);
	assert.equal(config.presets[1]?.reasoningEffort, undefined);
	assert.ok(config.problems.some((problem) => problem.includes('duplicate preset id "daily"')));
	assert.ok(config.problems.some((problem) => problem.includes("id, provider and model are all required")));
	// A typo'd effort falls back to the model default, so the preset stays usable: warn, not error.
	assert.ok(config.warnings.some((warning) => warning.includes('unknown reasoningEffort "ludicrous"')));
});

test("resolveConfig: preset mode without presets reports, free mode ignores them silently", () => {
	const empty = resolveConfig({ mode: "preset" });
	assert.equal(empty.presets.length, 0);
	assert.ok(empty.problems.some((problem) => problem.includes("no usable presets")));

	// Declaring presets while in free mode is harmless: they simply take no effect.
	const unused = resolveConfig({
		mode: "free",
		presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }]
	});
	assert.equal(unused.presets.length, 1);
	assert.deepEqual(unused.problems, []);
});

test("resolveConfig: plan target validated against the mode", () => {
	const dangling = resolveConfig({
		mode: "preset",
		presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }],
		planPreset: "deep"
	});
	assert.ok(dangling.problems.some((problem) => problem.includes('planPreset "deep" matches no declared preset')));

	const ignoredPlanModel = resolveConfig({
		mode: "preset",
		presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }],
		planModel: { provider: "deepseek", model: "deepseek-reasoner" }
	});
	assert.equal(ignoredPlanModel.planModel?.model, "deepseek-reasoner");
	// Leftover planModel after switching modes is a legitimate state, not a broken config.
	assert.deepEqual(ignoredPlanModel.problems, []);
	assert.ok(ignoredPlanModel.warnings.some((warning) => warning.includes("planModel is unused in preset mode")));
});

test("resolveConfig: a dangling planPreset is only fatal where it would switch", () => {
	// In free mode the settings page hides the field, so a leftover must not
	// shout at the user on every save.
	const free = resolveConfig({ mode: "free", planPreset: "deep" });
	assert.deepEqual(free.problems, []);
	assert.ok(free.warnings.some((warning) => warning.includes('planPreset "deep" matches no declared preset')));
});

test("resolveConfig: allowedProviders also constrains presets", () => {
	const config = resolveConfig({
		mode: "preset",
		allowedProviders: ["deepseek"],
		presets: [
			{ id: "daily", provider: "deepseek", model: "deepseek-chat" },
			{ id: "claude", provider: "anthropic", model: "claude-3-7-sonnet" }
		]
	});

	assert.deepEqual(
		config.presets.map((preset) => preset.id),
		["daily"]
	);
	assert.ok(config.problems.some((problem) => problem.includes('provider "anthropic" is outside allowedProviders')));
});

test("snapshotConfig: reads the live references the Loader hands to apply", () => {
	// The platform validates the raw config; volatile fields come back as refs.
	const live = liveConfig({
		mode: "preset",
		presets: [{ id: "deep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }],
		policyPrompt: "线上事故先切 deep。",
		planPreset: "deep",
		allowedProviders: ["deepseek"]
	});

	assert.equal(typeof live.mode.get, "function");
	assert.equal(live.mode.get(), "preset");
	assert.deepEqual(live.presets.get(), [
		{ id: "deep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }
	]);

	const config = snapshotConfig(live);
	assert.equal(config.mode, "preset");
	assert.equal(config.policyPrompt, "线上事故先切 deep。");
	assert.equal(config.planPreset, "deep");
	assert.deepEqual(config.allowedProviders, ["deepseek"]);
	assert.equal(config.presets[0]?.id, "deep");
	assert.deepEqual(config.problems, []);
});

test("snapshotConfig: schema defaults reach the plugin through the references", () => {
	const config = snapshotConfig(liveConfig());

	assert.equal(config.mode, "free");
	assert.equal(config.autoRestorePlanModel, true);
	assert.equal(config.enableAgentTools, true);
	assert.deepEqual(config.presets, []);
	assert.deepEqual(config.allowedProviders, []);
	assert.equal(config.planModel, undefined);
});
