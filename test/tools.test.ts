import test from "node:test";
import assert from "node:assert/strict";
import { setModelTool, listModelsTool } from "../src/tools.js";
import { resolveConfig } from "../src/config.js";
import { createMockContext, createMockSession, createMockAgent } from "./helpers.js";

test("Tools: set_model executes valid model change and renders feedback", async () => {
	const mock = createMockContext();
	const session = createMockSession("tool-s2");
	const agent = createMockAgent(session, mock.ctx);
	const config = resolveConfig();

	const setTool = setModelTool(mock.ctx, config);
	assert.equal(setTool.name, "set_model");

	const res: any = await setTool.execute(
		{ provider: "anthropic", model: "claude-3-7-sonnet", reasoningEffort: "high" },
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
});

test("Tools: set_model rejects empty input", async () => {
	const mock = createMockContext();
	const session = createMockSession("tool-s3");
	const agent = createMockAgent(session, mock.ctx);
	const config = resolveConfig();

	const setTool = setModelTool(mock.ctx, config);

	await assert.rejects(
		async () => {
			await setTool.execute({}, { agent } as any);
		},
		/at least one of `provider`, `model`, or `reasoningEffort` must be provided/
	);
});

test("Tools: list_models formats readable overview", async () => {
	const mock = createMockContext();
	const config = resolveConfig();

	const listTool = listModelsTool(mock.ctx, config);
	assert.equal(listTool.name, "list_models");

	const res: any = await listTool.execute({}, {} as any);
	assert.ok(res.providers.length >= 2);

	const rendered = listTool.output.render({}, res);
	const text = (rendered[0] as any)?.text;
	assert.ok(text?.includes("Provider: deepseek"));
	assert.ok(text?.includes("deepseek-reasoner"));
	assert.ok(text?.includes("Reasoning: [low, high, max]"));
});
