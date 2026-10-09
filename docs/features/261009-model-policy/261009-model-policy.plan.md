# 实施计划：模型策略（Model Policy）——阶段提示词 + 档位模式

> 分支 `feat/model-policy` · worktree `.worktrees/model-policy` · 基线 dsh 0.2.0-rc.2

## 1. 目标与范围

在 dsh-set-model 上引入**模型策略**：把"不同阶段用什么模型"从只存在于用户脑子里的隐性约定，变成插件可声明、可注入模型、可被 Agent 遵守的显式策略。

两项能力：

| # | 能力 | 形态 |
|---|---|---|
| 1 | 阶段策略提示词 | 配置中的自由文本 + preset 模式下自动生成的档位清单，注册为系统提示词段落 |
| 2 | 档位模式（preset mode） | 配置声明一组「模型 + 思考强度」档位；该模式下 Agent 只能换档位，不能任意指定 provider/model |

**不做**（本次范围外）：

- 不拦截用户在 GUI 的切模（平台无 hook，见调研 §3.2）；preset 模式约束的是 Agent，不是人。
- 不替代 DSH 的 Agent 预设（`agent-preset`，那是 composition 级的会话预设）；本插件的档位是**模型层**的轻量概念，文档中统一称「模型档位」以免混淆。
- 不做档位的会话级初始应用（`defaultPreset`）：会话起始模型仍由 DSH 默认模型配置决定，Agent 按策略自行换档。若后续确需，再单独加。

## 2. 用户体验设计

### 2.1 配置者路径（部署一次）

1. 打开 Web 设置 →「模型档位」页（插件自带的设置界面）；
2. 选择模式：
   - **自由模式 free**（默认，向后兼容）：Agent 可用 `set_model` 任意切 provider/model/思考强度；
   - **档位模式 preset**：Agent 只能在下列档位间切换。
3. 在档位模式下维护档位表：`id` / 名称 / 适用阶段 / provider / model / 思考强度。provider 与 model 用下拉从当前模型目录选，无需手打 ID；
4. 需要时补一段「附加策略说明」（`policyPrompt`），例如"线上事故排查优先 deep"；
5. 保存。改动即时生效（settings 为 live），无需重启 dsh。

### 2.2 Agent 路径（每个会话）

1. 系统提示词中出现「Model policy」段落，列出当前可用档位与各自适用阶段；
2. 任务进入某阶段时，Agent 调 `list_presets` 核对（或直接依提示词）→ `switch_preset({ preset: "deep", reason: "疑难并发排查" })`；
3. 工具返回切换确认，下个 step 生效；
4. 运行时上下文快照尾部始终显示当前模型与当前档位名，Agent 无需调用工具即可自查。

### 2.3 典型工作流（preset 模式）

```
用户：/plan 重构鉴权模块
  → 插件自动切到 planPreset（deep / deepseek-reasoner · max）
Agent：规划…（Plan Mode Active）
用户：批准计划 / 退出 Plan
  → 插件自动恢复到进入 Plan 前的档位
Agent：日常实现阶段，按策略切到 daily / deepseek-chat · low
Agent：遇到疑难并发问题 → switch_preset("deep") → 攻坚 → switch_preset("daily")
```

### 2.4 自由模式（向后兼容）

不配 `presets`、`mode` 缺省即为 free：行为与今天完全一致（`set_model` + `list_models` + `planModel`）。`policyPrompt` 在 free 模式下同样生效，可以只写一段"架构设计用 reasoner、日常用 chat"的散文策略而不启用档位约束。

## 3. 配置 Schema（`src/config.ts`）

```yaml
dsh-set-model:
  mode: preset                 # free（默认）| preset
  presets:                     # 档位表；preset 模式必填且非空
    - id: daily                # 稳定标识，Agent 用它切换
      name: 日常执行            # 展示名，缺省用 id
      when: 常规实现、修改、测试 # 适用阶段，进入系统提示词
      provider: deepseek
      model: deepseek-chat
      reasoningEffort: low
    - id: deep
      name: 深度攻坚
      when: 疑难排查、架构设计、复杂算法
      provider: deepseek
      model: deepseek-reasoner
      reasoningEffort: max
  policyPrompt: |              # 可选：附加策略说明（两种模式都生效）
    线上事故排查一律先切 deep。
  planPreset: deep             # preset 模式：进入 Plan 模式使用的档位 id
  planModel:                   # free 模式：进入 Plan 模式使用的模型（保留）
    provider: deepseek
    model: deepseek-reasoner
    reasoningEffort: high
  autoRestorePlanModel: true
  enableAgentTools: true
  allowedProviders: []         # 可选：provider 白名单，对档位同样生效
```

