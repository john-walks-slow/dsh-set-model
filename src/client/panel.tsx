/**
 * The "模型档位" settings page for dsh-set-model.
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

interface FormState {
	mode: "free" | "preset";
	presets: PresetRow[];
	policyPrompt: string;
	planPreset: string;
	planModel: PresetRow;
	autoRestorePlanModel: boolean;
	enableAgentTools: boolean;
	allowedProviders: string;
}

function emptyRow(): PresetRow {
	return { id: "", name: "", when: "", provider: "", model: "", reasoningEffort: "" };
}

function emptyForm(): FormState {
	return {
		mode: "free",
		presets: [],
		policyPrompt: "",
		planPreset: "",
		planModel: { ...emptyRow(), provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
		autoRestorePlanModel: true,
		enableAgentTools: true,
		allowedProviders: ""
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
function readForm(source: Record<string, unknown> | undefined): FormState {
	const section = (source?.["value"] ?? source?.["base"] ?? {}) as Record<string, unknown>;
	return {
		mode: section.mode === "preset" ? "preset" : "free",
		presets: Array.isArray(section.presets) ? section.presets.map(readRow) : [],
		policyPrompt: text(section.policyPrompt),
		planPreset: text(section.planPreset),
		planModel: readRow(section.planModel),
		autoRestorePlanModel: section.autoRestorePlanModel !== false,
		enableAgentTools: section.enableAgentTools !== false,
		allowedProviders: Array.isArray(section.allowedProviders) ? section.allowedProviders.join(", ") : ""
	};
}

/** Validation the host would otherwise only report as a load-time log line. */
function validate(state: FormState): string | undefined {
	if (state.mode !== "preset") {
		const hasProvider = state.planModel.provider.trim() !== "";
		const hasModel = state.planModel.model.trim() !== "";
		if (hasProvider !== hasModel) {
			return "自由模式的 Plan 目标需要同时填写 provider 与 model，或两者都留空。";
		}
		if (!hasProvider && state.planModel.reasoningEffort !== "") {
			return "自由模式的 Plan 目标只填了思考强度——请补上 provider 与 model，或清空。";
		}
		return undefined;
	}
	if (state.presets.length === 0) return "档位模式下至少需要一条档位。";
	const ids = new Set<string>();
	for (const [index, row] of state.presets.entries()) {
		const id = row.id.trim();
		if (id === "") return `第 ${index + 1} 条档位缺少 id。`;
		if (ids.has(id)) return `档位 id "${id}" 重复。`;
		if (row.provider.trim() === "" || row.model.trim() === "") return `档位 "${id}" 缺少 provider 或 model。`;
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

function buildOps(state: FormState): Array<{ op: "set" | "unset"; path: string[]; value?: unknown }> {
	const ops: Array<{ op: "set" | "unset"; path: string[]; value?: unknown }> = [
		{ op: "set", path: ["mode"], value: state.mode },
		{ op: "set", path: ["presets"], value: state.presets.map(rowValue) },
		{ op: "set", path: ["policyPrompt"], value: state.policyPrompt.trim() },
		{ op: "set", path: ["autoRestorePlanModel"], value: state.autoRestorePlanModel },
		{ op: "set", path: ["enableAgentTools"], value: state.enableAgentTools },
		{
			op: "set",
			path: ["allowedProviders"],
			value: state.allowedProviders
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry !== "")
		}
	];

	if (state.mode === "preset") {
		const planPreset = state.planPreset.trim();
		ops.push(planPreset === "" ? { op: "unset", path: ["planPreset"] } : { op: "set", path: ["planPreset"], value: planPreset });
	} else {
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
			const entry = modelsFor(provider).find((candidate) => candidate.id === model);
			return entry?.reasoning?.efforts ?? [];
		},
		[modelsFor]
	);

	const renderRoute = (row: PresetRow, onChange: (changes: Partial<PresetRow>) => void): ReactElement => {
		const models = modelsFor(row.provider);
		const efforts = effortsFor(row.provider, row.model);
		return (
			<>
				<Field label="Provider">
					<select
						style={inputStyle}
						value={row.provider}
						onChange={(event) => onChange({ provider: event.target.value, model: "", reasoningEffort: "" })}
					>
						<option value="">— 选择 —</option>
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
						onChange={(event) => onChange({ model: event.target.value, reasoningEffort: "" })}
					>
						<option value="">— 选择 —</option>
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
			<div style={{ fontSize: "13px", opacity: 0.85, lineHeight: 1.6 }}>
				自由模式下 Agent 可用 <code>set_model</code> 切换到任意模型；档位模式下只注册{" "}
				<code>switch_preset</code> / <code>list_presets</code>，Agent 只能在下列档位之间切换。两种模式下
				策略提示词都会写入系统提示词；档位模式下档位清单由插件自动生成。
			</div>

			<div style={{ display: "flex", gap: "14px", fontSize: "13px" }}>
				<label style={{ display: "flex", gap: "4px", alignItems: "center" }}>
					<input
						type="radio"
						checked={state.mode === "free"}
						onChange={() => patch({ mode: "free" })}
					/>
					自由模式
				</label>
				<label style={{ display: "flex", gap: "4px", alignItems: "center" }}>
					<input
						type="radio"
						checked={state.mode === "preset"}
						onChange={() => patch({ mode: "preset" })}
					/>
					档位模式
				</label>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
				<div style={{ fontSize: "12px", opacity: 0.75 }}>
					模型档位（档位模式下生效）{failures.length > 0 ? ` · ${failures.length} 个 provider 目录加载失败` : ""}
				</div>
				{state.presets.length === 0 ? (
					<div style={{ fontSize: "13px", opacity: 0.6 }}>暂无档位——档位模式下至少需要一条。</div>
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
								<Field label="适用阶段（写进策略清单）">
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

			<Field label="策略提示词（system prompt，告诉 Agent 各阶段该用哪个模型/档位）">
				<textarea
					style={{ ...inputStyle, minHeight: "72px", fontFamily: "inherit", resize: "vertical" }}
					value={state.policyPrompt}
					placeholder="例如：规划与架构设计一律先切 deep；日常实现、改文件、跑测试用 daily。"
					onChange={(event) => patch({ policyPrompt: event.target.value })}
				/>
			</Field>

			<div style={cardStyle}>
				<div style={{ fontSize: "12px", opacity: 0.75 }}>Plan 模式自动切换</div>
				{state.mode === "preset" ? (
					<div style={rowStyle}>
						<Field label="进入 Plan 模式使用哪个档位">
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
				) : (
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
								{["off", "low", "high", "max"].map((effort) => (
									<option key={effort} value={effort}>
										{effort}
									</option>
								))}
							</select>
						</Field>
					</div>
				)}
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
				<label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" }}>
					<input
						type="checkbox"
						checked={state.enableAgentTools}
						onChange={(event) => patch({ enableAgentTools: event.target.checked })}
					/>
					向 Agent 注册调模工具
				</label>
				<Field label="Provider 白名单（逗号分隔，留空 = 不限制）">
					<input
						style={inputStyle}
						value={state.allowedProviders}
						placeholder="deepseek, anthropic"
						onChange={(event) => patch({ allowedProviders: event.target.value })}
					/>
				</Field>
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
