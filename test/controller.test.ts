import test from "node:test";
import assert from "node:assert/strict";
import {
	resolveCurrentSelection,
	applyModelSelection,
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