**平台约束（实施时确认）**：`Config` 的每个可编辑字段都必须标 `.volatile()`，否则该命名空间不会出现在 `SettingsForms.describe()` 里；代价是 volatile 字段以引用对象（`Volatile<T>`，需 `.get()`）交给 `apply()`，且"仅 volatile 变化"的保存由 Loader 原地提交（`loader/volatile-update`）而**不会**重新调用 `apply()`。因此运行时读取一律走实时快照，结构性的工具集变更监听该事件重建。

Schema 与类型：

```ts
export type ReasoningEffort = "off" | "low" | "high" | "max";

export interface ModelPresetConfig {
	id: string;
	name?: string;
	when?: string;
	provider: string;
	model: string;
	reasoningEffort?: ReasoningEffort;
}

export interface SetModelPluginConfig {
	mode?: "free" | "preset";
	presets?: ModelPresetConfig[];
	policyPrompt?: string;
	planPreset?: string;
	planModel?: ModelSelectionConfig;
	autoRestorePlanModel?: boolean;
	enableAgentTools?: boolean;
	allowedProviders?: string[];
}
```

`resolveConfig` 归一化后返回 `ResolvedSetModelConfig`，并额外携带 `problems: string[]`：

| 校验 | 处理 |
|---|---|
| `preset.id` 空 / 重复 | 记入 `problems`，忽略该条 |
| `preset.provider` / `model` 空 | 记入 `problems`，忽略该条 |
| `mode: preset` 但档位表为空 | 记入 `problems` |
| `planPreset` 未命中任何档位 | 记入 `problems` |
| 档位 provider 不在 `allowedProviders`（非空时） | 记入 `problems`，忽略该条 |

`problems` 在插件初始化时逐条 `ctx.logger.error`。**不在加载期抛错**——插件抛错会让整棵 dsh plugin tree 加载失败、全站不可用。运行期由工具给出明确错误（如 `switch_preset` 在无档位时直接报 `No model presets are configured...`），符合"只给错误提示、不做降级"的要求。

## 4. Agent 工具契约（`src/tools.ts`）

按 `mode` 二选一注册，互斥：

| 模式 | 注册的工具 |
|---|---|
| free | `set_model`、`list_models`（现状不变） |
| preset | `switch_preset`、`list_presets` |

preset 模式下**不注册** `set_model` / `list_models`，从工具面即杜绝任意指定 provider/model。

### 4.1 `switch_preset`

```
switch_preset({ preset: string, reason: string }) -> {
  success, preset: { id, name? }, previous: {provider, model, reasoningEffort?},
  current: {provider, model, reasoningEffort?}, message
}
```

- `preset`：档位 id（来自 `list_presets`）；
- `reason`：必填，语义与 `set_model` 一致（切换会使 KV cache 失效，需说明值得切换）；
- 未知 id：抛 `Unknown preset "xxx". Available presets: daily, deep. Call list_presets for details.`；
- 命中后调用 `applyModelSelection`（沿用路由校验 + token 水位护栏 + `model/selection` 事件写入）。

### 4.2 `list_presets`

```
list_presets({}) -> {
  mode, planMode,
  presets: [{ id, name?, when?, provider, model, reasoningEffort?, current: boolean }],
  current: { preset?: string, provider, model, reasoningEffort? }
}
```

`current` 由当前活跃选择反向匹配档位得出（匹配不上则无 `preset`）；`render` 输出人读表格。

### 4.3 档位约束统一入口（`src/presets.ts`，新增）

单一职责模块，供工具与 Plan 联动共用：

```ts
parsePresets(raw): { presets: ModelPreset[]; problems: string[] }
findPreset(presets, id): ModelPreset | undefined
matchPreset(presets, selection): ModelPreset | undefined      // 反向匹配
presetToSelection(preset): TargetModelSelection
renderPresetRoster(presets): string                           // 系统提示词用的清单
```

