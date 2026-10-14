import test from "node:test";
import assert from "node:assert/strict";
import { Config, resolveConfig, snapshotConfig } from "../src/config.js";
import { liveConfig } from "./helpers.js";

test("resolveConfig: defaults to the built-in thinking-depth presets and the free model tools", () => {
	const config = resolveConfig();

	assert.deepEqual(
		config.presets.map((preset) => [preset.id, preset.reasoningEffort]),
		[
			["low", "low"],
			["medium", "medium"],
			["high", "high"]
		]
	);
	// 内置档位不绑定模型：应用时跟随当前会话
	assert.ok(config.presets.every((preset) => preset.provider === undefined && preset.model === undefined));
	assert.ok(config.presets.every((preset) => (preset.when ?? "") !== ""));
	assert.equal(config.policyPrompt, "");
	assert.equal(config.planPreset, undefined);
	assert.equal(config.planModel, undefined);
	assert.equal(config.autoRestorePlanModel, true);
	assert.equal(config.enableModelTools, true);
	assert.equal(config.enablePresetTools, false);
	assert.deepEqual(config.allowedProviders, []);
	assert.deepEqual(config.problems, []);
});

test("resolveConfig: parses presets and trims optional fields", () => {
	const config = resolveConfig({
		presets: [
			{
				id: " daily ",
				name: " 日常执行 ",
				when: " 常规实现、修改、测试 ",
				provider: " deepseek ",
				model: " deepseek-chat ",
				reasoningEffort: "low"
			},
			{ id: "deep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" },
			{ id: "mid", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "medium" },
			{ id: "xdeep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "xhigh" }
		],
		planPreset: "deep"
	});

	assert.deepEqual(config.problems, []);
	assert.equal(config.presets.length, 4);
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
	assert.equal(config.presets[2]?.reasoningEffort, "medium");
	assert.equal(config.presets[3]?.reasoningEffort, "xhigh");
	assert.equal(config.planPreset, "deep");
});

test("resolveConfig: reports every unusable preset and keeps the rest", () => {
	const config = resolveConfig({
		presets: [
			{ id: "daily", provider: "deepseek", model: "deepseek-chat" },
			{ id: "daily", provider: "deepseek", model: "deepseek-reasoner" },
			{ id: "keep", provider: "deepseek", model: "deepseek-chat" },
			{ id: "half-route", provider: "deepseek", model: "" },
			{ id: "global", provider: "", model: "" },
			{ id: "wrong-effort", provider: "deepseek", model: "deepseek-chat", reasoningEffort: "ludicrous" }
		]
	});

	assert.deepEqual(
		config.presets.map((preset) => preset.id),
		["daily", "global", "wrong-effort"]
	);
	// 两个路由字段都留空 = 只钉思考深度，跟随当前模型
	assert.equal(config.presets[1]?.provider, undefined);
	assert.equal(config.presets[1]?.model, undefined);
	assert.equal(config.presets[2]?.reasoningEffort, undefined);
	assert.ok(config.problems.some((problem) => problem.includes('duplicate preset id "daily"')));
	assert.ok(config.problems.some((problem) => problem.includes('preset id "keep" is reserved')));
	assert.ok(config.problems.some((problem) => problem.includes("provider and model must both be set or both be empty")));
	// A typo'd effort falls back to the model default, so the preset stays usable: warn, not error.
	assert.ok(config.warnings.some((warning) => warning.includes('unknown reasoningEffort "ludicrous"')));
});

test("resolveConfig: a missing or empty preset list falls back to the built-in three", () => {
	for (const raw of [undefined, []] as const) {
		const config = resolveConfig(raw === undefined ? {} : { presets: raw });
		assert.deepEqual(
			config.presets.map((preset) => preset.id),
			["low", "medium", "high"]
		);
		assert.deepEqual(config.problems, []);
	}

	// 显式声明则完全取代内置档位
	const declared = resolveConfig({
		presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }]
	});
	assert.equal(declared.presets.length, 1);
	assert.deepEqual(declared.problems, []);
});

test("resolveConfig: a dangling planPreset is a problem, planModel alone is fine", () => {
	const dangling = resolveConfig({
		presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }],
		planPreset: "deep"
	});
	assert.ok(dangling.problems.some((problem) => problem.includes('planPreset "deep" matches no declared preset')));

	const routeOnly = resolveConfig({
		presets: [{ id: "daily", provider: "deepseek", model: "deepseek-chat" }],
		planModel: { provider: "deepseek", model: "deepseek-reasoner" }
	});
	assert.equal(routeOnly.planModel?.model, "deepseek-reasoner");
	assert.deepEqual(routeOnly.problems, []);
	assert.deepEqual(routeOnly.warnings, []);
});

test("resolveConfig: planPreset shadows planModel with a warning", () => {
	const config = resolveConfig({
		presets: [{ id: "deep", provider: "deepseek", model: "deepseek-reasoner" }],
		planPreset: "deep",
		planModel: { provider: "deepseek", model: "deepseek-chat" }
	});

	assert.equal(config.planPreset, "deep");
	assert.deepEqual(config.problems, []);
	assert.ok(config.warnings.some((warning) => warning.includes("planModel is ignored because planPreset is set")));
});

