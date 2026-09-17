import z from "@deepseek-ai/schemastery";

export interface ModelSelectionConfig {
	provider?: string;
	model?: string;
	reasoningEffort?: "off" | "low" | "high" | "max";
}

/**
 * Single model route selection schema for plan mode or default overrides.
 */
export const ModelSelectionConfigSchema = z.object({
	provider: z.string().description("Provider ID, e.g. 'deepseek', 'anthropic', 'openai'"),
	model: z.string().description("Model ID, e.g. 'deepseek-reasoner', 'claude-3-7-sonnet'"),
	reasoningEffort: z.union([
		z.const("off").description("Disable thinking/reasoning"),
		z.const("low").description("Low reasoning effort"),
		z.const("high").description("High reasoning effort"),
		z.const("max").description("Max reasoning effort")
	]).description("Optional reasoning depth/thinking effort")
}).description("Model selection configuration");

export interface SetModelPluginConfig {
	planModel?: ModelSelectionConfig;
	autoRestorePlanModel?: boolean;
	enableAgentTools?: boolean;
	allowedProviders?: string[];
}

/**
 * Settings and plugin composition configuration for dsh-set-model.
 */
export const Config = z.object({
	planModel: ModelSelectionConfigSchema.description("Model and reasoning effort automatically activated upon entering Plan Mode"),
	autoRestorePlanModel: z.boolean().default(true).description("Whether to automatically restore the non-plan model when exiting Plan Mode"),
	enableAgentTools: z.boolean().default(true).description("Whether to register set_model and list_models tools for root agents"),
	allowedProviders: z.array(z.string()).default([]).description("Optional whitelist of provider IDs permitted for set_model. Empty allows all registered providers.")
});

export interface ResolvedSetModelConfig {
	planModel?: {
		provider: string;
		model: string;
		reasoningEffort?: string;
	};
	autoRestorePlanModel: boolean;
	enableAgentTools: boolean;
	allowedProviders: string[];
}

export function resolveConfig(raw: Partial<SetModelPluginConfig> | Record<string, unknown> = {}): ResolvedSetModelConfig {
	const planModel = raw.planModel && typeof raw.planModel === "object" && typeof (raw.planModel as any).provider === "string" && (raw.planModel as any).provider.length > 0 && typeof (raw.planModel as any).model === "string" && (raw.planModel as any).model.length > 0
		? {
			provider: String((raw.planModel as any).provider),
			model: String((raw.planModel as any).model),
			...((raw.planModel as any).reasoningEffort !== undefined && String((raw.planModel as any).reasoningEffort).length > 0 ? { reasoningEffort: String((raw.planModel as any).reasoningEffort) } : {})
		}
		: undefined;

	return {
		planModel,
		autoRestorePlanModel: typeof raw.autoRestorePlanModel === "boolean" ? raw.autoRestorePlanModel : true,
		enableAgentTools: typeof raw.enableAgentTools === "boolean" ? raw.enableAgentTools : true,
		allowedProviders: Array.isArray(raw.allowedProviders) ? raw.allowedProviders.map(String).filter((s) => s.length > 0) : []
	};
}
