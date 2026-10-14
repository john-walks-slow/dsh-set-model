/**
 * Jev 自动模型切换核心模块：
 * - 解析 Jev Decisions API 凭据（配置项 jevApiKey/jevBaseUrl/jevModel → 环境变量 JEV_API_KEY/JEV_BASE_URL/JEV_MODEL）；
 * - 提取会话最新上下文作为决策状态（state），优先使用当前回合首步的 UserMessage 输入；
 * - 把部署的策略提示词一并作为 state.policy 送出，与 Agent 侧共用同一份判据；
 * - 将配置的模型档位（Presets）映射为 Jev 的 Choice Criteria；
 * - 调用 TypeSafe Jev 决策模型获取最佳档位与置信度；
 * - 会话级 generation 竞态保护与提交前配置实时核验；
 * - 结合 Plan 模式避让，安全调用 applyModelSelection 切换模型。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import {
	DEFAULT_JEV_BASE_URL,
	DEFAULT_JEV_CONFIDENCE_THRESHOLD,
	DEFAULT_JEV_MODEL,
	type ResolvedModelPreset,
	type ResolvedSetModelConfig
} from "./config.js";
import {
	applyModelSelection,
	isPlanModeActive,
	resolveCurrentSelection,
	type ActiveModelSelection
} from "./controller.js";
import { findPreset, presetToSelection } from "./presets.js";

/** Jev 判定请求超时时间（毫秒）。 */
export const JEV_REQUEST_TIMEOUT_MS = 3000;

export interface JevCredentials {
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly model: string;
}

export interface JevDecisionOutcome {
	readonly choice: string;
	readonly confidence: number;
	readonly probabilities: Record<string, number>;
}

export interface JevProbeResult {
	readonly ok: boolean;
	readonly status: number;
	readonly latencyMs: number;
	readonly message: string;
}

/** 解析 Jev API 凭据（优先级：插件配置 → 环境变量 JEV_API_KEY/JEV_BASE_URL/JEV_MODEL）。 */
export function resolveJevCredentials(config?: Partial<ResolvedSetModelConfig>): JevCredentials | null {
	const explicitKey = config?.jevApiKey?.trim();
	const envKey = process.env.JEV_API_KEY?.trim();
	const apiKey =
		explicitKey && explicitKey.length > 0
			? explicitKey
			: envKey && envKey.length > 0
				? envKey
				: null;

	if (!apiKey) return null;

	const explicitUrl = config?.jevBaseUrl?.trim();
	const envUrl = process.env.JEV_BASE_URL?.trim();
	const baseUrl =
		explicitUrl && explicitUrl.length > 0
			? explicitUrl
			: envUrl && envUrl.length > 0
				? envUrl
				: DEFAULT_JEV_BASE_URL;

	const explicitModel = config?.jevModel?.trim();
	const envModel = process.env.JEV_MODEL?.trim();
	const model =
		explicitModel && explicitModel.length > 0
			? explicitModel
			: envModel && envModel.length > 0
				? envModel
				: DEFAULT_JEV_MODEL;

	return { apiKey, baseUrl, model };
}

/**
 * 用一次最小决策请求探测 Jev 端点，返回耗时与结果。
 *
 * 凭据与端点解析走 {@link resolveJevCredentials}，与回合自动推断完全同源，
 * 因此无论 Key 来自插件配置还是环境变量，测速结果都一致。
 */
