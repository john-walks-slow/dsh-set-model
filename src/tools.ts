import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	applyModelSelection,
	resolveCurrentSelection,
	listAvailableModels,
	isPlanModeActive,
	type ActiveModelSelection
} from "./controller.js";
import type { ResolvedSetModelConfig } from "./config.js";
import { findPreset, formatPreset, matchPreset, presetToSelection } from "./presets.js";

function requireAgent(agent: Agent | undefined): Agent {
	if (agent === undefined) {
		throw new Error("No agent is attached to this execution context.");
	}
	return agent;
}

/** Tool output carries provider/model always, reasoningEffort only when set. */
function cleanSelection(selection: ActiveModelSelection): {
	provider: string;
	model: string;
	reasoningEffort?: string;
} {
	return {
		provider: selection.provider,
		model: selection.model,
		...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {})
	};
}

const SWITCH_REASON_DESCRIPTION =
	"Mandatory explanation of why this switch is needed (task phase change, difficulty, cost, etc.). Switching invalidates the session's KV cache, so justify that the switch is worth it and not frequent.";

/**
 * Tool: set_model
 * Allows the agent to autonomously change its model and reasoning depth.
 */
export function setModelTool(ctx: Context, live: () => ResolvedSetModelConfig) {
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
			},
			reason: {
				type: "string",
				required: true,
				description: SWITCH_REASON_DESCRIPTION
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
			kind: "other",
			rawInput: args.reason ? { reason: args.reason } : undefined
		}),
		async execute(args, exec) {
			const config = live();
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
			const message = `Model successfully switched to ${normalized.provider}/${normalized.model}${reasoningText}. Effective from the next step.` +
				(args.reason ? `\nReason: ${args.reason}` : "");

			const cleanPrevious = cleanSelection(previous);
			const cleanCurrent = cleanSelection(normalized);

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
export function listModelsTool(ctx: Context, live: () => ResolvedSetModelConfig) {
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
			const providers = await listAvailableModels(ctx, args.provider, live().allowedProviders);
			return { providers };
		}
	});
}

/**
 * Tool: switch_preset
 * Preset mode only — switches between the model presets the deployment declares.
 */
export function switchPresetTool(ctx: Context, live: () => ResolvedSetModelConfig) {
	return defineTool({
		name: "switch_preset",
		description:
			"Switch the model preset in use for subsequent steps. This deployment runs in preset mode, so only the declared presets can be selected. " +
			"Call list_presets to see each preset's target task stage.",
		parameters: {
			preset: {
				type: "string",
				required: true,
				description: "Preset id to switch to (see list_presets)."
			},
			reason: {
				type: "string",
				required: true,
				description: SWITCH_REASON_DESCRIPTION
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					success: { type: "boolean", required: true },
					preset: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							id: { type: "string", required: true },
							name: { type: "string" }
						}
					},
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
			title: `Switch preset: ${args.preset}`,
			kind: "other",
			rawInput: args.reason ? { reason: args.reason } : undefined
		}),
		async execute(args, exec) {
			const config = live();
			const activeAgent = requireAgent(exec.agent);
			const previous = resolveCurrentSelection(activeAgent, ctx);

			const preset = findPreset(config.presets, args.preset);
			if (preset === undefined) {
				const available = config.presets.map((entry) => entry.id).join(", ") || "(none configured)";
				throw new Error(
					`switch_preset: unknown preset "${args.preset}". Available presets: ${available}. Call list_presets for details.`
				);
			}

			const normalized = await applyModelSelection(
				activeAgent,
				ctx,
				presetToSelection(preset),
				config.allowedProviders
			);

			const reasoningText = normalized.reasoningEffort ? ` · reasoning: ${normalized.reasoningEffort}` : "";
			const nameText = preset.name ? ` (${preset.name})` : "";
			const message =
				`Model preset switched to ${preset.id}${nameText} — ${normalized.provider}/${normalized.model}${reasoningText}. ` +
				`Effective from the next step.` +
				(args.reason ? `\nReason: ${args.reason}` : "");

			return {
				success: true,
				preset: {
					id: preset.id,
					...(preset.name ? { name: preset.name } : {})
				},
				previous: cleanSelection(previous),
				current: cleanSelection(normalized),
				message
			};
		}
	});
}

/**
 * Tool: list_presets
 * Preset mode only — the presets this deployment allows and the one in use.
 */
export function listPresetsTool(ctx: Context, live: () => ResolvedSetModelConfig) {
	return defineTool({
		name: "list_presets",
		description:
			"List the model presets this deployment allows, the task stage each one is for, and the preset currently in use.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					mode: { type: "string", required: true },
					planMode: { type: "boolean", required: true },
					presets: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string", required: true },
								name: { type: "string" },
								when: { type: "string" },
								provider: { type: "string", required: true },
								model: { type: "string", required: true },
								reasoningEffort: { type: "string" },
								current: { type: "boolean", required: true }
							}
						}
					},
					current: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							preset: { type: "string" },
							provider: { type: "string", required: true },
							model: { type: "string", required: true },
							reasoningEffort: { type: "string" }
						}
					}
				}
			},
			render: (_args, val): ContentBlock[] => {
				const lines: string[] = ["# Model presets", ""];
				lines.push(`Mode: ${val.mode}${val.planMode ? " · Plan Mode active" : ""}`);
				const currentEffort = val.current.reasoningEffort ? ` · reasoning ${val.current.reasoningEffort}` : "";
				const currentPreset = val.current.preset ? ` · preset ${val.current.preset}` : " · no preset matches";
				lines.push(`Current: ${val.current.provider}/${val.current.model}${currentEffort}${currentPreset}`);
				lines.push("");
				for (const preset of val.presets) {
					lines.push(`${formatPreset(preset)}${preset.current ? " ← current" : ""}`);
				}
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "List model presets",
			kind: "read"
		}),
		async execute(_args, exec) {
			const config = live();
			const activeAgent = requireAgent(exec.agent);
			const selection = resolveCurrentSelection(activeAgent, ctx);
			const active = matchPreset(config.presets, selection);

			return {
				mode: config.mode,
				planMode: isPlanModeActive(activeAgent, ctx),
				presets: config.presets.map((preset) => ({
					id: preset.id,
					...(preset.name ? { name: preset.name } : {}),
					...(preset.when ? { when: preset.when } : {}),
					provider: preset.provider,
					model: preset.model,
					...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
					current: active?.id === preset.id
				})),
				current: {
					...(active ? { preset: active.id } : {}),
					provider: selection.provider,
					model: selection.model,
					...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {})
				}
			};
		}
	});
}
