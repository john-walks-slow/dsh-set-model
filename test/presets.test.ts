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

test("presets: the policy section stays empty until something is configured", () => {
	assert.equal(renderModelPolicySection(resolveConfig()), "");
	assert.equal(renderModelPolicySection(resolveConfig({ policyPrompt: "   " })), "");
});

test("presets: free mode renders only the policy prompt", () => {
	const section = renderModelPolicySection(resolveConfig({ policyPrompt: "架构设计用 reasoner。" }));

	assert.ok(section.startsWith("## Model policy"));
	assert.ok(section.includes("架构设计用 reasoner。"));
	assert.ok(!section.includes("switch_preset"));
});

test("presets: preset mode appends the generated roster", () => {
	const section = renderModelPolicySection(
		resolveConfig({
			mode: "preset",
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