export async function probeJevEndpoint(
	overrides: { baseUrl?: string; model?: string } = {},
	config?: Partial<ResolvedSetModelConfig>
): Promise<JevProbeResult> {
	const credentials = resolveJevCredentials({
		...config,
		...(overrides.baseUrl?.trim() ? { jevBaseUrl: overrides.baseUrl.trim() } : {}),
		...(overrides.model?.trim() ? { jevModel: overrides.model.trim() } : {})
	});
	if (!credentials) {
		return {
			ok: false,
			status: 0,
			latencyMs: 0,
			message: "未配置 Jev API Key：请在设置页填写，或设置环境变量 JEV_API_KEY"
		};
	}

	const start = Date.now();
	try {
		const response = await fetch(credentials.baseUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.apiKey}`,
				"Content-Type": "application/json",
				"X-Title": "dsh-set-model"
			},
			body: JSON.stringify({
				model: credentials.model,
				state: "probe",
				questions: {
					ping: { type: "choice", instructions: "ping", criteria: { ok: "ok" } }
				}
			}),
			signal: AbortSignal.timeout(JEV_REQUEST_TIMEOUT_MS)
		});
		const latencyMs = Date.now() - start;
		const text = await response.text().catch(() => "");

		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				latencyMs,
				message: `HTTP ${response.status}：${text.slice(0, 200) || response.statusText}`
			};
		}

		let choice: unknown;
		try {
			choice = (JSON.parse(text) as { answers?: { ping?: { choice?: unknown } } }).answers?.ping?.choice;
		} catch {
			choice = undefined;
		}
		return {
			ok: true,
			status: response.status,
			latencyMs,
			message:
				typeof choice === "string"
					? `${credentials.model} · ${latencyMs}ms`
					: `已连通 · ${latencyMs}ms（响应结构异常）`
		};
	} catch (error) {
		return {
			ok: false,
			status: 0,
			latencyMs: Date.now() - start,
			message: error instanceof Error ? error.message : String(error)
		};
	}
}

/** 从 ContentBlock 数组或字符串中提取纯文本。 */
function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((block) => block && (block.type === "text" || typeof block.text === "string"))
			.map((block) => (typeof block.text === "string" ? block.text : ""))
			.join("\n")
			.trim();
	}
	return "";
}

/** Jev 上下文总长度截断上限（字符数）。 */
export const MAX_JEV_CONTEXT_CHARS = 2000;

/**
 * 提取供 Jev 决策使用的当前指令与上下文。
 *
 * 考虑用户本轮可能仅回复极短指令（如“好的”、“go”、“开始吧”），为了让 Jev 能准确感知任务阶段与目标：
 * 将【上一次模型回复】与【本次用户指令】按时间先后顺序合并为整体，再从末尾进行截断（end-align），
 * 确保既完整保留最新的用户输入，又包含上轮模型的关键方案与进展上下文。
 */
export function extractJevContext(
	messages: readonly UserMessage[] = [],
	session?: Session
): string {
	let latestUserText = "";

	// 1. 优先从当前回合 pre-step 传入的 messages 中查找真实指令
	if (Array.isArray(messages) && messages.length > 0) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (!msg) continue;
			const text = extractTextFromContent(msg.content);
			if (text) {
				latestUserText = text;
				// 优先命中人类直接输入（kind: "user"）
				if (msg.source?.kind === "user") {
					break;
				}
			}
		}
	}

	// 2. 如果 messages 中未包含指令，回退到 session.deriveMessages() 提取历史 user 消息
	if (!latestUserText && session && typeof session.deriveMessages === "function") {
		const derived = session.deriveMessages();
		if (Array.isArray(derived)) {
			for (let i = derived.length - 1; i >= 0; i--) {
				const msg = derived[i];
				if (msg?.role === "user") {
					const text = extractTextFromContent(msg.content);
					if (text) {
						latestUserText = text;
						break;
					}
				}
			}
		}
	}

	if (!latestUserText) return "";

	// 3. 从 session.deriveMessages() 中提取上一次模型回复作为前置上下文
	let previousAssistantText = "";
	if (session && typeof session.deriveMessages === "function") {
		const derived = session.deriveMessages();
		if (Array.isArray(derived)) {
			for (let i = derived.length - 1; i >= 0; i--) {
				const msg = derived[i];
				if (msg?.role === "assistant") {
					const text = extractTextFromContent(msg.content);
					if (text) {
						previousAssistantText = text;
						break;
					}
				}
			}
		}
	}

	// 4. 将上一次模型回复与本次用户回复按时序拼在一起，整体做 end-align 尾部对齐截断
	const combined = previousAssistantText
		? `Previous assistant response:\n${previousAssistantText}\n\nCurrent user instruction:\n${latestUserText}`
		: `Current user instruction:\n${latestUserText}`;

	if (combined.length > MAX_JEV_CONTEXT_CHARS) {
		return combined.slice(-MAX_JEV_CONTEXT_CHARS);
	}
	return combined;
}

/** 一次档位判定的输入：当前上下文、候选档位，以及可选的部署策略。 */
export interface JevDecisionRequest {
	/** 当前指令与上一轮助手回复，见 {@link extractJevContext}。 */
	readonly context: string;
	/** 参与判定的档位；也是 criteria 的声明顺序。 */
	readonly presets: readonly ResolvedModelPreset[];
	/** 部署的策略提示词，与 Agent 侧共用同一份文本；非空时随请求发送。 */
	readonly policyPrompt?: string;
}

/** 调用 Jev Decisions API 执行模型档位判定。 */
export async function queryJevPresetDecision(
	request: JevDecisionRequest,
	credentials: JevCredentials,
	signal?: AbortSignal
): Promise<JevDecisionOutcome | null> {
	const { context, presets, policyPrompt } = request;
	if (presets.length === 0) return null;

	const criteria: Record<string, string> = {};
	for (const preset of presets) {
		const desc = preset.when || preset.name || preset.id;
		const effortDesc = preset.reasoningEffort ? ` (reasoning: ${preset.reasoningEffort})` : "";
		criteria[preset.id] = `${desc}${effortDesc}`;
	}
	criteria["keep"] = "Keep current model or no other preset clearly matches this task phase";

	const instructions =
		"Which model preset is best suited for the user's current task phase and instruction?";

	// 策略与当前态势是两回事，分开命名交给 Jev：state 既接受字符串也接受对象。
	const policy = policyPrompt?.trim() ?? "";
	const state = policy === "" ? context : { policy, context };

	const payload = {
		model: credentials.model,
		state,
		questions: {
			preset: {
				type: "choice",
				instructions,
				criteria
			}
		}
	};

	const response = await fetch(credentials.baseUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credentials.apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://github.com/john-walks-slow/dsh-set-model",
			"X-Title": "dsh-set-model"
		},
		body: JSON.stringify(payload),
		signal
	});

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "");
		throw new Error(`Jev API error ${response.status}: ${errorBody.slice(0, 200)}`);
	}

	const result = (await response.json()) as {
		answers?: {
			preset?: {
				type?: string;
				choice?: string;
				confidence?: number;
				probabilities?: Record<string, number>;
			};
		};
	};

	const answer = result.answers?.preset;
	if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
		return null;
	}

	// 必须是 0 到 1 之间的有限数字，拒绝 NaN、Infinity、-Infinity 与负数
	if (
		typeof answer.confidence !== "number" ||
		!Number.isFinite(answer.confidence) ||
		answer.confidence < 0 ||
		answer.confidence > 1
	) {
		return null;
	}

	const choiceKey = answer.choice.trim();
	if (!Object.prototype.hasOwnProperty.call(criteria, choiceKey)) {
		return null;
	}

	const probabilities: Record<string, number> = {};
	if (answer.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities)) {
		for (const [k, v] of Object.entries(answer.probabilities)) {
			if (typeof v === "number" && Number.isFinite(v)) {
				probabilities[k] = v;
			}
		}
	}

	return {
		choice: choiceKey,
		confidence: answer.confidence,
		probabilities
	};
}

/** 记录每个会话的推断序号（generation）与请求控制器。 */
interface InFlightRecord {
	generation: number;
	controller: AbortController;
}

export class JevInferenceManager {
	private readonly inFlightMap = new Map<string, InFlightRecord>();
	private readonly sessionGenerations = new Map<string, number>();

	/** 使指定会话当前进行中的推断请求失效并取消。 */
	abortSession(sessionId: string): void {
		const nextGen = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
		this.sessionGenerations.set(sessionId, nextGen);
		const inFlight = this.inFlightMap.get(sessionId);
		if (inFlight) {
			inFlight.controller.abort();
			this.inFlightMap.delete(sessionId);
		}
	}

	/** 取消全部正在运行的推断任务并清空状态。 */
	abortAll(): void {
		for (const record of this.inFlightMap.values()) {
			record.controller.abort();
		}
		this.inFlightMap.clear();
		this.sessionGenerations.clear();
	}

	getGeneration(sessionId: string): number {
		return this.sessionGenerations.get(sessionId) ?? 0;
	}

	nextGeneration(sessionId: string): { generation: number; controller: AbortController } {
		const nextGen = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
		this.sessionGenerations.set(sessionId, nextGen);

		const prev = this.inFlightMap.get(sessionId);
		if (prev) {
			prev.controller.abort();
		}

		const controller = new AbortController();
		this.inFlightMap.set(sessionId, { generation: nextGen, controller });
		return { generation: nextGen, controller };
	}

	cleanupInFlight(sessionId: string, generation: number): void {
		const current = this.inFlightMap.get(sessionId);
		if (current?.generation === generation) {
			this.inFlightMap.delete(sessionId);
		}
	}
}

/** 默认单例管理器。 */
export const defaultJevManager = new JevInferenceManager();

export type ConfigProvider = ResolvedSetModelConfig | (() => ResolvedSetModelConfig);

function resolveConfigSnapshot(provider: ConfigProvider): ResolvedSetModelConfig {
	return typeof provider === "function" ? provider() : provider;
}

function isSameSelection(current: ActiveModelSelection, target: ResolvedModelPreset): boolean {
	// 未钉死路由的档位只约束思考深度，模型跟着当前会话走。
	if (target.provider !== undefined && target.model !== undefined) {
		if (current.provider !== target.provider || current.model !== target.model) {
			return false;
		}
	}
	const currentEffort = current.reasoningEffort ?? undefined;
	const targetEffort = target.reasoningEffort ?? undefined;
	return currentEffort === targetEffort;
}

/**
 * 调度执行单次 Jev 模型自动推断与切换：
 * - 避开子代理会话与 Plan 模式；
 * - 校验 Jev 启用状态、预设配置与凭据；
 * - generation 递增守护；
 * - 提取最新上下文（以当前回合的 messages 为主）并调用 Jev 决策模型；
 * - 提交前双重核验 generation 与实时 jevEnabled；
 * - 比较目标预设与当前会话模型，若不同则应用切换。
 */
export async function runJevModelInference(
	ctx: Context,
	agent: Agent,
	messages: readonly UserMessage[] = [],
	configProvider: ConfigProvider,
	manager: JevInferenceManager = defaultJevManager
): Promise<boolean> {
	const session = agent.session;
	if (!session) return false;

	// 跳过子代理会话
	if (session.header?.parentSession !== undefined || session.header?.origin === "subagent") {
		return false;
	}

	const initialConfig = resolveConfigSnapshot(configProvider);
	if (!initialConfig.jevEnabled) {
		manager.abortSession(session.id);
		return false;
	}

	if (initialConfig.presets.length === 0) {
		manager.abortSession(session.id);
		return false;
	}

	// Plan 模式锁定优先，主动避让
	if (isPlanModeActive(agent, ctx)) {
		return false;
	}

	const credentials = resolveJevCredentials(initialConfig);
	if (!credentials) {
		manager.abortSession(session.id);
		ctx.logger?.debug?.("dsh-set-model: Jev credentials not available, skipping inference");
		return false;
	}

	const contextText = extractJevContext(messages, session);
	if (!contextText || contextText.trim().length === 0) {
		manager.abortSession(session.id);
		return false;
	}

	// generation 递增守护，淘汰旧请求并开启新控制器
	const { generation: gen, controller } = manager.nextGeneration(session.id);
	const timeoutId = setTimeout(() => controller.abort(), JEV_REQUEST_TIMEOUT_MS);

	try {
		const decision = await queryJevPresetDecision(
			{
				context: contextText,
				presets: initialConfig.presets,
				policyPrompt: initialConfig.policyPrompt
			},
			credentials,
			controller.signal
		);
		if (!decision) return false;

		// 提交前校验 1：若该会话已发起更新的推断或已被取消，则当前结果作废
		if (manager.getGeneration(session.id) !== gen) {
			return false;
		}

		// 提交前校验 2：实时重新读取配置，确认等待响应期间未被用户关闭 Jev
		const currentConfig = resolveConfigSnapshot(configProvider);
		if (!currentConfig.jevEnabled) {
			return false;
		}

		// 提交前校验 3：再次确认当前是否进入了 Plan Mode
		if (isPlanModeActive(agent, ctx)) {
			return false;
		}

		const threshold = currentConfig.jevConfidenceThreshold ?? DEFAULT_JEV_CONFIDENCE_THRESHOLD;
		if (decision.confidence < threshold) {
			ctx.logger?.debug?.(
				`dsh-set-model: Jev confidence ${decision.confidence} below threshold ${threshold} for ${session.id}`
			);
			return false;
		}

		// 若决策为 keep，保持当前模型不变
		if (decision.choice === "keep") {
			return false;
		}

		const targetPreset = findPreset(currentConfig.presets, decision.choice);
		if (!targetPreset) {
			return false;
		}

		// 检查当前会话真实模型
		const currentSelection = resolveCurrentSelection(agent, ctx);
		if (isSameSelection(currentSelection, targetPreset)) {
			return false;
		}

		// 执行模型切换
		const targetSelection = presetToSelection(targetPreset);
		await applyModelSelection(agent, ctx, targetSelection, currentConfig.allowedProviders);

		const effortText = targetPreset.reasoningEffort ? ` · reasoning: ${targetPreset.reasoningEffort}` : "";
		const routeText =
			targetPreset.provider !== undefined && targetPreset.model !== undefined
				? `${targetPreset.provider}/${targetPreset.model}`
				: "current model";
		ctx.logger?.info?.(
			`dsh-set-model: [Jev] auto-switched session ${session.id} to preset "${targetPreset.id}" (${routeText}${effortText}) with confidence ${decision.confidence.toFixed(2)}`
		);

		return true;
	} catch (error) {
		if (controller.signal.aborted) {
			return false;
		}
		ctx.logger?.warn?.(
			`dsh-set-model: Jev model inference failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`
		);
		return false;
	} finally {
		clearTimeout(timeoutId);
		manager.cleanupInFlight(session.id, gen);
	}
}
