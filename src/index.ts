import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
// Pull optional settings type augmentation
import type {} from "@deepseek-ai/dsh-settings";
import { Config, resolveConfig, type ResolvedSetModelConfig } from "./config.js";
import {
	applyModelSelection,
	resolveCurrentSelection,
	type ActiveModelSelection
} from "./controller.js";
import { setModelTool, getModelTool, listModelsTool } from "./tools.js";

export const name = "dsh-set-model";
export const inject = ["tools", "llm", "agents", "sessionProjections", "tokenMeter", "agentDefaultModel"];
export { Config };

export const SETTINGS_NAMESPACE = "dsh-set-model";

interface SessionPlanTrackState {
	planActive: boolean;
	stashedNonPlanModel?: ActiveModelSelection;
}

export function apply(ctx: Context, initialConfig: Record<string, unknown> = {}) {
	let currentConfig: ResolvedSetModelConfig = resolveConfig(initialConfig);

	// 1. Settings integration: install settings namespace for Web Settings UI & dynamic reconfig
	ctx.inject(["settings"], (settingsCtx) => {
		(settingsCtx as any).settings?.installSection(ctx, SETTINGS_NAMESPACE, Config, initialConfig, {
			setSource: (source: any) => {
				currentConfig = resolveConfig(source);
			},
			onChange: () => {}
		});
	});

	// 2. Register agent tools for root agents
	const registeredAgents = new WeakSet<Agent>();
	const registerToolsForAgent = (agent: Agent) => {
		if (registeredAgents.has(agent)) return;
		if (!ctx.agents.roots().includes(agent)) return;
		registeredAgents.add(agent);

		if (currentConfig.enableAgentTools) {
			agent.ctx.tools.register(setModelTool(ctx, currentConfig));
			agent.ctx.tools.register(getModelTool(ctx));
			agent.ctx.tools.register(listModelsTool(ctx, currentConfig));
		}
	};

	ctx.on("agent/created", ({ agent }: { agent: Agent }) => {
		registerToolsForAgent(agent);
	});
	for (const root of ctx.agents.roots()) {
		registerToolsForAgent(root);
	}

	// 3. Plan Mode lifecycle tracking: auto-stash & restore model
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

						if (currentConfig.planModel) {
							try {
								await applyModelSelection(
									agent,
									ctx,
									currentConfig.planModel,
									currentConfig.allowedProviders
								);
								ctx.logger?.info(
									`dsh-set-model: entered Plan Mode, auto-switched to plan model: ${currentConfig.planModel.provider}/${currentConfig.planModel.model}`
								);
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

						if (currentConfig.autoRestorePlanModel && stashed) {
							try {
								await applyModelSelection(agent, ctx, stashed, currentConfig.allowedProviders);
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

	ctx.logger?.info("dsh-set-model: initialized successfully");
}

export default {
	name,
	inject,
	Config,
	apply
};
