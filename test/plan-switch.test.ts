import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/index.js";
import { createMockContext, createMockSession, createMockAgent, eventsOf } from "./helpers.js";

test("Plan Mode Auto-Transition: entering Plan Mode auto-switches model, exiting restores", async () => {
	const mock = createMockContext();
	const session = createMockSession("plan-session-1");
	const agent = createMockAgent(session, mock.ctx, { provider: "deepseek", model: "deepseek-chat" });
	(mock.ctx.agents as any).rootsList = [agent];

	let preStepHook: any = null;
	(mock.ctx as any).on = (event: string, handler: any) => {
		if (event === "agent/pre-step") {
			preStepHook = handler;
		}
		return () => {};
	};

	// Apply plugin with planModel configuration
	apply(mock.ctx, {
		planModel: {
			provider: "deepseek",
			model: "deepseek-reasoner",
			reasoningEffort: "high"
		},
		autoRestorePlanModel: true
	});

	assert.ok(preStepHook, "pre-step hook should be registered");

	// Step 1: Normal execution step (plan.active = false)
	(mock.ctx as any).sessionProjections.setState(session, "plan", { active: false });
	await preStepHook(
		{ agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
		async () => ({ kind: "continue" })
	);
	// No model switch event yet
	assert.equal(eventsOf(session).filter((e: any) => e.type === "model/selection").length, 0);

	// Step 2: Transition into Plan Mode (plan.active = true)
	(mock.ctx as any).sessionProjections.setState(session, "plan", { active: true });
	await preStepHook(
		{ agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
		async () => ({ kind: "continue" })
	);

	// Should have emitted model/selection event with plan model
	const planEvents = eventsOf(session).filter((e: any) => e.type === "model/selection");
	assert.equal(planEvents.length, 1);
	const planSwitched: any = planEvents[0]?.data;
	assert.equal(planSwitched.provider, "deepseek");
	assert.equal(planSwitched.model, "deepseek-reasoner");
	assert.equal(planSwitched.reasoningEffort, "high");

	// Step 3: Continued in Plan Mode (plan.active = true)
	await preStepHook(
		{ agent, messages: [], turn: 1, step: 3, signal: new AbortController().signal },
		async () => ({ kind: "continue" })
	);
	// No duplicate event
	assert.equal(eventsOf(session).filter((e: any) => e.type === "model/selection").length, 1);

	// Step 4: Exit Plan Mode (plan.active = false)
	(mock.ctx as any).sessionProjections.setState(session, "plan", { active: false });
	await preStepHook(
		{ agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal },
		async () => ({ kind: "continue" })
	);

	// Should have restored original model (deepseek/deepseek-chat)
	const allSelectionEvents = eventsOf(session).filter((e: any) => e.type === "model/selection");
	assert.equal(allSelectionEvents.length, 2);
	const restored: any = allSelectionEvents[1]?.data;
	assert.equal(restored.provider, "deepseek");
	assert.equal(restored.model, "deepseek-chat");
});
