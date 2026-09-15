import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

export interface ActiveModelSelection {
	provider: string;
	model: string;
	reasoningEffort?: string;
}

export interface TargetModelSelection {
	provider?: string;
	model?: string;
	reasoningEffort?: string;
}

/**
 * Resolve the current effective model selection for an agent session.
 */
export function resolveCurrentSelection(agent: Agent, ctx: Context): ActiveModelSelection {
	// 1. Check session projection if available
	const projectionState = (ctx as any).sessionProjections?.stateOf(agent.session, "modelSelection");
	if (projectionState?.pending) {
		return {
			provider: projectionState.pending.provider,
			model: projectionState.pending.model,
			...(projectionState.pending.reasoningEffort ? { reasoningEffort: projectionState.pending.reasoningEffort } : {})
		};
	}
	if (projectionState?.lastUsed) {
		return {
			provider: projectionState.lastUsed.provider,
			model: projectionState.lastUsed.model,
			...(projectionState.lastUsed.reasoningEffort ? { reasoningEffort: projectionState.lastUsed.reasoningEffort } : {})
		};
	}

	// 2. Check logged session request header
	const loggedHeader = agent.session.requestHeader?.();
	if (loggedHeader?.config) {
		const cfg = loggedHeader.config;
		return {
			provider: cfg.provider,
			model: cfg.model,
			...(cfg.reasoningEffort && loggedHeader.adapterDefaults?.reasoningEffort !== true
				? { reasoningEffort: String(cfg.reasoningEffort) }
				: {})
		};
	}

	// 3. Fallback to default model service
	const defaultModel = (ctx as any).agentDefaultModel?.currentSelection?.();
	if (defaultModel) {
		return {
			provider: defaultModel.provider,
			model: defaultModel.model,
			...(defaultModel.reasoningEffort ? { reasoningEffort: String(defaultModel.reasoningEffort) } : {})
		};
	}

	// 4. Fallback to agent options
	return {
		provider: (agent as any).options?.provider ?? "unknown",
		model: (agent as any).options?.model ?? "unknown",
		...((agent as any).options?.reasoningEffort ? { reasoningEffort: String((agent as any).options.reasoningEffort) } : {})
	};
}

/**
 * Check if the session is currently in Plan Mode.
 */
export function isPlanModeActive(agent: Agent, ctx: Context): boolean {
	const planState = (ctx as any).sessionProjections?.stateOf(agent.session, "plan");
	return planState?.active ?? false;
}

/**
 * Apply a validated model selection to an agent session.
 */
export async function applyModelSelection(
	agent: Agent,
	ctx: Context,
	target: TargetModelSelection,
	allowedProviders: string[] = []
): Promise<ActiveModelSelection> {
	const current = resolveCurrentSelection(agent, ctx);
	const targetProvider = target.provider?.trim() || current.provider;
	const targetModel = target.model?.trim() || current.model;
	const targetEffort = target.reasoningEffort !== undefined
		? (target.reasoningEffort === "" || target.reasoningEffort === "default" ? undefined : target.reasoningEffort)
		: current.reasoningEffort;

	// 1. Whitelist validation
	if (allowedProviders.length > 0 && !allowedProviders.includes(targetProvider)) {
		throw new Error(
			`Provider "${targetProvider}" is not permitted by deployment policy. Allowed providers: ${allowedProviders.join(", ")}`
		);
	}

	// 2. Validate route and options with ctx.llm
	const candidateConfig: any = {
		provider: targetProvider,
		model: targetModel,
		...(targetEffort ? { reasoningEffort: ReasoningEffortId(targetEffort) } : {})
	};

	let resolved: any;
	try {
		resolved = await (ctx as any).llm.resolveCallConfig(candidateConfig);
	} catch (error: any) {
		throw new Error(`Model validation failed for ${targetProvider}/${targetModel}: ${error?.message || String(error)}`);
	}

	// 3. Token pressure guard against context window
	if ((ctx as any).tokenMeter && (ctx as any).llm?.resolveModelInfo) {
		try {
			const modelInfo = await (ctx as any).llm.resolveModelInfo(resolved.provider, resolved.model);
			if (modelInfo?.context?.contextWindow) {
				const measurement = (ctx as any).tokenMeter.measure(agent.session);
				if (measurement && measurement.totalTokens > modelInfo.context.contextWindow) {
					throw new Error(
						`Current session token pressure (${measurement.totalTokens} tokens) exceeds target model context window (${modelInfo.context.contextWindow} tokens). ` +
						`Please compact context (e.g. clear_mind) before switching to this model.`
					);
				}
			}
		} catch (error: any) {
			if (error?.message?.includes("exceeds target model context window")) {
				throw error;
			}
			// Non-blocking for external lookup failures
		}
	}

	// 4. Commit model/selection event to session
	const normalizedSelection: ActiveModelSelection = {
		provider: resolved.provider,
		model: resolved.model,
		...(resolved.reasoningEffort ? { reasoningEffort: String(resolved.reasoningEffort) } : {})
	};

	agent.session.append("model/selection" as any, normalizedSelection as any);

	return normalizedSelection;
}

/**
 * List registered providers and their advertised models with capabilities.
 */
export async function listAvailableModels(
	ctx: Context,
	providerFilter?: string,
	allowedProviders: string[] = []
): Promise<Array<{
	provider: string;
	models: Array<{
		id: string;
		name: string;
		description?: string;
		reasoningEfforts?: string[];
		contextWindow?: number;
	}>;
}>> {
	if (!(ctx as any).llm?.listProviders) {
		return [];
	}

	const providers = (ctx as any).llm.listProviders();
	const results = [];

	for (const p of providers) {
		if (providerFilter && p.id !== providerFilter) continue;
		if (allowedProviders.length > 0 && !allowedProviders.includes(p.id)) continue;

		try {
			const models = await (ctx as any).llm.listModels(p.id);
			const modelList = [];
			for (const m of models) {
				try {
					const info = await (ctx as any).llm.resolveModelInfo(p.id, m.id);
					const entry: any = {
						id: String(m.id),
						name: String(m.name || m.id)
					};
					if (m.description) entry.description = String(m.description);
					if (info.reasoning?.efforts?.length) {
						entry.reasoningEfforts = info.reasoning.efforts.map((e: any) => String(e.id));
					}
					if (typeof info.context?.contextWindow === "number") {
						entry.contextWindow = info.context.contextWindow;
					}
					modelList.push(entry);
				} catch {
					const entry: any = {
						id: String(m.id),
						name: String(m.name || m.id)
					};
					if (m.description) entry.description = String(m.description);
					modelList.push(entry);
				}
			}
			results.push({
				provider: p.id,
				models: modelList
			});
		} catch {
			// Skip failing providers
		}
	}

	return results;
}
