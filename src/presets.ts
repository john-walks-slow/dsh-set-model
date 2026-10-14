import type { ResolvedModelPreset, ResolvedSetModelConfig } from "./config.js";
import type { ActiveModelSelection, TargetModelSelection } from "./controller.js";

/** Find a preset by its id. */
export function findPreset(presets: readonly ResolvedModelPreset[], id: string): ResolvedModelPreset | undefined {
	return presets.find((preset) => preset.id === id);
}

/**
 * Turn a preset into the selection shape `applyModelSelection` accepts. A
 * preset that pins no route yields only the effort, which leaves the active
 * provider and model untouched.
 */
export function presetToSelection(preset: ResolvedModelPreset): TargetModelSelection {
	return {
		...(preset.provider !== undefined && preset.model !== undefined
			? { provider: preset.provider, model: preset.model }
			: {}),
		...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {})
	};
}

/** Whether a preset pins its own provider and model instead of following the active one. */
export function pinsRoute(preset: ResolvedModelPreset): boolean {
	return preset.provider !== undefined && preset.model !== undefined;
}

/**
 * Match a live selection back to the preset it came from. A preset that names
 * the running route beats one that follows it; within either group an exact
 * effort match wins, and a preset that pins no effort matches any effort on the
 * same route so a provider default does not hide the running preset.
 */
export function matchPreset(
	presets: readonly ResolvedModelPreset[],
	selection: ActiveModelSelection
): ResolvedModelPreset | undefined {
	const pinned = presets.filter(
		(preset) => pinsRoute(preset) && preset.provider === selection.provider && preset.model === selection.model
	);
	const inherited = presets.filter((preset) => !pinsRoute(preset));
	return (
		pinned.find((preset) => preset.reasoningEffort === selection.reasoningEffort) ??
		pinned.find((preset) => preset.reasoningEffort === undefined) ??
		inherited.find((preset) => preset.reasoningEffort === selection.reasoningEffort) ??
		inherited.find((preset) => preset.reasoningEffort === undefined)
	);
}

/** The fields one rendered preset line needs; tool output rows match it too. */
export interface PresetDisplay {
	id: string;
	name?: string;
	when?: string;
	provider?: string;
	model?: string;
	reasoningEffort?: string;
}

/** One line per preset, for the settings page summary and the model policy prompt. */
export function formatPreset(preset: PresetDisplay): string {
	const label = preset.name !== undefined && preset.name !== preset.id ? `${preset.id}（${preset.name}）` : preset.id;
	const route =
		preset.provider !== undefined && preset.model !== undefined
			? `${preset.provider}/${preset.model}`
			: "沿用当前模型";
	const effort = preset.reasoningEffort ? ` · reasoning ${preset.reasoningEffort}` : "";
	const when = preset.when ? ` — 适用：${preset.when}` : "";
	return `- **${label}** — ${route}${effort}${when}`;
}

export function renderPresetRoster(presets: readonly ResolvedModelPreset[]): string {
	return presets.map(formatPreset).join("\n");
}

/**
 * The `dsh:model-policy` system prompt section.
 *
 * The policy prompt is an instruction the reader has to be able to act on: the
 * Agent sees it only while it holds a model-switching tool, while Jev reads the
 * same text from the decision request. Nothing consumes it when both tool
 * switches and Jev are off, so an unconfigured plugin leaves no trace.
 */
export function renderModelPolicySection(config: ResolvedSetModelConfig): string {
	const blocks: string[] = [];
	if (config.policyPrompt !== "" && (config.enableModelTools || config.enablePresetTools)) {
		blocks.push(config.policyPrompt);
	}
	if (config.presets.length > 0 && (config.enablePresetTools || config.jevEnabled)) {
		const lead = config.enablePresetTools
			? "本部署只允许在下列模型档位之间切换；进入对应阶段时调用 switch_preset 换档："
			: "本部署声明的模型档位（档位工具已关闭，供 Jev 自动决策参考）：";
		blocks.push(`${lead}\n\n${renderPresetRoster(config.presets)}`);
	}
	if (blocks.length === 0) return "";
	return `## Model policy\n\n${blocks.join("\n\n")}`;
}