test("resolveConfig: allowedProviders also constrains presets", () => {
	const config = resolveConfig({
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
		presets: [{ id: "deep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }],
		policyPrompt: "线上事故先切 deep。",
		planPreset: "deep",
		enablePresetTools: true,
		allowedProviders: ["deepseek"]
	});

	assert.equal(typeof live.presets.get, "function");
	assert.deepEqual(live.presets.get(), [
		{ id: "deep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }
	]);

	const config = snapshotConfig(live);
	assert.equal(config.enablePresetTools, true);
	assert.equal(config.policyPrompt, "线上事故先切 deep。");
	assert.equal(config.planPreset, "deep");
	assert.deepEqual(config.allowedProviders, ["deepseek"]);
	assert.equal(config.presets[0]?.id, "deep");
	assert.deepEqual(config.problems, []);
});

test("snapshotConfig: schema defaults reach the plugin through the references", () => {
	const config = snapshotConfig(liveConfig());

	assert.equal(config.autoRestorePlanModel, true);
	assert.equal(config.enableModelTools, true);
	assert.equal(config.enablePresetTools, false);
	assert.equal(config.jevEnabled, false);
	assert.equal(config.jevConfidenceThreshold, 0.7);
	assert.deepEqual(
		config.presets.map((preset) => preset.id),
		["low", "medium", "high"]
	);
	assert.deepEqual(config.allowedProviders, []);
	assert.equal(config.planModel, undefined);
});

test("resolveConfig: handles jev config and the two independent tool toggles", () => {
	const config = resolveConfig({
		enableModelTools: false,
		enablePresetTools: true,
		jevEnabled: true,
		jevApiKey: "test-api-key",
		jevConfidenceThreshold: 0.85,
		presets: [{ id: "fast", when: "快速问答", provider: "deepseek", model: "deepseek-chat" }]
	});

	assert.equal(config.enableModelTools, false);
	assert.equal(config.enablePresetTools, true);
	assert.equal(config.jevEnabled, true);
	assert.equal(config.jevApiKey, "test-api-key");
	assert.equal(config.jevConfidenceThreshold, 0.85);
	assert.deepEqual(config.problems, []);
	assert.deepEqual(config.warnings, []);
});

test("resolveConfig: warns on an out-of-range Jev confidence threshold", () => {
	const config = resolveConfig({
		jevEnabled: true,
		jevConfidenceThreshold: 1.5,
		presets: []
	});

	assert.equal(config.jevEnabled, true);
	assert.equal(config.jevConfidenceThreshold, 0.7);
	assert.ok(config.warnings.some((w) => w.includes("must be between 0.0 and 1.0")));
	// 空档位表回落到内置三档，Jev 始终有可判定的档位空间
	assert.equal(config.presets.length, 3);
});

test("resolveConfig: warns when nothing reads the policy prompt", () => {
	const orphan = resolveConfig({
		policyPrompt: "阶段策略。",
		enableModelTools: false,
		enablePresetTools: false,
		jevEnabled: false
	});
	assert.ok(orphan.warnings.some((w) => w.includes("nothing reads it")));

	// 有任一读者时不再提示
	const withTools = resolveConfig({ policyPrompt: "阶段策略。", enableModelTools: true });
	const withJev = resolveConfig({
		policyPrompt: "阶段策略。",
		enableModelTools: false,
		jevEnabled: true
	});
	assert.ok(!withTools.warnings.some((w) => w.includes("nothing reads it")));
	assert.ok(!withJev.warnings.some((w) => w.includes("nothing reads it")));
});

test("resolveConfig: warns when Jev has presets with no stage description", () => {
	const config = resolveConfig({
		jevEnabled: true,
		presets: [
			{ id: "daily", when: "常规实现", provider: "deepseek", model: "deepseek-chat" },
			{ id: "deep", provider: "deepseek", model: "deepseek-reasoner" }
		]
	});

	assert.ok(config.warnings.some((w) => w.includes('presets (deep): no "when" stage description')));
	assert.ok(!config.warnings.some((w) => w.includes("presets (daily)")));
	// Jev 关着时不提：那时 when 只是策略清单里的一行
	assert.deepEqual(resolveConfig({ presets: [{ id: "deep", provider: "deepseek", model: "deepseek-chat" }] }).warnings, []);
});

test("Config schema: all editable fields are declared .volatile() and align with settings", () => {
	const configDict = (Config as any).dict as Record<string, any>;
	const expectedVolatiles = [
		"presets",
		"policyPrompt",
		"planPreset",
		"planModel",
		"autoRestorePlanModel",
		"enableModelTools",
		"enablePresetTools",
		"allowedProviders",
		"jevEnabled",
		"jevApiKey",
		"jevBaseUrl",
		"jevModel",
		"jevConfidenceThreshold"
	];

	for (const key of expectedVolatiles) {
		assert.ok(key in configDict, `expected field "${key}" to be in Config schema`);
		assert.equal(configDict[key]?.meta?.volatile, true, `field "${key}" must be volatile`);
	}

	// 已废弃的模式开关与其别名不再出现在 schema 中
	assert.equal("mode" in configDict, false);
	assert.equal("enableAgentTools" in configDict, false);
	assert.equal("toolEnabled" in configDict, false);
});
