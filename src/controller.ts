import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { REASONING_EFFORTS } from "./config.js";

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
 * Adapt a requested reasoning effort to the target model's supported efforts.
 *
 * - If the model supports no reasoning efforts at all, returns `undefined`.
 * - If the requested effort is directly supported, returns it unchanged.
 * - If the requested effort is `"off"` and `"off"` is not supported, picks the
 *   lowest supported effort.
 * - For any thinking effort (`minimal`..`max`) not directly supported, clamps to
 *   the nearest non-`"off"` supported effort on the escalation ladder
 *   (`off < minimal < low < medium < high < xhigh < max`), breaking ties upward.
 */
export function adaptReasoningEffort(
	desired: string | undefined,
	supportedEfforts: readonly string[] | undefined
): string | undefined {
	if (!supportedEfforts || supportedEfforts.length === 0) {
		return undefined;
	}
	if (desired === undefined) {
		return undefined;
	}
	if (supportedEfforts.includes(desired)) {
		return desired;
	}

	const rankOf = (effort: string): number => (REASONING_EFFORTS as readonly string[]).indexOf(effort);
	const desiredRank = rankOf(desired);
	if (desiredRank === -1) {
		return undefined;
	}

	// When a thinking level is requested, avoid collapsing to "off" if any thinking level exists.
	const candidates =
		desired === "off"
			? supportedEfforts
			: supportedEfforts.filter((effort) => effort !== "off");
	const pool = candidates.length > 0 ? candidates : supportedEfforts;

	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	let bestRank = -1;

	for (const candidate of pool) {
		const candidateRank = rankOf(candidate);
		if (candidateRank === -1) continue;
		const distance = Math.abs(candidateRank - desiredRank);
		if (distance < bestDistance || (distance === bestDistance && candidateRank > bestRank)) {
			best = candidate;
			bestDistance = distance;
			bestRank = candidateRank;
		}
	}

	return best ?? pool[0];
}

/**
 * Resolve the current effective model selection for an agent session.
 */
export function resolveCurrentSelection(agent: Agent, ctx: Context): ActiveModelSelection {
	// 1. Pending selection recorded by the GUI model picker or a set_model call
	const projectionState = (ctx as any).sessionProjections?.stateOf(agent.session, "modelSelection");
	if (projectionState?.pending) {
		return {
			provider: projectionState.pending.provider,
			model: projectionState.pending.model,
			...(projectionState.pending.reasoningEffort ? { reasoningEffort: projectionState.pending.reasoningEffort } : {})
		};
	}

	// 2. Route of the last logged request
	const loggedHeader = agent.session.requestHeader();
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

	// 3. Deployment default model service
	const defaultModel = (ctx as any).agentDefaultModel?.currentSelection?.();
	if (defaultModel) {
		return {
			provider: defaultModel.provider,
			model: defaultModel.model,
			...(defaultModel.reasoningEffort ? { reasoningEffort: String(defaultModel.reasoningEffort) } : {})
		};
	}

	// 4. Agent options: a fresh agent that has not sent a request yet
	return {
		provider: agent.options?.provider ?? "unknown",
		model: agent.options?.model ?? "unknown",
		...(agent.options?.reasoningEffort ? { reasoningEffort: String(agent.options.reasoningEffort) } : {})
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

	// 2. Inspect target model capabilities to adapt reasoningEffort across models
	const preModelInfo = await readModelInfo(ctx, targetProvider, targetModel);
	const supportedEfforts: string[] | undefined = preModelInfo?.reasoning?.efforts?.map((e: any) => String(e.id));
	const effectiveEffort =
		preModelInfo !== undefined ? adaptReasoningEffort(targetEffort, supportedEfforts) : targetEffort;

	// 3. Validate route and options with ctx.llm
	const candidateConfig: any = {
		provider: targetProvider,
		model: targetModel,
		...(effectiveEffort ? { reasoningEffort: ReasoningEffortId(effectiveEffort) } : {})
	};

	let resolved: any;
	try {
		resolved = await (ctx as any).llm.resolveCallConfig(candidateConfig);
	} catch (error: any) {
		throw new Error(`Model validation failed for ${targetProvider}/${targetModel}: ${error?.message || String(error)}`);
	}

	// 4. Token pressure guard against the target context window
	const modelInfo =
		preModelInfo !== undefined && resolved.provider === targetProvider && resolved.model === targetModel
			? preModelInfo
			: await (ctx as any).llm.resolveModelInfo(resolved.provider, resolved.model);
	if (modelInfo?.context?.contextWindow) {
		const measurement = (ctx as any).tokenMeter.measure(agent.session);
		if (measurement && measurement.totalTokens > modelInfo.context.contextWindow) {
			throw new Error(
				`Current session token pressure (${measurement.totalTokens} tokens) exceeds target model context window (${modelInfo.context.contextWindow} tokens). ` +
				`Please compact context (e.g. clear_mind) before switching to this model.`
			);
		}
	}

	// 5. Commit model/selection event to session
	const normalizedSelection: ActiveModelSelection = {
		provider: resolved.provider,
		model: resolved.model,
		...(resolved.reasoningEffort ? { reasoningEffort: String(resolved.reasoningEffort) } : {})
	};

	agent.session.append("model/selection" as any, normalizedSelection as any);

	return normalizedSelection;
}

export interface ModelListEntry {
	id: string;
	name: string;
	description?: string;
	reasoningEfforts?: string[];
	contextWindow?: number;
}

export interface ProviderModels {
	provider: string;
	models: ModelListEntry[];
}

/**
 * Read one model's advertised capabilities. A provider that cannot advertise
 * them still lists the model, so an unreadable lookup is not an error.
 */
async function readModelInfo(ctx: Context, provider: string, model: string): Promise<any> {
	try {
		return await (ctx as any).llm.resolveModelInfo(provider, model);
	} catch {
		return undefined;
	}
}

/**
 * List registered providers and their advertised models with capabilities.
 */
export async function listAvailableModels(
	ctx: Context,
	providerFilter?: string,
	allowedProviders: string[] = []
): Promise<ProviderModels[]> {
	const results: ProviderModels[] = [];

	for (const p of (ctx as any).llm.listProviders()) {
		if (providerFilter && p.id !== providerFilter) continue;
		if (allowedProviders.length > 0 && !allowedProviders.includes(p.id)) continue;

		try {
			const models = await (ctx as any).llm.listModels(p.id);
			const modelList: ModelListEntry[] = [];
			for (const m of models) {
				const entry: ModelListEntry = {
					id: String(m.id),
					name: String(m.name || m.id)
				};
				if (m.description) entry.description = String(m.description);

				const info = await readModelInfo(ctx, p.id, m.id);
				if (info?.reasoning?.efforts?.length) {
					entry.reasoningEfforts = info.reasoning.efforts.map((e: any) => String(e.id));
				}
				if (typeof info?.context?.contextWindow === "number") {
					entry.contextWindow = info.context.contextWindow;
				}
				modelList.push(entry);
			}
			results.push({ provider: p.id, models: modelList });
		} catch {
			// One unreadable provider must not hide every other provider's models
		}
	}

	return results;
}
