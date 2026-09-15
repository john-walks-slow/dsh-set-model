import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	applyModelSelection,
	resolveCurrentSelection,
	listAvailableModels
} from "./controller.js";
import type { ResolvedSetModelConfig } from "./config.js";

function requireAgent(agent: Agent | undefined): Agent {
	if (agent === undefined) {
		throw new Error("set_model: no agent is attached to this execution context.");
	}
	return agent;
}

/**
 * Tool: set_model
 * Allows the agent to autonomously change its model and reasoning depth.
 */
export function setModelTool(ctx: Context, config: ResolvedSetModelConfig) {
	return defineTool({
		name: "set_model",
		description:
			"Change your active model, provider, or reasoning depth (thinking effort) for subsequent steps. " +
			"Use deeper reasoning (e.g. reasoningEffort 'high'/'max' or reasoner models) when tackling complex architecture/debugging, " +
			"and faster/cost-effective settings for routine implementation, file edits, and testing.",
		parameters: {
			provider: {
				type: "string",
				description: "Target provider ID (e.g. 'deepseek', 'anthropic', 'openai'). Omit to keep the current provider."
			},
			model: {
				type: "string",
				description: "Target model ID (e.g. 'deepseek-reasoner', 'deepseek-chat', 'claude-3-7-sonnet'). Omit to keep the current model."
			},
			reasoningEffort: {
				type: "string",
				enum: ["off", "low", "high", "max"],
				description: "Target reasoning effort ('off' to disable thinking; 'low', 'high', 'max' to set thinking depth)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					success: { type: "boolean", required: true },
					previous: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							provider: { type: "string", required: true },
							model: { type: "string", required: true },
							reasoningEffort: { type: "string" }
						}
					},
					current: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							provider: { type: "string", required: true },
							model: { type: "string", required: true },
							reasoningEffort: { type: "string" }
						}
					},
					message: { type: "string", required: true }
				}
			},
			render: (_args, val): ContentBlock[] => [
				{
					type: "text",
					text: val.message
				}
			]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Switch model: ${args.provider ?? "*"}/${args.model ?? "*"}${args.reasoningEffort ? ` (${args.reasoningEffort})` : ""}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const activeAgent = requireAgent(exec.agent);
			const previous = resolveCurrentSelection(activeAgent, ctx);

			if (!args.provider && !args.model && args.reasoningEffort === undefined) {
				throw new Error("set_model: at least one of `provider`, `model`, or `reasoningEffort` must be provided.");
			}

			const target = {
				provider: args.provider,
				model: args.model,
				reasoningEffort: args.reasoningEffort
			};

			const normalized = await applyModelSelection(
				activeAgent,
				ctx,
				target,
				config.allowedProviders
			);

			const reasoningText = normalized.reasoningEffort ? ` · reasoning: ${normalized.reasoningEffort}` : "";
			const message = `Model successfully switched to ${normalized.provider}/${normalized.model}${reasoningText}. Effective from the next step.`;

			const cleanPrevious: any = {
				provider: previous.provider,
				model: previous.model
			};
			if (previous.reasoningEffort) cleanPrevious.reasoningEffort = previous.reasoningEffort;

			const cleanCurrent: any = {
				provider: normalized.provider,
				model: normalized.model
			};
			if (normalized.reasoningEffort) cleanCurrent.reasoningEffort = normalized.reasoningEffort;

			return {
				success: true,
				previous: cleanPrevious,
				current: cleanCurrent,
				message
			};
		}
	});
}

/**
 * Tool: list_models
 * Queries available providers and models registered in the system.
 */
export function listModelsTool(ctx: Context, config: ResolvedSetModelConfig) {
	return defineTool({
		name: "list_models",
		description: "List all registered LLM providers and available models in DSH with their capabilities (reasoning support, context window).",
		parameters: {
			provider: {
				type: "string",
				description: "Optional provider ID to filter models (e.g. 'deepseek', 'anthropic')."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					providers: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								provider: { type: "string", required: true },
								models: {
									type: "array",
									required: true,
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											id: { type: "string", required: true },
											name: { type: "string", required: true },
											description: { type: "string" },
											reasoningEfforts: { type: "array", items: { type: "string" } },
											contextWindow: { type: "integer" }
										}
									}
								}
							}
						}
					}
				}
			},
			render: (_args, val): ContentBlock[] => {
				if (!val.providers || val.providers.length === 0) {
					return [{ type: "text", text: "No available models found." }];
				}
				const lines: string[] = ["# Available Providers & Models:"];
				for (const p of val.providers) {
					lines.push(`\n## Provider: ${p.provider}`);
					for (const m of p.models) {
						const efforts = m.reasoningEfforts && m.reasoningEfforts.length > 0
							? ` | Reasoning: [${m.reasoningEfforts.join(", ")}]`
							: "";
						const ctxWin = m.contextWindow ? ` | Context: ${m.contextWindow}` : "";
						lines.push(`- **${m.id}** (${m.name})${efforts}${ctxWin}`);
						if (m.description) {
							lines.push(`  ${m.description}`);
						}
					}
				}
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.provider ? `List models for ${args.provider}` : "List all available models",
			kind: "read"
		}),
		async execute(args) {
			const providers = await listAvailableModels(ctx, args.provider, config.allowedProviders);
			return { providers };
		}
	});
}