## 5. 系统提示词与运行时上下文（`src/index.ts`）

### 5.1 静态段落 `dsh:model-policy`（order 550）

插在 `PLAN_POLICY`(500) 与 `TEAM_POLICY`(600) 之间。内容在每次装配时按当前配置生成：

**preset 模式**

```
## Model policy

<policyPrompt，若配置>

本部署只允许在下列模型档位间切换；需要进入某个阶段时调用 switch_preset：

- **daily**（日常执行）— deepseek/deepseek-chat · reasoning low — 适用：常规实现、修改、测试
- **deep**（深度攻坚）— deepseek/deepseek-reasoner · reasoning max — 适用：疑难排查、架构设计、复杂算法
```

**free 模式**

```
## Model policy

<policyPrompt>
```

段落文本为空时由 `renderPrompt` 自动丢弃，因此未配置策略时**不产生任何提示词痕迹**。

段落内容只随配置变化，同一配置下每次装配结果稳定 → 不破坏 prompt cache。**当前档位、当前模型等动态信息一律留在 §5.2 的运行时上下文，不进段落。**

### 5.2 运行时上下文（改造既有 `dsh:active_model_context`）

```
[Current active model: deepseek/deepseek-chat · reasoning: low · preset: daily] [Plan Mode Active]
```

`preset: xx` 仅在命中档位时出现。保持 cache-safe 的尾部快照形态。

## 6. Plan 模式联动

状态机与暂存/恢复逻辑不变，只把"切到哪个目标"的解析分模式：

- `mode: free` → 用 `planModel`（现状）；
- `mode: preset` → 用 `planPreset` 解析为档位，再经 `applyModelSelection`；
- 恢复：退出 Plan 时恢复进入前暂存的**选择**（档位名随匹配自然还原）。

任一失败仍只 `warn`，绝不打断 step（沿用现状）。

## 7. 设置界面（新增 client 半）

### 7.1 Host 侧

- 修正命名空间为 `set-model`（= loader entry id，见调研 §3.3），删除已失效的 `settings.installSection` 调用；
- 在 `ctx.inject(["settings"], ...)` 内调用 `settings.configure({ auto: false }, ctx.fiber)`（与官方插件一致地声明本实例的页面策略；owner 必须是 entry fiber），并把调用包进 `effect`。

### 7.2 Client 侧

- 新增 `src/client/index.ts`：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "model-policy", order: 130, label: () => "模型档位", inject }, Panel))`（先 `inject` 再 `register`，避免与设置壳声明竞态）；
- 新增 `src/client/panel.tsx`：「模型档位」页，结构：
  - 模式切换：自由模式 / 档位模式（单选）；
  - 档位表编辑器：行 = 一条档位，字段 `id`（文本，校验唯一/非空）、`name`、`when`、`provider`（下拉）、`model`（下拉，随 provider 过滤）、`reasoningEffort`（下拉，随模型能力过滤）；支持新增/删除/上移下移；
  - `policyPrompt`（多行文本）；
  - Plan 目标：档位模式下拉选 `planPreset`；自由模式填 `planModel` 三字段；
  - 开关：`autoRestorePlanModel`、`enableAgentTools`；
  - 底部保存按钮 + 校验提示（provider/model 必填、id 非空唯一）。
- 数据面：读 `remote.settings.describe()` 取 `set-model` 命名空间；下拉数据来自 `remote.session.modelCatalog()`（无需 session，返回 provider 分组 + 模型 + reasoning 元数据）；
- 写回：`remote.settings.mutate("set-model", ops, revision)`，数组整体 `{ op: "set", path: ["presets"], value: rows }`，标量按字段逐个 set（沿用 `dsh-command-guard` 的本地先例）。

### 7.3 构建

- `scripts/build-client.mjs`：esbuild 打包 `src/client/index.ts` → lazy-CJS 包装 `window.__ModuleLoader__.load({ id: "dsh-set-model", factory })`（`id` 必须等于包名，否则 combo bundle 二次执行报 duplicate factory）；产物 `lib/client.js`；
- `package.json`：新增 `exports["./client"] = "./lib/client.js"`、`files` 加 `lib`、`dsh.client = { inject: [...], platform: "web" }`、`scripts.build` 追加客户端的构建、devDependencies 加 `esbuild` 与客户端类型包；
- 构建后**必须** `node --check lib/client.js`；e2e 再用无头浏览器确认 console 无 `Unexpected token` / `loaded without registering`。

## 8. 架构与文件结构

```
src/
  config.ts      # + mode / presets / policyPrompt / planPreset，problems 诊断
  presets.ts     # 新增：档位解析、匹配、反向匹配、清单渲染
  controller.ts  # 保持；applyModelSelection 复用
  tools.ts       # 按模式注册 2+2 个工具
  index.ts       # 策略段落注册、模式分支、Plan 联动、settings.configure
  client/
    index.ts     # settings.section 注册
    panel.tsx    # 档位编辑页
