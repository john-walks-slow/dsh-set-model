import z from "@deepseek-ai/schemastery";
import type { Volatile } from "@deepseek-ai/cordis";

/** Reasoning depths DSH adapters understand, in escalation order. */
export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_JEV_BASE_URL = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
export const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.7;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export const ReasoningEffortSchema = z
	.union([
		z.const("off").description("Disable thinking/reasoning"),
		z.const("minimal").description("Minimal reasoning effort"),
		z.const("low").description("Low reasoning effort"),
		z.const("medium").description("Medium reasoning effort"),
		z.const("high").description("High reasoning effort"),
		z.const("xhigh").description("Extra-high reasoning effort"),
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
 * stable id the agent switches by. Leaving provider and model empty pins only
 * the reasoning effort, so the preset follows whichever model is active.
 */
export const ModelPresetConfigSchema = z
	.object({
		id: z.string().description("Stable preset id the agent switches by, e.g. 'daily'"),
		name: z.string().description("Display name used in prompts and the settings page; falls back to id"),
		when: z
			.string()
			.description("Stage this preset suits; rendered into the model policy prompt and used as the Jev decision criterion"),
		provider: z.string().default("").description("Provider ID, e.g. 'deepseek'. Empty keeps the active provider"),
		model: z.string().default("").description("Model ID, e.g. 'deepseek-reasoner'. Empty keeps the active model"),
		reasoningEffort: ReasoningEffortSchema
	})
	.description("One selectable model preset");

/**
 * Presets used when the deployment declares none: one preset per thinking
 * depth, none of them pinning a model, so the plugin still has a usable
 * decision space with no configuration at all.
 */
export const DEFAULT_PRESETS: ModelPresetConfig[] = [
	{
		id: "low",
		when: "单轮即可答的问答、文案与格式整理、只读查看、改一处文案或常量，无需读多个文件才能定位",
		reasoningEffort: "low"
	},
	{
		id: "medium",
		when: "常规实现与修改：改动集中在 1 个模块内、需求明确无需方案权衡、需要跑测试验证",
		reasoningEffort: "medium"
	},
	{
		id: "high",
		when: "需要多步推理或方案权衡：跨 2 个以上模块的改动、需先读多个文件才能定位的排障、架构与接口设计、并发或性能类疑难",
		reasoningEffort: "high"
	}
];

export interface SetModelPluginConfig {
	presets?: ModelPresetConfig[];
	policyPrompt?: string;
	planPreset?: string;
	planModel?: ModelSelectionConfig;
	autoRestorePlanModel?: boolean;
	enableModelTools?: boolean;
	enablePresetTools?: boolean;
	allowedProviders?: string[];
	jevEnabled?: boolean;
	jevApiKey?: string;
	jevBaseUrl?: string;
	jevModel?: string;
	jevConfidenceThreshold?: number;
}

/**
 * Settings and plugin composition configuration for dsh-set-model.
 */
export const Config = z.object({
	presets: z
		.array(ModelPresetConfigSchema)
		.default(DEFAULT_PRESETS)
		.volatile()
		.description("Selectable model presets. Empty falls back to one preset per thinking depth, none pinning a model"),
	policyPrompt: z
		.string()
		.default("")
		.volatile()
		.description(
			"Deployment policy: which model or preset each task stage should use. Read by the agent while it holds a model-switching tool, and sent to Jev as the decision policy"
		),
	planPreset: z
		.string()
		.default("")
		.volatile()
		.description("Preset id activated on entering Plan Mode; takes precedence over planModel"),
	planModel: ModelSelectionConfigSchema.description(
		"Model and reasoning effort activated upon entering Plan Mode when no planPreset is set"
	),
	autoRestorePlanModel: z
		.boolean()
		.default(true)
		.volatile()
		.description("Whether to automatically restore the non-plan model when exiting Plan Mode"),
	enableModelTools: z
		.boolean()
		.default(true)
		.volatile()
		.description("Whether to register the free model-switching tools (set_model / list_models) for root agents"),
	enablePresetTools: z
		.boolean()
		.default(false)
		.volatile()
		.description("Whether to register the preset tools (switch_preset / list_presets) for root agents"),
	allowedProviders: z
		.array(z.string())
		.default([])
		.volatile()
		.description("Optional whitelist of provider IDs permitted for switching. Empty allows all registered providers."),
	jevEnabled: z
		.boolean()
		.default(false)
		.volatile()
		.description("Whether to automatically switch model presets using the TypeSafe Jev decision model"),
	jevApiKey: z
		.string()
		.role("secret")
		.default("")
		.volatile()
		.description("Jev Decisions API key; falls back to JEV_API_KEY environment variable"),
	jevBaseUrl: z
		.string()
		.default("")
		.volatile()
		.description("Jev Decisions API endpoint URL (default: https://openrouter.ai/api/alpha/decisions, or via JEV_BASE_URL environment variable)"),
	jevModel: z
		.string()
		.default("")
		.volatile()
		.description("Jev decision model identifier (default: typesafe/jev-1.13, or via JEV_MODEL environment variable)"),
	jevConfidenceThreshold: z
		.number()
		.default(DEFAULT_JEV_CONFIDENCE_THRESHOLD)
		.volatile()
		.description("Confidence threshold for Jev auto-switching between 0.0 and 1.0 (default: 0.7)")
});

/** One validated preset, ready to be applied to a session. */
export interface ResolvedModelPreset {
	id: string;
	name?: string;
	when?: string;
	/** Pinned provider; absent means the preset follows the active provider. */
	provider?: string;
	/** Pinned model; absent means the preset follows the active model. */
	model?: string;
	reasoningEffort?: ReasoningEffort;
}

export interface ResolvedPlanModel {
	provider: string;
	model: string;
	reasoningEffort?: ReasoningEffort;
}

export interface ResolvedSetModelConfig {
	presets: ResolvedModelPreset[];
	policyPrompt: string;
	planPreset?: string;
	planModel?: ResolvedPlanModel;
	autoRestorePlanModel: boolean;
	/** Free model-switching tools (`set_model` / `list_models`). */
	enableModelTools: boolean;
	/** Preset tools (`switch_preset` / `list_presets`). */
	enablePresetTools: boolean;
	allowedProviders: string[];
	jevEnabled: boolean;
	jevApiKey?: string;
	jevBaseUrl?: string;
	jevModel?: string;
	jevConfidenceThreshold: number;
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
	readonly presets: Volatile<ModelPresetConfig[]>;
	readonly policyPrompt: Volatile<string>;
	readonly planPreset: Volatile<string>;
	readonly planModel: Volatile<ModelSelectionConfig | undefined>;
	readonly autoRestorePlanModel: Volatile<boolean>;
	readonly enableModelTools: Volatile<boolean>;
	readonly enablePresetTools: Volatile<boolean>;
	readonly allowedProviders: Volatile<string[]>;
	readonly jevEnabled: Volatile<boolean>;
	readonly jevApiKey: Volatile<string>;
	readonly jevBaseUrl: Volatile<string>;
	readonly jevModel: Volatile<string>;
	readonly jevConfidenceThreshold: Volatile<number>;
}

/** Unwrap the live references into a plain, validated snapshot for one use. */
export function snapshotConfig(live: SetModelLiveConfig): ResolvedSetModelConfig {
	return resolveConfig({
		presets: live.presets.get(),
		policyPrompt: live.policyPrompt.get(),
		planPreset: live.planPreset.get(),
		planModel: live.planModel.get(),
		autoRestorePlanModel: live.autoRestorePlanModel.get(),
		enableModelTools: live.enableModelTools.get(),
		enablePresetTools: live.enablePresetTools.get(),
		allowedProviders: live.allowedProviders.get(),
		jevEnabled: live.jevEnabled.get(),
		jevApiKey: live.jevApiKey.get(),
		jevBaseUrl: live.jevBaseUrl.get(),
		jevModel: live.jevModel.get(),
		jevConfidenceThreshold: live.jevConfidenceThreshold.get()
	});
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeEffort(value: unknown, label: string, warnings: string[]): ReasoningEffort | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (isReasoningEffort(value)) return value;
	warnings.push(`${label}: unknown reasoningEffort "${String(value)}"; falling back to the model default`);
	return undefined;
}

function normalizePlanModel(raw: unknown, problems: string[], warnings: string[]): ResolvedPlanModel | undefined {
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
	const reasoningEffort = normalizeEffort(candidate.reasoningEffort, "planModel", warnings);
	return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function normalizePresets(
	raw: unknown,
	allowedProviders: string[],
	problems: string[],
	warnings: string[]
): ResolvedModelPreset[] {
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
		if (id === "") {
			problems.push(`${label}: id is required; ignoring it`);
			return;
		}
		if ((provider === "") !== (model === "")) {
			problems.push(
				`${label} ("${id}"): provider and model must both be set or both be empty; ignoring it`
			);
			return;
		}
		if (id === "keep") {
			problems.push(`${label}: preset id "keep" is reserved for Jev decision-making and cannot be used; ignoring it`);
			return;
		}
		if (seen.has(id)) {
			problems.push(`${label}: duplicate preset id "${id}"; ignoring it`);
			return;
		}
		if (provider !== "" && allowedProviders.length > 0 && !allowedProviders.includes(provider)) {
			problems.push(`${label} ("${id}"): provider "${provider}" is outside allowedProviders; ignoring it`);
			return;
		}

		const name = text(candidate.name);
		const when = text(candidate.when);
		const reasoningEffort = normalizeEffort(candidate.reasoningEffort, `${label} ("${id}")`, warnings);

		seen.add(id);
		presets.push({
			id,
			...(name !== "" ? { name } : {}),
			...(when !== "" ? { when } : {}),
			...(provider !== "" ? { provider, model } : {}),
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
	// 空或未声明 presets 都用内置三档；没有「零档位」这个状态。
	const presetRows = Array.isArray(source.presets) && source.presets.length > 0 ? source.presets : DEFAULT_PRESETS;
	const presets = normalizePresets(presetRows, allowedProviders, problems, warnings);
	const planModel = normalizePlanModel(source.planModel, problems, warnings);
	const planPreset = text(source.planPreset) || undefined;

	if (planPreset !== undefined && !presets.some((preset) => preset.id === planPreset)) {
		problems.push(`planPreset "${planPreset}" matches no declared preset; Plan Mode will not switch models`);
	}
	if (planPreset !== undefined && planModel !== undefined) {
		warnings.push("planModel is ignored because planPreset is set");
	}

	const enableModelTools = typeof source.enableModelTools === "boolean" ? source.enableModelTools : true;
	const enablePresetTools = typeof source.enablePresetTools === "boolean" ? source.enablePresetTools : false;

	const jevEnabled = typeof source.jevEnabled === "boolean" ? source.jevEnabled : false;
	const jevApiKey = text(source.jevApiKey) || undefined;
	const jevBaseUrl = text(source.jevBaseUrl) || undefined;
	const jevModel = text(source.jevModel) || undefined;

	let jevConfidenceThreshold = DEFAULT_JEV_CONFIDENCE_THRESHOLD;
	if (typeof source.jevConfidenceThreshold === "number" && Number.isFinite(source.jevConfidenceThreshold)) {
		if (source.jevConfidenceThreshold >= 0 && source.jevConfidenceThreshold <= 1) {
			jevConfidenceThreshold = source.jevConfidenceThreshold;
		} else {
			warnings.push(
				`jevConfidenceThreshold (${source.jevConfidenceThreshold}) must be between 0.0 and 1.0; falling back to ${DEFAULT_JEV_CONFIDENCE_THRESHOLD}`
			);
		}
	}

	// 策略提示词的读者只有两类：带调模工具的 Agent，以及 Jev。两个读者都不在时它只是一段死配置。
	const policyPrompt = typeof source.policyPrompt === "string" ? source.policyPrompt.trim() : "";
	if (policyPrompt !== "" && !enableModelTools && !enablePresetTools && !jevEnabled) {
		warnings.push(
			"policyPrompt is set but no model tools and no Jev auto switching are enabled; nothing reads it"
		);
	}
	// Jev 只拿得到档位的 when/name/id，缺 when 时判定依据只剩一个档位名。
	if (jevEnabled) {
		const withoutStage = presets.filter((preset) => preset.when === undefined).map((preset) => preset.id);
		if (withoutStage.length > 0) {
			warnings.push(
				`presets (${withoutStage.join(", ")}): no "when" stage description; Jev can only judge them by preset id`
			);
		}
	}

	return {
		presets,
		policyPrompt,
		...(planPreset !== undefined ? { planPreset } : {}),
		...(planModel !== undefined ? { planModel } : {}),
		autoRestorePlanModel: typeof source.autoRestorePlanModel === "boolean" ? source.autoRestorePlanModel : true,
		enableModelTools,
		enablePresetTools,
		allowedProviders,
		jevEnabled,
		...(jevApiKey !== undefined ? { jevApiKey } : {}),
		...(jevBaseUrl !== undefined ? { jevBaseUrl } : {}),
		...(jevModel !== undefined ? { jevModel } : {}),
		jevConfidenceThreshold,
		problems,
		warnings
	};
}
