import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
// Optional settings type augmentation, plus the Loader's `loader/volatile-update` declaration.
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { Config, snapshotConfig, type ResolvedSetModelConfig, type SetModelLiveConfig } from "./config.js";
import {
	applyModelSelection,
	resolveCurrentSelection,
	isPlanModeActive,
	type ActiveModelSelection,
	type TargetModelSelection
} from "./controller.js";
import { findPreset, matchPreset, presetToSelection, renderModelPolicySection } from "./presets.js";
import { setModelTool, listModelsTool, switchPresetTool, listPresetsTool } from "./tools.js";

export const name = "dsh-set-model";
export const inject = ["tools", "llm", "agents", "sessionProjections", "tokenMeter", "agentDefaultModel", "systemPrompt"];
export { Config };

/** Model policy sits between PLAN_POLICY (500) and TEAM_POLICY (600). */
const MODEL_POLICY_SECTION_NAME = "dsh:model-policy";
const MODEL_POLICY_SECTION_ORDER = 550;

type ToolFactory = (ctx: Context, live: () => ResolvedSetModelConfig) => ReturnType<typeof setModelTool>;

interface SessionPlanTrackState {
	planActive: boolean;
	stashedNonPlanModel?: ActiveModelSelection;
}

interface PlanTarget {
	selection: TargetModelSelection;
	/** Human-readable route for logs. */
	label: string;
}

/** The model Plan Mode should activate, resolved for the configured mode. */
function resolvePlanTarget(config: ResolvedSetModelConfig): PlanTarget | undefined {
	if (config.mode === "preset") {
		if (config.planPreset === undefined) return undefined;
		const preset = findPreset(config.presets, config.planPreset);
		return preset === undefined
			? undefined
			: { selection: presetToSelection(preset), label: `preset ${preset.id} (${preset.provider}/${preset.model})` };
	}
	if (config.planModel === undefined) return undefined;
	return {
		selection: config.planModel,
		label: `${config.planModel.provider}/${config.planModel.model}`
	};
}

export function apply(ctx: Context, initialConfig: SetModelLiveConfig) {
	// Every config field is volatile: the Loader commits a settings write into
	// these references in place (emitting `loader/volatile-update`) instead of
	// re-running apply, so the config is read per use, never snapshotted once.
	const current = (): ResolvedSetModelConfig => snapshotConfig(initialConfig);

	const reportProblems = (config: ResolvedSetModelConfig) => {
		for (const problem of config.problems) {
			ctx.logger?.error(`dsh-set-model: ${problem}`);
		}
		for (const warning of config.warnings) {
			ctx.logger?.warn(`dsh-set-model: ${warning}`);
		}
	};
	reportProblems(current());

	// 1. Settings: declare this instance's page policy, exactly as the official
	// settings pages do. The owner MUST be this entry's fiber — the injected
	// child fiber would register a policy the Settings UI never reads.
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
	});

	// 2. Model policy: a static system prompt section. It changes only with the
	// configuration, so the prompt prefix stays cacheable.
	ctx.systemPrompt.section({
		name: MODEL_POLICY_SECTION_NAME,
		order: MODEL_POLICY_SECTION_ORDER,
		text: () => renderModelPolicySection(current())
	});

	// 3. Dynamic Runtime Context: active model and preset in the tail snapshot (cache-safe)
	ctx.systemPrompt.context({
		name: "dsh:active_model_context",
		order: 10,
		text: (context) => {
			if (!context.agent) return "";
			const config = current();
			const selection = resolveCurrentSelection(context.agent, ctx);
			const preset = matchPreset(config.presets, selection);
			const effort = selection.reasoningEffort ? ` · reasoning: ${selection.reasoningEffort}` : "";
			const presetLabel = preset ? ` · preset: ${preset.id}` : "";
			const planStatus = isPlanModeActive(context.agent, ctx) ? " [Plan Mode Active]" : "";
			return `[Current active model: ${selection.provider}/${selection.model}${effort}${presetLabel}${planStatus}]`;
		}
	});

	// 4. Model tools for root agents. Which tools exist depends on mode /
	// enableAgentTools, so the set is rebuilt whenever the live values change.
	const agentTools = new WeakMap<Agent, Array<() => void>>();

	const registerToolsForAgent = (agent: Agent) => {
		if (!ctx.agents.roots().includes(agent)) return;
		for (const dispose of agentTools.get(agent) ?? []) dispose();
		agentTools.delete(agent);

		const config = current();
		if (!config.enableAgentTools) return;

		const factories: ToolFactory[] =
			config.mode === "preset" ? [switchPresetTool, listPresetsTool] : [setModelTool, listModelsTool];
		agentTools.set(
			agent,
			factories.map((factory) => agent.ctx.tools.register(factory(ctx, current)))
		);
	};

	const syncTools = () => {
		for (const root of ctx.agents.roots()) registerToolsForAgent(root);
	};

	ctx.on("agent/created", ({ agent }: { agent: Agent }) => {
		registerToolsForAgent(agent);
		// agent/created is a serial listener: it must resolve to undefined.
		return undefined;
	});
	syncTools();

	ctx.on("loader/volatile-update", () => {
		reportProblems(current());
		syncTools();
	});

	// 5. Plan Mode lifecycle tracking: auto-stash & restore model
	const sessionPlanStates = new WeakMap<any, SessionPlanTrackState>();

	ctx.on(
		"agent/pre-step",
		async (
			payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
			next: () => Promise<PreStepDecision>
		): Promise<PreStepDecision> => {
			const agent = payload.agent;
			const session = agent?.session;

			if (session && (ctx as any).sessionProjections) {
				const planState = (ctx as any).sessionProjections.stateOf(session, "plan");
				if (planState !== undefined) {
					const isPlanActive = Boolean(planState.active);
					let track = sessionPlanStates.get(session);

					if (track === undefined) {
						track = { planActive: isPlanActive };
						sessionPlanStates.set(session, track);
					}

					// State transition: Inactive -> Active (Entering Plan Mode)
					if (!track.planActive && isPlanActive) {
						track.stashedNonPlanModel = resolveCurrentSelection(agent, ctx);
						track.planActive = true;

						const config = current();
						const target = resolvePlanTarget(config);
						if (target !== undefined) {
							try {
								await applyModelSelection(agent, ctx, target.selection, config.allowedProviders);
								ctx.logger?.info(`dsh-set-model: entered Plan Mode, auto-switched to ${target.label}`);
							} catch (err) {
								ctx.logger?.warn(
									`dsh-set-model: failed to auto-switch to plan model: ${err instanceof Error ? err.message : String(err)}`
								);
							}
						}
					}
					// State transition: Active -> Inactive (Exiting Plan Mode)
					else if (track.planActive && !isPlanActive) {
						const stashed = track.stashedNonPlanModel;
						track.planActive = false;
						track.stashedNonPlanModel = undefined;

						const config = current();
						if (config.autoRestorePlanModel && stashed) {
							try {
								await applyModelSelection(agent, ctx, stashed, config.allowedProviders);
								ctx.logger?.info(
									`dsh-set-model: exited Plan Mode, auto-restored previous model: ${stashed.provider}/${stashed.model}`
								);
							} catch (err) {
								ctx.logger?.warn(
									`dsh-set-model: failed to auto-restore previous model: ${err instanceof Error ? err.message : String(err)}`
								);
							}
						}
					}
				}
			}

			return next();
		}
	);

	ctx.logger?.info(
		`dsh-set-model: initialized in ${current().mode} mode (${current().presets.length} preset(s))`
	);
}

export default {
	name,
	inject,
	Config,
	apply
};
