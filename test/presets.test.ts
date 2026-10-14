import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, type ResolvedModelPreset } from "../src/config.js";
import { findPreset, matchPreset, presetToSelection, renderModelPolicySection } from "../src/presets.js";

const presets: ResolvedModelPreset[] = [
	{ id: "daily", name: "日常执行", when: "常规实现", provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" },
	{ id: "deep", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" },
	{ id: "any-effort", provider: "anthropic", model: "claude-3-7-sonnet" }
];

test("presets: lookup and conversion", () => {
	assert.equal(findPreset(presets, "deep")?.model, "deepseek-reasoner");
	assert.equal(findPreset(presets, "nope"), undefined);

	assert.deepEqual(presetToSelection(presets[0]!), {
		provider: "deepseek",
		model: "deepseek-chat",
		reasoningEffort: "low"
	});
	assert.deepEqual(presetToSelection(presets[1]!), {
		provider: "deepseek",
		model: "deepseek-reasoner",
		reasoningEffort: "max"
	});
});

test("presets: matchPreset prefers the exact effort, then an unpinned route", () => {
	assert.equal(
		matchPreset(presets, { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" })?.id,
		"daily"
	);
	// A provider default effort must not hide the running preset.
	assert.equal(matchPreset(presets, { provider: "anthropic", model: "claude-3-7-sonnet" })?.id, "any-effort");
	assert.equal(
		matchPreset(presets, { provider: "anthropic", model: "claude-3-7-sonnet", reasoningEffort: "high" })?.id,
		"any-effort"
	);
	// An effort mismatch on a pinned preset is not a match.
	assert.equal(matchPreset(presets, { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" }), undefined);
	assert.equal(matchPreset(presets, { provider: "openai", model: "gpt-4o" }), undefined);
});

test("presets: a preset without a route pins only the thinking depth", () => {
	const inherited: ResolvedModelPreset[] = [
		{ id: "low", when: "轻量", reasoningEffort: "low" },
		{ id: "high", when: "攻坚", reasoningEffort: "high" },
		{ id: "pinned", provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" }
	];

	// 只交出思考深度：provider/model 留给 applyModelSelection 从当前会话补齐
	assert.deepEqual(presetToSelection(inherited[0]!), { reasoningEffort: "low" });
	assert.deepEqual(presetToSelection(inherited[1]!), { reasoningEffort: "high" });

	// 钉死路由的档位优先于继承型档位
	assert.equal(
		matchPreset(inherited, { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" })?.id,
		"pinned"
	);
	// 其他模型上按思考深度命中继承型档位
	assert.equal(matchPreset(inherited, { provider: "cpa", model: "omni", reasoningEffort: "high" })?.id, "high");
	assert.equal(matchPreset(inherited, { provider: "cpa", model: "omni", reasoningEffort: "low" })?.id, "low");
	// 深度不在任何一档时不要硬套
	assert.equal(matchPreset(inherited, { provider: "cpa", model: "omni", reasoningEffort: "max" }), undefined);
});

test("presets: the built-in presets render as following the active model", () => {
	const section = renderModelPolicySection(resolveConfig({ enablePresetTools: true }));

	assert.ok(section.includes("- **low** — 沿用当前模型 · reasoning low"));
	assert.ok(section.includes("- **medium** — 沿用当前模型 · reasoning medium"));
	assert.ok(section.includes("- **high** — 沿用当前模型 · reasoning high"));
});

test("presets: the policy section stays empty until something is configured", () => {
	assert.equal(renderModelPolicySection(resolveConfig()), "");
	assert.equal(renderModelPolicySection(resolveConfig({ policyPrompt: "   " })), "");
});

test("presets: renders only the policy prompt while no roster applies", () => {
	const section = renderModelPolicySection(resolveConfig({ policyPrompt: "架构设计用 reasoner。" }));

	assert.ok(section.startsWith("## Model policy"));
	assert.ok(section.includes("架构设计用 reasoner。"));
	assert.ok(!section.includes("switch_preset"));
});

test("presets: enabling the preset tools appends the generated roster", () => {
	const section = renderModelPolicySection(
		resolveConfig({
			enablePresetTools: true,
			policyPrompt: "线上事故先切 deep。",
			presets: [
				{ id: "daily", name: "日常执行", when: "常规实现", provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" },
				{ id: "deep", name: "深度攻坚", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }
			],
			planPreset: "deep"
		})
	);

	assert.ok(section.includes("线上事故先切 deep。"));
	assert.ok(section.includes("switch_preset"));
	assert.ok(section.includes("- **daily（日常执行）** — deepseek/deepseek-chat · reasoning low — 适用：常规实现"));
	assert.ok(section.includes("- **deep（深度攻坚）** — deepseek/deepseek-reasoner · reasoning max"));
});

test("presets: the policy prompt is injected only while a tool can act on it", () => {
	const policy = "阶段策略。";
	const onlyJev = renderModelPolicySection(
		resolveConfig({ policyPrompt: policy, enableModelTools: false, jevEnabled: true })
	);
	// Jev 从决策请求里读策略，不带工具的 Agent 看不到这一段，但档位清单照旧
	assert.ok(!onlyJev.includes(policy));
	assert.ok(onlyJev.includes("本部署声明的模型档位"));

	assert.ok(
		renderModelPolicySection(resolveConfig({ policyPrompt: policy, enablePresetTools: true })).includes(policy)
	);

	// 两个读者都不在：整段消失
	assert.equal(
		renderModelPolicySection(
			resolveConfig({
				policyPrompt: policy,
				enableModelTools: false,
				enablePresetTools: false,
				jevEnabled: false
			})
		),
		""
	);
});
