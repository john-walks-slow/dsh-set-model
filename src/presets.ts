import type { ResolvedModelPreset, ResolvedSetModelConfig } from "./config.js";
import type { ActiveModelSelection, TargetModelSelection } from "./controller.js";

/** Find a preset by its id. */
export function findPreset(presets: readonly ResolvedModelPreset[], id: string): ResolvedModelPreset | undefined {
	return presets.find((preset) => preset.id === id);
}

/** Turn a preset into the selection shape `applyModelSelection` accepts. */
export function presetToSelection(preset: ResolvedModelPreset): TargetModelSelection {
	return {
		provider: preset.provider,
		model: preset.model,
		...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {})
	};
}

/**
 * Match a live selection back to the preset it came from. An exact effort match
 * wins; a preset that pins no effort matches any effort on the same route, so a
 * provider default does not hide the running preset.
 */
export function matchPreset(
	presets: readonly ResolvedModelPreset[],
	selection: ActiveModelSelection
): ResolvedModelPreset | undefined {
	const sameRoute = presets.filter(
		(preset) => preset.provider === selection.provider && preset.model === selection.model
	);
	return (
		sameRoute.find((preset) => preset.reasoningEffort === selection.reasoningEffort) ??
		sameRoute.find((preset) => preset.reasoningEffort === undefined)
	);
}

/** The fields one rendered preset line needs; tool output rows match it too. */
export interface PresetDisplay {
	id: string;
	name?: string;
	when?: string;
	provider: string;
	model: string;
	reasoningEffort?: string;
}

/** One line per preset, for the settings page summary and the model policy prompt. */
export function formatPreset(preset: PresetDisplay): string {
	const label = preset.name !== undefined && preset.name !== preset.id ? `${preset.id}（${preset.name}）` : preset.id;
	const effort = preset.reasoningEffort ? ` · reasoning ${preset.reasoningEffort}` : "";
	const when = preset.when ? ` — 适用：${preset.when}` : "";
	return `- **${label}** — ${preset.provider}/${preset.model}${effort}${when}`;
}

export function renderPresetRoster(presets: readonly ResolvedModelPreset[]): string {
	return presets.map(formatPreset).join("\n");
}

/**
 * The `dsh:model-policy` system prompt section. Empty when the deployment
 * declares neither a policy prompt nor preset mode, so an unconfigured plugin
 * leaves no trace in the prompt.
 */
export function renderModelPolicySection(config: ResolvedSetModelConfig): string {
	const blocks: string[] = [];
	if (config.policyPrompt !== "") {
		blocks.push(config.policyPrompt);
	}
	if (config.mode === "preset" && config.presets.length > 0) {
		const lead = config.enableAgentTools
			? "本部署只允许在下列模型档位之间切换；进入对应阶段时调用 switch_preset 换档："
			: "本部署声明的模型档位（调模工具已关闭，仅作说明）：";
		blocks.push(`${lead}\n\n${renderPresetRoster(config.presets)}`);
	}
	if (blocks.length === 0) return "";
	return `## Model policy\n\n${blocks.join("\n\n")}`;
}
