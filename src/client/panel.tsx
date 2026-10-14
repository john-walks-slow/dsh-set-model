/**
 * The "动态模型" settings page for dsh-set-model.
 *
 * Reads the `set-model` settings namespace (describe), edits the model policy in
 * local state, and commits it through the settings RPC `mutate` — the host
 * re-applies the plugin on every settings change, so edits take effect live.
 *
 * Provider, model and reasoning-effort fields are pickers fed by the browser
 * model catalog (`session/modelCatalog`), with the stored value kept as a
 * fallback option so a currently-unavailable route is never silently dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

/** Settings namespace of this plugin = its profile loader entry id. */
const NS = "set-model";

const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.7;

/** Reasoning depths DSH adapters understand, offered when no model is pinned to read capabilities from. */
const REASONING_EFFORT_IDS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface CatalogModel {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly reasoning?: {
		readonly efforts?: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
	};
}

export interface CatalogGroup {
	readonly id: string;
	readonly name: string;
	readonly models: readonly CatalogModel[];
}

export interface ModelCatalogValue {
	readonly groups: readonly CatalogGroup[];
	readonly failures: ReadonlyArray<{ readonly id: string; readonly name: string; readonly message: string }>;
}

export interface ModelPolicyRemote {
	settings: {
		describe(): Promise<{
			ok: boolean;
			error?: { message: string };
			value?: { namespaces: Array<Record<string, unknown>> };
		}>;
		mutate(
			ns: string,
			ops: Array<{ op: "set" | "unset"; path: string[]; value?: unknown }>,
			expectedRevision?: number
		): Promise<{ ok: boolean; error?: { message: string }; value?: { revision?: number } }>;
	};
	session?: {
		modelCatalog(): Promise<{ ok: boolean; error?: { message: string }; value?: ModelCatalogValue }>;
	};
}

export interface ModelPolicyPanelProps {
	close?: () => void;
	/** Remote RPC, injected from the client ctx. Absent on hosts without it. */
	remote?: ModelPolicyRemote;
}

interface PresetRow {
	id: string;
	name: string;
	when: string;
	provider: string;
	model: string;
	reasoningEffort: string;
}

export interface FormState {
	presets: PresetRow[];
	policyPrompt: string;
	planPreset: string;
	planModel: PresetRow;
	autoRestorePlanModel: boolean;
	enableModelTools: boolean;
	enablePresetTools: boolean;
	allowedProviders: string;
	jevEnabled: boolean;
	jevApiKey: string;
	jevBaseUrl: string;
	jevModel: string;
	jevConfidenceThreshold: number;
}

function emptyRow(): PresetRow {
	return { id: "", name: "", when: "", provider: "", model: "", reasoningEffort: "" };
}