scripts/
  build-client.mjs
```

## 9. 实现步骤

1. **基线对齐**：等主工作区未提交的 0.2.0-rc.2 依赖升级落库后，把 `feat/model-policy` 变基上去；若用户授权，则在 worktree 内自行完成同样的升级（`@deepseek-ai/*` → peerDependencies + devDependencies `^0.2.0-rc.2`）。
2. `src/config.ts`：扩展 Schema 与 `resolveConfig`（含 `problems`）。
3. `src/presets.ts`：档位模块 + 单测。
4. `src/tools.ts`：`switch_preset` / `list_presets`，按 `enableAgentTools` + `mode` 分支注册。
5. `src/index.ts`：`dsh:model-policy` 段落、上下文行加档位、Plan 联动分模式、修正 settings 命名空间与 `configure({auto:false})`。
6. client 半：构建脚本 + `settings.section` 页；`package.json` 客户端声明。
7. 单测：档位解析/校验/匹配、`switch_preset` 未知 id 报错、模式分支只注册对应工具、策略段落渲染（含 free 模式空文本不产生段落）。
8. e2e：`dsh-e2e start --wait-ready && dsh-e2e run`，验证无头浏览器加载设置页 + 一次真实 `switch_preset` 调模。
9. 文档：README 补齐 `mode` / `presets` / `policyPrompt` / `planPreset` 的可复制示例与"约束的是 Agent 不是人"的边界说明；同步 `AGENTS.md` 地图。

## 10. 测试与验收

**单测（`npm test`）**

- [ ] free 模式：工具集与今天一致；`policyPrompt` 生效；无档位概念痕迹；
- [ ] preset 模式：只注册 `switch_preset` / `list_presets`；`switch_preset` 命中档位后写入 `model/selection`；
- [ ] `switch_preset` 未知 id 报错文案包含可用档位；
- [ ] 档位校验：重复 id / 空 provider / 空档位表 / 无效 `planPreset` 均进 `problems`；
- [ ] `allowedProviders` 对档位生效；
- [ ] 策略段落：preset 模式含档位清单，free 模式仅含用户文本，未配置时为空；
- [ ] 上下文行在命中档位时出现 `preset: xx`；
- [ ] Plan 联动：preset 模式走 `planPreset` 并正确恢复。

**e2e**

- [ ] `dsh-e2e start --wait-ready && dsh-e2e run` 通过；
- [ ] 无头浏览器加载 Web：console 无 `Unexpected token`、无 `loaded without registering`；
- [ ] 设置页可读 `set-model` 命名空间、可保存档位表（写后 `describe` 复读到新值）；
- [ ] 一次真实会话中 Agent 调用 `switch_preset` 成功且下一 step 生效。

**人工验收（用户）**

- [ ] 在 Web 设置页配两条档位 → 开启 preset 模式 → Agent 能按策略换档；
- [ ] 用户在 GUI 切模仍可用（预期行为，非缺陷）。

## 11. 验收标准

- [ ] `npm run check` 通过；
- [ ] `npm test` 全绿；
- [ ] `npm run build` 产出 `dist/src/**` 与 `lib/client.js`，且 `node --check lib/client.js` 通过；
- [ ] `package.json` 显式声明全部 `@deepseek-ai/*` 依赖（含客户端类型包）且本地 `node_modules` 可解析；
- [ ] README 覆盖全部新增配置项与模式差异；
- [ ] 未配置任何新项时，插件行为与升级前完全一致（free 模式向后兼容）。
