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
import { findPreset, matchPreset, pinsRoute, presetToSelection, renderModelPolicySection } from "./presets.js";
import { setModelTool, listModelsTool, switchPresetTool, listPresetsTool } from "./tools.js";
import { runJevModelInference, defaultJevManager, JevInferenceManager, probeJevEndpoint } from "./jev.js";

export const name = "dsh-set-model";
export const inject = ["tools", "llm", "agents", "sessionProjections", "tokenMeter", "agentDefaultModel", "systemPrompt"];
export { Config, defaultJevManager, JevInferenceManager };

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

/** Web 壳提供的 Fetch 路由注册面（不在 cordis 的 Context 类型上）。 */
interface JevProbeConnection {
	fetch: { register(route: unknown): () => Promise<void> };
}

/** The model Plan Mode should activate: an explicit preset wins over a raw route. */
function resolvePlanTarget(config: ResolvedSetModelConfig): PlanTarget | undefined {
	if (config.planPreset !== undefined) {
		const preset = findPreset(config.presets, config.planPreset);
		if (preset === undefined) return undefined;
		const route = pinsRoute(preset) ? `${preset.provider}/${preset.model}` : "沿用当前模型";
		return { selection: presetToSelection(preset), label: `preset ${preset.id} (${route})` };
	}
	if (config.planModel === undefined) return undefined;
	return {
		selection: config.planModel,
		label: `${config.planModel.provider}/${config.planModel.model}`
	};
}

export function apply(ctx: Context, initialConfig: SetModelLiveConfig) {
	// Dispose all in-flight Jev requests on plugin unload/reload.
	ctx.effect(() => () => defaultJevManager.abortAll());

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

	// 1a. RPC route for the Web settings page to test Jev connectivity.
	// The client cannot read process.env, so the probe must run in the host
	// process. Credentials are resolved here using the exact same logic as the
	// runtime Jev inference (plugin settings > env vars > defaults).
	// 1a. Jev 测速路由：浏览器读不到 process.env，因此探测在宿主进程内执行，
	// 复用与回合推断同源的凭据解析（插件设置 → 环境变量 → 默认值）。
	// 用 ctx.inject 等待 connection 就绪：它是 Web 壳提供的服务，apply 时可能尚未挂载。
	ctx.inject(["connection"], (connCtx) => {
		// `connection` 由 Web 壳提供，不在 cordis 的 Context 类型面上。
		const conn = (connCtx as unknown as { connection: JevProbeConnection }).connection;
		connCtx.effect(
			() =>
				conn.fetch.register({
					path: "/api/dsh-set-model/jev-probe",
					methods: ["POST"],
					requestBody: "buffered",
					fetch: async (request: Request) => {
						const body = (await request.json().catch(() => ({}))) as {
							baseUrl?: string;
							model?: string;
						};
						return Response.json(await probeJevEndpoint(body, current()));
					}
				}),
			"dsh-set-model: Jev probe"
		);
	});


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
		const factories: ToolFactory[] = [];
		if (config.enableModelTools) factories.push(setModelTool, listModelsTool);
		if (config.enablePresetTools) factories.push(switchPresetTool, listPresetsTool);
		if (factories.length === 0) return;
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

			// 6. Jev auto model switching on turn start (step 1 in host loop), bypassed if Plan Mode is active
			if (payload.step === 1 && agent && !isPlanModeActive(agent, ctx)) {
				try {
					await runJevModelInference(ctx, agent, payload.messages, current);
				} catch (err) {
					ctx.logger?.warn(
						`dsh-set-model: Jev inference error: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			return next();
		}
	);

	ctx.logger?.info(
		`dsh-set-model: initialized with ${current().presets.length} preset(s) ` +
			`(model tools: ${current().enableModelTools ? "on" : "off"}, ` +
			`preset tools: ${current().enablePresetTools ? "on" : "off"}, ` +
			`Jev: ${current().jevEnabled ? "on" : "off"})`
	);
}

export default {
	name,
	inject,
	Config,
	apply
};