function emptyForm(): FormState {
	return {
		presets: [],
		policyPrompt: "",
		planPreset: "",
		planModel: { ...emptyRow(), provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
		autoRestorePlanModel: true,
		enableModelTools: true,
		enablePresetTools: false,
		allowedProviders: "",
		jevEnabled: false,
		jevApiKey: "",
		jevBaseUrl: "",
		jevModel: "",
		jevConfidenceThreshold: DEFAULT_JEV_CONFIDENCE_THRESHOLD
	};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function readRow(raw: unknown): PresetRow {
	const row = (raw ?? {}) as Record<string, unknown>;
	return {
		id: text(row.id),
		name: text(row.name),
		when: text(row.when),
		provider: text(row.provider),
		model: text(row.model),
		reasoningEffort: text(row.reasoningEffort)
	};
}

/** Resolve the section from the namespace's resolved value, falling back to the composition base. */
export function readForm(source: Record<string, unknown> | undefined): FormState {
	const section = (source?.["value"] ?? source?.["base"] ?? {}) as Record<string, unknown>;
	return {
		presets: Array.isArray(section.presets) ? section.presets.map(readRow) : [],
		policyPrompt: text(section.policyPrompt),
		planPreset: text(section.planPreset),
		planModel: readRow(section.planModel),
		autoRestorePlanModel: section.autoRestorePlanModel !== false,
		enableModelTools: section.enableModelTools !== false,
		enablePresetTools: section.enablePresetTools === true,
		allowedProviders: Array.isArray(section.allowedProviders) ? section.allowedProviders.join(", ") : "",
		jevEnabled: section.jevEnabled === true,
		jevApiKey: text(section.jevApiKey),
		jevBaseUrl: text(section.jevBaseUrl),
		jevModel: text(section.jevModel),
		jevConfidenceThreshold:
			typeof section.jevConfidenceThreshold === "number" && Number.isFinite(section.jevConfidenceThreshold)
				? section.jevConfidenceThreshold
				: DEFAULT_JEV_CONFIDENCE_THRESHOLD
	};
}

/** Validation the host would otherwise only report as a load-time log line. */
function validate(state: FormState): string | undefined {
	if (
		typeof state.jevConfidenceThreshold !== "number" ||
		!Number.isFinite(state.jevConfidenceThreshold) ||
		state.jevConfidenceThreshold < 0 ||
		state.jevConfidenceThreshold > 1
	) {
		return "Jev 置信度阈值必须介于 0.0 与 1.0 之间。";
	}
	const planProvider = state.planModel.provider.trim();
	const planModelId = state.planModel.model.trim();
	if ((planProvider === "") !== (planModelId === "")) {
		return "Plan 目标需要同时填写 provider 与 model，或两者都留空。";
	}
	if (planProvider === "" && state.planModel.reasoningEffort !== "") {
		return "Plan 目标只填了思考强度——请补上 provider 与 model，或清空。";
	}
	if (state.presets.length === 0) return "至少需要一条档位。";
	const ids = new Set<string>();
	for (const [index, row] of state.presets.entries()) {
		const id = row.id.trim();
		if (id === "") return `第 ${index + 1} 条档位缺少 id。`;
		if (ids.has(id)) return `档位 id "${id}" 重复。`;
		if ((row.provider.trim() === "") !== (row.model.trim() === "")) {
			return `档位 "${id}" 的 provider 与 model 需要同时填写，或同时留空（留空 = 沿用当前模型）。`;
		}
		ids.add(id);
	}
	if (state.planPreset.trim() !== "" && !ids.has(state.planPreset.trim())) {
		return `Plan 档位 "${state.planPreset}" 不在档位表中。`;
	}
	return undefined;
}

function rowValue(row: PresetRow): Record<string, unknown> {
	const id = row.id.trim();
	return {
		id,
		...(row.name.trim() !== "" ? { name: row.name.trim() } : {}),
		...(row.when.trim() !== "" ? { when: row.when.trim() } : {}),
		provider: row.provider.trim(),
		model: row.model.trim(),
		...(row.reasoningEffort !== "" ? { reasoningEffort: row.reasoningEffort } : {})
	};
}

export function buildOps(state: FormState): Array<{ op: "set" | "unset"; path: string[]; value?: unknown }> {
	// 已废弃的 mode / enableAgentTools 不再写入新 Config，宿主的 settings.write() 会拒绝
	// 「不在 schema 中」的路径；保留它们在 profile 里无害，schemastery 会把多余字段丢掉。
	const ops: Array<{ op: "set" | "unset"; path: string[]; value?: unknown }> = [
		{ op: "set", path: ["presets"], value: state.presets.map(rowValue) },
		{ op: "set", path: ["policyPrompt"], value: state.policyPrompt.trim() },
		{ op: "set", path: ["autoRestorePlanModel"], value: state.autoRestorePlanModel },
		{ op: "set", path: ["enableModelTools"], value: state.enableModelTools },
		{ op: "set", path: ["enablePresetTools"], value: state.enablePresetTools },
		{
			op: "set",
			path: ["allowedProviders"],
			value: state.allowedProviders
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry !== "")
		},
		{ op: "set", path: ["jevEnabled"], value: state.jevEnabled },
		{ op: "set", path: ["jevApiKey"], value: state.jevApiKey.trim() },
		{ op: "set", path: ["jevBaseUrl"], value: state.jevBaseUrl.trim() },
		{ op: "set", path: ["jevModel"], value: state.jevModel.trim() },
		{ op: "set", path: ["jevConfidenceThreshold"], value: state.jevConfidenceThreshold }
	];

	const planPreset = state.planPreset.trim();
	ops.push(planPreset === "" ? { op: "unset", path: ["planPreset"] } : { op: "set", path: ["planPreset"], value: planPreset });

	const planModel = rowValue(state.planModel);
	if (planModel.provider === "" && planModel.model === "") {
		ops.push({ op: "unset", path: ["planModel"] });
	} else {
		ops.push({
			op: "set",
			path: ["planModel"],
			value: {
				provider: planModel.provider,
				model: planModel.model,
				...(planModel.reasoningEffort ? { reasoningEffort: planModel.reasoningEffort } : {})
			}
		});
	}
	return ops;
}

const rowStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
	gap: "8px",
	alignItems: "center"
};
const cardStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "8px",
	padding: "10px",
	border: "1px solid rgba(128,128,128,.3)",
	borderRadius: "8px"
};
const fieldStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "3px",
	fontSize: "11px",
	opacity: 0.9
};
const inputStyle: CSSProperties = {
	padding: "4px 8px",
	borderRadius: "6px",
	border: "1px solid rgba(128,128,128,.4)",
	background: "transparent",
	color: "inherit",
	fontSize: "12px",
	width: "100%",
	boxSizing: "border-box"
};
const buttonStyle: CSSProperties = {
	padding: "4px 12px",
	borderRadius: "6px",
	border: "1px solid rgba(128,128,128,.4)",
	background: "transparent",
	color: "inherit",
	cursor: "pointer",
	fontSize: "12px",
	whiteSpace: "nowrap"
};

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
	return (
		<label style={fieldStyle}>
			<span style={{ opacity: 0.7 }}>{label}</span>
			{children}
		</label>
	);
}

