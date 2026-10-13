import test from "node:test";
import assert from "node:assert/strict";
import {
	resolveCurrentSelection,
	applyModelSelection,
	adaptReasoningEffort,
	listAvailableModels,
	isPlanModeActive
} from "../src/controller.js";
import { createMockContext, createMockSession, createMockAgent, eventsOf } from "./helpers.js";

test("resolveCurrentSelection: fallbacks and projections", async () => {
	const mock = createMockContext();
	const session = createMockSession("s1");
	const agent = createMockAgent(session, mock.ctx, { provider: "deepseek", model: "deepseek-chat" });

	// Default fallback to agentDefaultModel / options
	const sel1 = resolveCurrentSelection(agent, mock.ctx);
	assert.equal(sel1.provider, "deepseek");
	assert.equal(sel1.model, "deepseek-chat");

	// From modelSelection projection (pending)
	(mock.ctx as any).sessionProjections.setState(session, "modelSelection", {
		lastUsed: { provider: "deepseek", model: "deepseek-chat" },
		pending: { provider: "anthropic", model: "claude-3-7-sonnet", reasoningEffort: "high" }
	});
	const sel2 = resolveCurrentSelection(agent, mock.ctx);
	assert.equal(sel2.provider, "anthropic");
	assert.equal(sel2.model, "claude-3-7-sonnet");
	assert.equal(sel2.reasoningEffort, "high");

	// From plan projection status
	(mock.ctx as any).sessionProjections.setState(session, "plan", { active: true });
	assert.equal(isPlanModeActive(agent, mock.ctx), true);

	(mock.ctx as any).sessionProjections.setState(session, "plan", { active: false });
	assert.equal(isPlanModeActive(agent, mock.ctx), false);
});

test("applyModelSelection: validation and session event commit", async () => {
	const mock = createMockContext();
	const session = createMockSession("s2");
	const agent = createMockAgent(session, mock.ctx);

	// Successful switch
	const switched = await applyModelSelection(
		agent,
		mock.ctx,
		{ provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" },
		[]
	);
	assert.equal(switched.provider, "deepseek");
	assert.equal(switched.model, "deepseek-reasoner");
	assert.equal(switched.reasoningEffort, "max");

	// Verify event was appended to session
	const events = eventsOf(session);
	const lastEvent: any = events.at(-1);
	assert.equal(lastEvent.type, "model/selection");
	assert.equal(lastEvent.data.provider, "deepseek");
	assert.equal(lastEvent.data.model, "deepseek-reasoner");
	assert.equal(lastEvent.data.reasoningEffort, "max");

	// Whitelist rejection
	await assert.rejects(
		async () => {
			await applyModelSelection(
				agent,
				mock.ctx,
				{ provider: "openai", model: "gpt-4o" },
				["deepseek", "anthropic"]
			);
		},
		/Provider "openai" is not permitted by deployment policy/
	);

	// Unknown model rejection
	await assert.rejects(
		async () => {
			await applyModelSelection(
				agent,
				mock.ctx,
				{ provider: "deepseek", model: "non-existent-model" },
				[]
			);
		},
		/Model validation failed/
	);

	// Context window overflow check
	mock.tokenPressure = 70000; // Exceeds deepseek 64k window
	await assert.rejects(
		async () => {
			await applyModelSelection(
				agent,
				mock.ctx,
				{ provider: "deepseek", model: "deepseek-chat" },
				[]
			);
		},
		/Current session token pressure \(70000 tokens\) exceeds target model context window/
	);
});

test("listAvailableModels: returns catalog with capabilities", async () => {
	const mock = createMockContext();
	const catalog = await listAvailableModels(mock.ctx);

	assert.equal(catalog.length, 3);
	const deepseek = catalog.find((p) => p.provider === "deepseek");
	assert.ok(deepseek);
	assert.equal(deepseek?.models.length, 2);

	const reasoner = deepseek?.models.find((m) => m.id === "deepseek-reasoner");
	assert.ok(reasoner);
	assert.deepEqual(reasoner?.reasoningEfforts, ["low", "high", "max"]);
	assert.equal(reasoner?.contextWindow, 64000);
});

test("adaptReasoningEffort: maps across heterogeneous model effort ladders", () => {
	// Non-reasoning model strips effort
	assert.equal(adaptReasoningEffort("high", undefined), undefined);
	assert.equal(adaptReasoningEffort("high", []), undefined);

	// Model supporting [off, low, medium, high] (e.g. cpa/medium, cpa/high)
	const cpaStandard = ["off", "low", "medium", "high"];
	assert.equal(adaptReasoningEffort("medium", cpaStandard), "medium");
	assert.equal(adaptReasoningEffort("xhigh", cpaStandard), "high");
	assert.equal(adaptReasoningEffort("max", cpaStandard), "high");
	assert.equal(adaptReasoningEffort("minimal", cpaStandard), "low");
	assert.equal(adaptReasoningEffort("off", cpaStandard), "off");

	// Model supporting [low, high, max] (e.g. deepseek-reasoner in fixture)
	const r1Efforts = ["low", "high", "max"];
	assert.equal(adaptReasoningEffort("medium", r1Efforts), "high");
	assert.equal(adaptReasoningEffort("xhigh", r1Efforts), "max");
	assert.equal(adaptReasoningEffort("minimal", r1Efforts), "low");
	assert.equal(adaptReasoningEffort("off", r1Efforts), "low");

	// Model supporting [off, high, max] (e.g. cpa/hybrid)
	const hybridEfforts = ["off", "high", "max"];
	assert.equal(adaptReasoningEffort("low", hybridEfforts), "high");
	assert.equal(adaptReasoningEffort("medium", hybridEfforts), "high");
	assert.equal(adaptReasoningEffort("xhigh", hybridEfforts), "max");
});

test("applyModelSelection: adapts unsupported reasoningEffort instead of failing", async () => {
	const mock = createMockContext();
	const session = createMockSession("s-adapt");
	const agent = createMockAgent(session, mock.ctx);

	// 1. Request "medium" on deepseek-reasoner (supports [low, high, max]) -> clamps to "high"
	const s1 = await applyModelSelection(agent, mock.ctx, {
		provider: "deepseek",
		model: "deepseek-reasoner",
		reasoningEffort: "medium"
	});
	assert.equal(s1.reasoningEffort, "high");

	// 2. Request "xhigh" on deepseek-reasoner (supports [low, high, max]) -> clamps to "max"
	const s2 = await applyModelSelection(agent, mock.ctx, {
		provider: "deepseek",
		model: "deepseek-reasoner",
		reasoningEffort: "xhigh"
	});
	assert.equal(s2.reasoningEffort, "max");

	// 3. Switch from deepseek-reasoner (pending reasoningEffort: "max") to non-reasoning deepseek-chat -> strips effort
	(mock.ctx as any).sessionProjections.setState(session, "modelSelection", {
		lastUsed: null,
		pending: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "max" }
	});
	const s3 = await applyModelSelection(agent, mock.ctx, {
		provider: "deepseek",
		model: "deepseek-chat"
	});
	assert.equal(s3.provider, "deepseek");
	assert.equal(s3.model, "deepseek-chat");
	assert.equal(s3.reasoningEffort, undefined);
});
