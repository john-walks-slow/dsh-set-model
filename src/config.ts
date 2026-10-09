import z from "@deepseek-ai/schemastery";
import type { Volatile } from "@deepseek-ai/cordis";

/** Reasoning depths DSH adapters understand. */
export const REASONING_EFFORTS = ["off", "low", "high", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** How the plugin treats model switching. */
export type ModelPolicyMode = "free" | "preset";

export const ReasoningEffortSchema = z
	.union([
		z.const("off").description("Disable thinking/reasoning"),
		z.const("low").description("Low reasoning effort"),
		z.const("high").description("High reasoning effort"),
		z.const("max").description("Max reasoning effort")
	])
	.description("Optional reasoning depth/thinking effort");

export interface ModelSelectionConfig {
	provider?: string;
	model?: string;
	reasoningEffort?: ReasoningEffort;
}

/**
 * Single model route selection schema for plan mode or default overrides.
 */
export const ModelSelectionConfigSchema = z
	.object({
		provider: z.string().description("Provider ID, e.g. 'deepseek', 'anthropic', 'openai'"),
		model: z.string().description("Model ID, e.g. 'deepseek-reasoner', 'claude-3-7-sonnet'"),
		reasoningEffort: ReasoningEffortSchema
	})
	.volatile()
	.description("Model selection configuration");

export interface ModelPresetConfig {
	id?: string;
	name?: string;
	when?: string;
	provider?: string;
	model?: string;
	reasoningEffort?: ReasoningEffort;
}

/**
 * One selectable model preset: provider, model and reasoning effort under a
 * stable id the agent switches by.
 */
export const ModelPresetConfigSchema = z
	.object({
		id: z.string().description("Stable preset id the agent switches by, e.g. 'daily'"),
		name: z.string().description("Display name used in prompts and the settings page; falls back to id"),
		when: z.string().description("Task stage this preset suits; rendered into the model policy prompt"),
		provider: z.string().description("Provider ID, e.g. 'deepseek'"),
		model: z.string().description("Model ID, e.g. 'deepseek-reasoner'"),
		reasoningEffort: ReasoningEffortSchema
	})
	.description("One selectable model preset");

export interface SetModelPluginConfig {
	mode?: ModelPolicyMode;
	presets?: ModelPresetConfig[];
	policyPrompt?: string;
	planPreset?: string;
	planModel?: ModelSelectionConfig;
	autoRestorePlanModel?: boolean;
	enableAgentTools?: boolean;
	allowedProviders?: string[];
}

/**
 * Settings and plugin composition configuration for dsh-set-model.
 */
export const Config = z.object({
	mode: z
		.union([z.const("free"), z.const("preset")])
		.default("free")
		.volatile()
		.description("'free': the agent may switch to any registered model; 'preset': it may only switch between declared presets"),
	presets: z
		.array(ModelPresetConfigSchema)
		.default([])
		.volatile()
		.description("Selectable model presets. Required and non-empty in preset mode"),
	policyPrompt: z
		.string()
		.default("")
		.volatile()
		.description("Extra model-policy text injected into the system prompt; state which model each task stage should use"),
	planPreset: z
		.string()
		.default("")
		.volatile()
		.description("Preset id activated on entering Plan Mode (preset mode)"),
	planModel: ModelSelectionConfigSchema.description(
		"Model and reasoning effort automatically activated upon entering Plan Mode (free mode)"
	),
	autoRestorePlanModel: z
		.boolean()
		.default(true)
		.volatile()
		.description("Whether to automatically restore the non-plan model when exiting Plan Mode"),
	enableAgentTools: z
		.boolean()
		.default(true)
		.volatile()
		.description("Whether to register the model tools for root agents"),
	allowedProviders: z
		.array(z.string())
		.default([])
		.volatile()
		.description("Optional whitelist of provider IDs permitted for switching. Empty allows all registered providers.")
});

/** One validated preset, ready to be applied to a session. */
export interface ResolvedModelPreset {
	id: string;
	name?: string;
	when?: string;
	provider: string;
	model: string;
	reasoningEffort?: ReasoningEffort;
}

export interface ResolvedPlanModel {
	provider: string;
	model: string;
	reasoningEffort?: ReasoningEffort;
}

export interface ResolvedSetModelConfig {
	mode: ModelPolicyMode;
	presets: ResolvedModelPreset[];
	policyPrompt: string;
	planPreset?: string;
	planModel?: ResolvedPlanModel;
	autoRestorePlanModel: boolean;
	enableAgentTools: boolean;
	allowedProviders: string[];
	/** Unusable configuration: the affected entry is dropped and reported at error level. */
	problems: string[];
	/** Legitimate but worth saying out loud; reported at warn level. */
	warnings: string[];
}

/**
 * The validated config cordis hands to `apply()`.
 *
 * Every field is declared volatile, so the Loader commits a settings write into
 * these references IN PLACE and emits `loader/volatile-update` — `apply()` does
 * not run again. Read them through {@link snapshotConfig} at the moment of use,
 * never once at activation.
 */
export interface SetModelLiveConfig {
	readonly mode: Volatile<ModelPolicyMode>;
	readonly presets: Volatile<ModelPresetConfig[]>;
	readonly policyPrompt: Volatile<string>;
	readonly planPreset: Volatile<string>;
	readonly planModel: Volatile<ModelSelectionConfig | undefined>;
	readonly autoRestorePlanModel: Volatile<boolean>;
	readonly enableAgentTools: Volatile<boolean>;
	readonly allowedProviders: Volatile<string[]>;
}

/** Unwrap the live references into a plain, validated snapshot for one use. */
export function snapshotConfig(live: SetModelLiveConfig): ResolvedSetModelConfig {
	return resolveConfig({
		mode: live.mode.get(),
		presets: live.presets.get(),
		policyPrompt: live.policyPrompt.get(),
		planPreset: live.planPreset.get(),
		planModel: live.planModel.get(),
		autoRestorePlanModel: live.autoRestorePlanModel.get(),
		enableAgentTools: live.enableAgentTools.get(),
		allowedProviders: live.allowedProviders.get()
	});
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeEffort(value: unknown, label: string, problems: string[]): ReasoningEffort | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (isReasoningEffort(value)) return value;
	problems.push(`${label}: unknown reasoningEffort "${String(value)}"; falling back to the model default`);
	return undefined;
}

function normalizePlanModel(raw: unknown, problems: string[]): ResolvedPlanModel | undefined {
	if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
	const candidate = raw as Record<string, unknown>;
	const provider = text(candidate.provider);
	const model = text(candidate.model);
	// The schema resolves an absent planModel to `{}`; that is "not configured".
	if (provider === "" && model === "") return undefined;
	if (provider === "" || model === "") {
		problems.push("planModel: provider and model are both required; ignoring it");
		return undefined;
	}
	const reasoningEffort = normalizeEffort(candidate.reasoningEffort, "planModel", problems);
	return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function normalizePresets(raw: unknown, allowedProviders: string[], problems: string[]): ResolvedModelPreset[] {
	if (!Array.isArray(raw)) return [];

	const presets: ResolvedModelPreset[] = [];
	const seen = new Set<string>();

	raw.forEach((row, index) => {
		const label = `presets[${index}]`;
		if (row === null || typeof row !== "object") {
			problems.push(`${label}: not an object; ignoring it`);
			return;
		}

		const candidate = row as Record<string, unknown>;
		const id = text(candidate.id);
		const provider = text(candidate.provider);
		const model = text(candidate.model);
		if (id === "" || provider === "" || model === "") {
			problems.push(`${label}: id, provider and model are all required; ignoring it`);
			return;
		}
		if (seen.has(id)) {
			problems.push(`${label}: duplicate preset id "${id}"; ignoring it`);
			return;
		}
		if (allowedProviders.length > 0 && !allowedProviders.includes(provider)) {
			problems.push(`${label} ("${id}"): provider "${provider}" is outside allowedProviders; ignoring it`);
			return;
		}

		const name = text(candidate.name);
		const when = text(candidate.when);
		const reasoningEffort = normalizeEffort(candidate.reasoningEffort, `${label} ("${id}")`, problems);

		seen.add(id);
		presets.push({
			id,
			...(name !== "" ? { name } : {}),
			...(when !== "" ? { when } : {}),
			provider,
			model,
			...(reasoningEffort ? { reasoningEffort } : {})
		});
	});

	return presets;
}

export function resolveConfig(raw: Partial<SetModelPluginConfig> | Record<string, unknown> = {}): ResolvedSetModelConfig {
	const source = raw as Record<string, unknown>;
	const problems: string[] = [];
	const warnings: string[] = [];

	const allowedProviders = Array.isArray(source.allowedProviders)
		? source.allowedProviders.map((entry) => text(entry)).filter((entry) => entry !== "")
		: [];
	const mode: ModelPolicyMode = source.mode === "preset" ? "preset" : "free";
	const presets = normalizePresets(source.presets, allowedProviders, problems);
	const planModel = normalizePlanModel(source.planModel, problems);
	const planPreset = text(source.planPreset) || undefined;

	if (mode === "preset" && presets.length === 0) {
		problems.push("mode is 'preset' but no usable presets are declared; the model tools cannot switch anything");
	}
	if (planPreset !== undefined && !presets.some((preset) => preset.id === planPreset)) {
		problems.push(`planPreset "${planPreset}" matches no declared preset; Plan Mode will not switch models`);
	}
	if (mode === "preset" && planPreset === undefined && planModel !== undefined) {
		warnings.push("planModel is unused in preset mode; declare planPreset instead");
	}

	return {
		mode,
		presets,
		policyPrompt: typeof source.policyPrompt === "string" ? source.policyPrompt.trim() : "",
		...(planPreset !== undefined ? { planPreset } : {}),
		...(planModel !== undefined ? { planModel } : {}),
		autoRestorePlanModel: typeof source.autoRestorePlanModel === "boolean" ? source.autoRestorePlanModel : true,
		enableAgentTools: typeof source.enableAgentTools === "boolean" ? source.enableAgentTools : true,
		allowedProviders,
		problems,
		warnings
	};
}