export function ModelPolicyPanel({ remote }: ModelPolicyPanelProps): ReactElement {
	const [state, setState] = useState<FormState>(emptyForm);
	/** Namespace revision the loaded form was read at; fences each write. */
	const revision = useRef<number | undefined>(undefined);
	const [catalog, setCatalog] = useState<ModelCatalogValue | undefined>(undefined);
	const [loaded, setLoaded] = useState(false);
	const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | undefined>(undefined);
	const [testingJev, setTestingJev] = useState(false);
	const [jevTestResult, setJevTestResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
	/** Timer of the transient success note; a stale one must not clear a newer note. */
	const messageTimer = useRef<number | undefined>(undefined);

	const flashSuccess = useCallback((text: string) => {
		if (messageTimer.current !== undefined) window.clearTimeout(messageTimer.current);
		setMessage({ kind: "ok", text });
		messageTimer.current = window.setTimeout(() => {
			messageTimer.current = undefined;
			setMessage(undefined);
		}, 2500);
	}, []);

	useEffect(
		() => () => {
			if (messageTimer.current !== undefined) window.clearTimeout(messageTimer.current);
		},
		[]
	);

	useEffect(() => {
		if (remote === undefined) {
			setMessage({ kind: "err", text: "设置服务不可用。" });
			setLoaded(true);
			return;
		}
		remote.settings
			.describe()
			.then((res) => {
				if (!res.ok || res.value === undefined) {
					setMessage({ kind: "err", text: res.error?.message ?? "读取设置失败。" });
					setLoaded(true);
					return;
				}
				const source = res.value.namespaces.find((row) => row["ns"] === NS);
				if (source === undefined) {
					const available = res.value.namespaces.map((row) => String(row["ns"])).join(", ") || "(none)";
					setMessage({ kind: "err", text: `未找到设置命名空间 "${NS}"。可用：${available}` });
					setLoaded(true);
					return;
				}
				revision.current = typeof source["revision"] === "number" ? source["revision"] : undefined;
				setState(readForm(source));
				setLoaded(true);
			})
			.catch((error: unknown) => {
				setMessage({ kind: "err", text: error instanceof Error ? error.message : String(error) });
				setLoaded(true);
			});

		void Promise.resolve()
			.then(() => remote.session?.modelCatalog())
			.then((res) => {
				if (res?.ok && res.value !== undefined) setCatalog(res.value);
			})
			.catch(() => {
				// Picker data is a convenience; the stored route stays selectable as-is.
			});
	}, [remote]);

	const patch = useCallback((changes: Partial<FormState>) => {
		setState((prev) => ({ ...prev, ...changes }));
		setMessage(undefined);
	}, []);

	const updatePreset = useCallback((index: number, changes: Partial<PresetRow>) => {
		setState((prev) => ({
			...prev,
			presets: prev.presets.map((row, i) => (i === index ? { ...row, ...changes } : row))
		}));
		setMessage(undefined);
	}, []);

	const providers = useMemo(() => catalog?.groups ?? [], [catalog]);

	const modelsFor = useCallback(
		(provider: string): readonly CatalogModel[] => providers.find((group) => group.id === provider)?.models ?? [],
		[providers]
	);

	const effortsFor = useCallback(
		(provider: string, model: string): ReadonlyArray<{ readonly id: string }> => {
			// 未绑定模型时没有能力目录可查，交出完整档位列表由用户自行选择。
			if (provider === "" || model === "") return REASONING_EFFORT_IDS.map((id) => ({ id }));
			const entry = modelsFor(provider).find((candidate) => candidate.id === model);
			return entry?.reasoning?.efforts ?? [];
		},
		[modelsFor]
	);

	const renderRoute = (row: PresetRow, onChange: (changes: Partial<PresetRow>) => void): ReactElement => {
		const models = modelsFor(row.provider);
		const efforts = effortsFor(row.provider, row.model);
		const followsActiveModel = row.provider.trim() === "";
		return (
			<>
				<Field label="Provider">
					<select
						style={inputStyle}
						value={row.provider}
						onChange={(event) => onChange({ provider: event.target.value, model: "", reasoningEffort: "" })}
					>
						<option value="">沿用当前模型</option>
						{providers.map((group) => (
							<option key={group.id} value={group.id}>
								{group.name}（{group.id}）
							</option>
						))}
						{row.provider !== "" && !providers.some((group) => group.id === row.provider) && (
							<option value={row.provider}>{row.provider}（当前不可用）</option>
						)}
					</select>
				</Field>
				<Field label="Model">
					<select
						style={inputStyle}
						value={row.model}
						disabled={followsActiveModel}
						onChange={(event) => onChange({ model: event.target.value, reasoningEffort: "" })}
					>
						<option value="">{followsActiveModel ? "沿用当前模型" : "— 选择 —"}</option>
						{models.map((model) => (
							<option key={model.id} value={model.id}>
								{model.name}（{model.id}）
							</option>
						))}
						{row.model !== "" && !models.some((model) => model.id === row.model) && (
							<option value={row.model}>{row.model}（当前不可用）</option>
						)}
					</select>
				</Field>
				<Field label="思考强度">
					<select
						style={inputStyle}
						value={row.reasoningEffort}
						onChange={(event) => onChange({ reasoningEffort: event.target.value })}
					>
						<option value="">跟随模型默认</option>
						{efforts.map((effort) => (
							<option key={effort.id} value={effort.id}>
								{effort.id}
							</option>
						))}
						{row.reasoningEffort !== "" && !efforts.some((effort) => effort.id === row.reasoningEffort) && (
							<option value={row.reasoningEffort}>{row.reasoningEffort}</option>
						)}
					</select>
				</Field>
			</>
		);
	};

	const testJevConnection = useCallback(async () => {
		setTestingJev(true);
		setJevTestResult(null);
		try {
			const response = await fetch("api/dsh-set-model/jev-probe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					baseUrl: state.jevBaseUrl.trim() || undefined,
					model: state.jevModel.trim() || undefined
				})
			});
			const result = (await response.json().catch(() => null)) as {
				ok?: boolean;
				message?: string;
			} | null;
			if (result?.ok) {
				setJevTestResult({ kind: "ok", text: `正常 · ${result.message ?? ""}`.trim() });
			} else {
				setJevTestResult({ kind: "err", text: result?.message ?? `HTTP ${response.status}` });
			}
		} catch (error) {
			setJevTestResult({
				kind: "err",
				text: `测速失败：${error instanceof Error ? error.message : String(error)}`
			});
		} finally {
			setTestingJev(false);
		}
	}, [state.jevBaseUrl, state.jevModel]);

	const save = useCallback(async () => {
		if (remote === undefined) return;
		const problem = validate(state);
		if (problem !== undefined) {
			setMessage({ kind: "err", text: problem });
			return;
		}
		try {
			const res = await remote.settings.mutate(NS, buildOps(state), revision.current);
			if (!res.ok) {
				setMessage({ kind: "err", text: res.error?.message ?? "保存失败。" });
				return;
			}
			// The write bumped the revision; keep it so the next save is not
			// refused as stale.
			if (typeof res.value?.revision === "number") revision.current = res.value.revision;
			flashSuccess("已保存并热生效。");
		} catch (error: unknown) {
			setMessage({ kind: "err", text: error instanceof Error ? error.message : String(error) });
		}
	}, [remote, state, flashSuccess]);

	if (!loaded && message === undefined) {
		return <div style={{ padding: "12px 0", fontSize: "13px", opacity: 0.7 }}>加载模型策略…</div>;
	}

	const failures = catalog?.failures ?? [];

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "14px", maxWidth: "860px" }}>
			<div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
				<div style={{ fontSize: "12px", opacity: 0.75 }}>
					模型档位（档位工具与 Jev 自动决策时生效）{failures.length > 0 ? ` · ${failures.length} 个 provider 目录加载失败` : ""}
				</div>
				{state.presets.length === 0 ? (
					<div style={{ fontSize: "13px", opacity: 0.6 }}>暂无档位——至少需要一条。</div>
				) : (
					state.presets.map((row, index) => (
						<div key={index} style={cardStyle}>
							<div style={rowStyle}>
								<Field label="档位 id（Agent 用它切换）">
									<input
										style={inputStyle}
										value={row.id}
										placeholder="daily"
										onChange={(event) => updatePreset(index, { id: event.target.value })}
									/>
								</Field>
								<Field label="显示名">
									<input
										style={inputStyle}
										value={row.name}
										placeholder="日常执行"
										onChange={(event) => updatePreset(index, { name: event.target.value })}
									/>
								</Field>
								<Field label="适用阶段（写进策略清单，Jev 也据此判定）">
									<input
										style={inputStyle}
										value={row.when}
										placeholder="常规实现、修改、测试"
										onChange={(event) => updatePreset(index, { when: event.target.value })}
									/>
								</Field>
							</div>
							<div style={rowStyle}>
								{renderRoute(row, (changes) => updatePreset(index, changes))}
							</div>
							<div style={{ display: "flex", gap: "8px" }}>
								<button
									style={buttonStyle}
									title="上移"
									disabled={index === 0}
									onClick={() =>
										setState((prev) => {
											const presets = [...prev.presets];
											[presets[index - 1], presets[index]] = [presets[index], presets[index - 1]];
											return { ...prev, presets };
										})
									}
								>
									↑
								</button>
								<button
									style={buttonStyle}
									title="下移"
									disabled={index === state.presets.length - 1}
									onClick={() =>
										setState((prev) => {
											const presets = [...prev.presets];
											[presets[index + 1], presets[index]] = [presets[index], presets[index + 1]];
											return { ...prev, presets };
										})
									}
								>
									↓
								</button>
								<button
									style={{ ...buttonStyle, marginLeft: "auto" }}
									title="删除档位"
									onClick={() =>
										setState((prev) => ({ ...prev, presets: prev.presets.filter((_, i) => i !== index) }))
									}
								>
									✕ 删除
								</button>
							</div>
						</div>
					))
				)}
				<div>
					<button
						style={buttonStyle}
						onClick={() => setState((prev) => ({ ...prev, presets: [...prev.presets, emptyRow()] }))}
					>
						+ 添加档位
					</button>
				</div>
			</div>

			<Field label="策略提示词（告诉 Agent 与 Jev 各阶段该用哪个模型/档位）">
				<textarea
					style={{ ...inputStyle, minHeight: "72px", fontFamily: "inherit", resize: "vertical" }}
					value={state.policyPrompt}
					placeholder="例如：规划与架构设计一律先切 deep；日常实现、改文件、跑测试用 daily。"
					onChange={(event) => patch({ policyPrompt: event.target.value })}
				/>
				<span style={{ opacity: 0.7, lineHeight: 1.5 }}>
					有调模工具时写进 Agent 的系统提示词；开启 Jev 自动切档位时随决策请求一并发送。
				</span>
			</Field>

			<div style={cardStyle}>
				<div style={{ fontSize: "12px", opacity: 0.75 }}>Agent 调模能力</div>
				<div style={{ fontSize: "13px", opacity: 0.85, lineHeight: 1.6 }}>
					两个工具开关彼此独立：自由调模工具让 Agent 用 <code>set_model</code> 切换到任意模型；档位工具让它在声明的档位之间切换（<code>switch_preset</code>）。
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
					<label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
						<input
							type="checkbox"
							checked={state.enableModelTools}
							onChange={(event) => patch({ enableModelTools: event.target.checked })}
						/>
						注入自由调模工具（set_model / list_models）
					</label>
					<label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
						<input
							type="checkbox"
							checked={state.enablePresetTools}
							onChange={(event) => patch({ enablePresetTools: event.target.checked })}
						/>
						注入档位工具（switch_preset / list_presets）
					</label>
				</div>
				<Field label="Provider 白名单（逗号分隔，留空 = 不限制）">
					<input
						style={inputStyle}
						value={state.allowedProviders}
						placeholder="deepseek, anthropic"
						onChange={(event) => patch({ allowedProviders: event.target.value })}
					/>
				</Field>
			</div>

			<div style={cardStyle}>
				<div style={{ fontSize: "12px", opacity: 0.75 }}>Plan 模式自动切换</div>
				<div style={rowStyle}>
					<Field label="进入 Plan 模式使用哪个档位（优先）">
							<select
								style={inputStyle}
								value={state.planPreset}
								onChange={(event) => patch({ planPreset: event.target.value })}
							>
								<option value="">不自动切换</option>
								{state.presets
									.filter((row) => row.id.trim() !== "")
									.map((row) => (
										<option key={row.id} value={row.id}>
											{row.name.trim() !== "" ? `${row.id}（${row.name}）` : row.id}
										</option>
									))}
							</select>
						</Field>
					</div>
				<div style={rowStyle}>
					<Field label="进入 Plan 模式使用的模型">
							<input
								style={inputStyle}
								value={state.planModel.provider}
								placeholder="deepseek"
								onChange={(event) => patch({ planModel: { ...state.planModel, provider: event.target.value } })}
							/>
						</Field>
						<Field label="Model">
							<input
								style={inputStyle}
								value={state.planModel.model}
								placeholder="deepseek-reasoner"
								onChange={(event) => patch({ planModel: { ...state.planModel, model: event.target.value } })}
							/>
						</Field>
						<Field label="思考强度">
							<select
								style={inputStyle}
								value={state.planModel.reasoningEffort}
								onChange={(event) =>
									patch({ planModel: { ...state.planModel, reasoningEffort: event.target.value } })
								}
							>
								<option value="">跟随模型默认</option>
								{REASONING_EFFORT_IDS.map((effort) => (
									<option key={effort} value={effort}>
										{effort}
									</option>
								))}
							</select>
						</Field>
				</div>
				<label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" }}>
					<input
						type="checkbox"
						checked={state.autoRestorePlanModel}
						onChange={(event) => patch({ autoRestorePlanModel: event.target.checked })}
					/>
					退出 Plan 模式时自动恢复进入前的模型
				</label>
			</div>

			<div style={cardStyle}>
				<label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "13px" }}>
					<input
						type="checkbox"
						checked={state.jevEnabled}
						onChange={(event) => patch({ jevEnabled: event.target.checked })}
					/>
					Jev 自动切档位
				</label>
				<div style={{ fontSize: "11px", opacity: 0.7, lineHeight: 1.5 }}>
					在每轮开始时调用 TypeSafe Jev 决策模型（毫秒级响应、极低成本），根据用户最新指令自动选择最佳档位；
					不依赖上面两个工具开关。
				</div>
				{state.jevEnabled && (
					<div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>
						<div style={rowStyle}>
							<Field label="Jev API Key（留空则读取环境变量 JEV_API_KEY）">
								<input
									type="password"
									style={inputStyle}
									value={state.jevApiKey}
									placeholder="填入 Jev API Key..."
									onChange={(event) => patch({ jevApiKey: event.target.value })}
								/>
							</Field>
							<Field label="置信度阈值（0.0 ~ 1.0，默认 0.7）">
								<input
									type="number"
									step="0.05"
									min="0"
									max="1"
									style={inputStyle}
									value={state.jevConfidenceThreshold}
									onChange={(event) => {
										const val = Number.parseFloat(event.target.value);
										patch({ jevConfidenceThreshold: Number.isNaN(val) ? 0.7 : val });
									}}
								/>
							</Field>
						</div>
						<div style={rowStyle}>
							<Field label="Jev Base URL（留空则使用 JEV_BASE_URL 或默认官方端点）">
								<input
									style={inputStyle}
									value={state.jevBaseUrl}
									placeholder="https://openrouter.ai/api/alpha/decisions"
									onChange={(event) => patch({ jevBaseUrl: event.target.value })}
								/>
							</Field>
							<Field label="Jev 模型名称（留空则使用 JEV_MODEL 或 typesafe/jev-1.13）">
								<input
									style={inputStyle}
									value={state.jevModel}
									placeholder="typesafe/jev-1.13"
									onChange={(event) => patch({ jevModel: event.target.value })}
								/>
							</Field>
						</div>
						<div style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "4px" }}>
							<button
								type="button"
								style={buttonStyle}
								disabled={testingJev}
								onClick={() => void testJevConnection()}
							>
								{testingJev ? "测速中…" : "测速"}
							</button>
							{jevTestResult !== null && (
								<span
									style={{
										fontSize: "12px",
										color: jevTestResult.kind === "ok" ? "#4caf7d" : "#e06666"
									}}
								>
									{jevTestResult.text}
								</span>
							)}
						</div>
					</div>
				)}
			</div>

			<div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
				<button style={buttonStyle} onClick={() => void save()}>
					保存并生效
				</button>
				{message !== undefined && (
					<span style={{ fontSize: "12px", color: message.kind === "ok" ? "#4caf7d" : "#e06666" }}>
						{message.text}
					</span>
				)}
			</div>
		</div>
	);
}
