# 调研报告：模型策略（Model Policy）——阶段提示词 + 档位模式

> 日期：2026-10-09 · 分支 `feat/model-policy` · worktree `.worktrees/model-policy`

## 1. 需求

在 dsh-set-model 上新增两项能力：

1. **附带的系统提示词**：支持在插件配置中设置一段系统提示词，用于向 Agent 声明"不同阶段该用什么模型"。
2. **preset 模式（档位模式）**：该模式下不再允许任意切换模型，只允许在配置声明的一组 preset（模型 + 思考强度组合）之间切换。

已确认的设计前提（用户 2026-10-09 选定）：

| 议题 | 结论 |
|---|---|
| 约束范围 | 仅约束 Agent 工具；用户 GUI 切模不受限（见 §3.2，平台无 hook） |
| 提示词来源 | 由 preset 元数据自动生成档位清单 + 可选的用户自定义附加文本 |
| preset 定义位置 | 插件配置中的数组，并且**需要插件自带的设置界面**来编辑 |

## 2. 现状：dsh-set-model

### 2.1 已有能力

- `set_model` / `list_models` 两个自主调模工具（仅根 Agent）；
- Plan 模式自动升降级（`agent/pre-step` 监听 `plan` 投影状态变迁，暂存/恢复）；
- 活跃模型经 `systemPrompt.context` 注入运行时上下文快照尾部（cache-safe）；
- `allowedProviders` 白名单 + token 水位护栏 + `ctx.llm.resolveCallConfig` 路由校验。

### 2.2 代码地图

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 配置 Schema 与 `resolveConfig` |
| `src/controller.ts` | `resolveCurrentSelection` / `applyModelSelection` / `listAvailableModels` / `isPlanModeActive` |
| `src/tools.ts` | `set_model` / `list_models` 注册 |
| `src/index.ts` | 插件入口：settings、上下文注入、工具注册、Plan 联动 |
| `test/` | `controller` / `tools` / `plan-switch` 单测（hand-rolled mock context） |

### 2.3 已发现的既有缺陷

1. **settings 集成是死代码**：`src/index.ts` 调用 `ctx.settings.installSection(...)`，但 DSH 0.2.0-rc.2 的 `dsh-settings` **不再提供 `installSection`**（全仓 grep 无此符号）。该调用被 `as any` + 可选链吞掉，静默 no-op。
   - 0.2.0 起，插件的 `Config` Schema 由 `SettingsForms.describe()` 自动发现并生成配置页（`ns = loader entry id`），无需插件主动注册。
2. **`SETTINGS_NAMESPACE = "dsh-set-model"` 与真实命名空间不符**：`dsh-settings` 的 `describe()` 取 `entry.options.id`，本插件在 `cordis.patch.yml` 的行 id 是 `set-model`，故真实命名空间是 `set-model`。
3. **命令式工具参数缺 `list_presets` 类只读入口**：现状下 Agent 只能靠 `list_models` 全量枚举，无法感知"部署允许哪些档位"。

> 以上 1、2 在本次功能中一并修正（设置页要以正确命名空间读写）。

## 3. 平台事实（DSH 0.2.0-rc.2）

### 3.1 系统提示词注册

`ctx.systemPrompt`（`@deepseek-ai/dsh-system-prompt`）提供两类注册：

- `section({ name, order, text })`：**系统提示词**的静态段落。同一 scope 内重名抛错；`text` 为字符串或 `(assembleContext) => string`。
- `context({ name, order, text })`：**运行时上下文快照**，以 user-role 落盘在尾部，cache-safe（现状已用）。

`SECTION_ORDERS` 给出中心化占位：`PLAN_POLICY = 500`、`TEAM_POLICY = 600`。新增策略段落取 550（位于两者之间）不冲突。

静态段落随配置变化才变化，因此在同一配置下每次装配结果稳定，不破坏 prompt cache。**当前档位等动态信息必须留在 `context`，不能进 `section`。**

### 3.2 模型选择链路与可拦截点（关键）

```
GUI /model 弹窗 ─┐
                 ├─→ session/selectModel (RPC, dsh-api-session-controller)
composer 座位 ───┘        │
                          ├─ requireModel() + ctx.llm.resolveCallConfig()
                          └─ agents.selectForNextRequest(agent, selection)
                                 ├─ agent.session.append('model/selection', selection)
                                 └─ selectionFor(agent).current = selection
```

- 真正决定下一步用哪个模型的是 `selectionFor(agent).current`，由 `selectForNextRequest` **命令式**写入；
- 该路径上**没有 waterfall / hook / 投影可介入**（`session-projection` 只能派生只读状态，无法否决选择）；
- 结论：**插件无法 canonical 地拦截用户在 GUI 的切模**。要拦只能监听 `model/selection` 事件后回滚——会在会话日志留下被回滚的事件、属非 canonical 做法。

⇒ preset 模式的约束边界定为 **Agent 工具层**：preset 模式下不注册 `set_model` / `list_models`，只注册档位工具；用户在 GUI 仍可自由切模（作为人工越权/兜底通道）。

插件自身写选择的方式（现状沿用）：`agent.session.append('model/selection', selection)`，与 GUI 同一事件、同一投影链路。

### 3.3 设置命名空间与设置页机制

- 命名空间 = **profile loader entry id**（`dsh-settings/lib/index.js:432` `ns: entry.options.id`）。本插件为 `set-model`。
- 自动页：`SettingsForms.describe()` 扫描所有有 `Config` Schema 的活动 entry，`autoGenerate` 时可自动出页。
- `SettingsForms.configure({ auto })`：插件可声明本实例的页面策略，`auto: false` 可让 UI 不再生成自动配置页（避免与自带设置页重复）。
- 写入 API：`describe()` → 得到 `{ schema, value, base, user, revision }`；`mutate(ns, ops, expectedRevision)` 以路径操作原子写入，天然支持数组（`{op:'set', path:['presets'], value:[...]}`）。

### 3.4 客户端（浏览器半）能力

本机已有成熟先例：`/root/projects/dsh-command-guard`（同为 dsh 0.2.x，作者同一人）。

- `package.json` 增 `dsh.client = { inject: [...], platform: "web" }` 与 `exports["./client"] = "./lib/client.js"`；
- `scripts/build-client.mjs`（esbuild）产出 lazy-CJS 包装 `window.__ModuleLoader__.load({ id: <包名>, factory })`；产物必须 `node --check`；
- 客户端插件以 `ctx.slots.inject("settings.section", () => ctx.slots.register({...}, Panel))` 注册一个设置页，**不能直接 register**（会和设置壳的声明竞态，静默不挂载）；
- Panel 通过 `remote.settings.describe()` 读、`remote.settings.mutate(ns, ops)` 写；`command-guard` 的 `rules` 数组正是"本地 state 编辑 → 整体 set 回 `['rules']`"的同构先例。

浏览器侧可用的模型目录 RPC：`session/modelCatalog()` → `ModelCatalog`（provider 分组 + 模型 + reasoning 元数据），**无需 session 即可调用**，适合做设置页的 provider/model/reasoningEffort 下拉。

## 4. 结论

两项需求均可实现，且与现有架构契合：

1. **阶段提示词**：静态 `systemPrompt.section`（名字 `dsh:model-policy`，order 550）。free 模式内容 = 用户自定义文本；preset 模式 = 自动生成的档位清单 + 用户自定义文本。
2. **preset 模式**：配置声明的档位数组 + `switch_preset` / `list_presets` 工具替换 `set_model` / `list_models`；Plan 联动改走 `planPreset`。
3. **设置界面**：新增 client 半（esbuild 构建 + `settings.section` 注册），用 `session/modelCatalog()` 做下拉、用 `mutate` 写数组；Host 半 `settings.configure({ auto: false })` 抑制自动页。

## 5. 风险与协调事项

1. **依赖版本断代（阻塞级）**：本 worktree 基于 HEAD（`@deepseek-ai/*` 锁 0.1.2-rc.1），但线上运行的是 dsh 0.2.0-rc.2。主工作区存在**未提交**的依赖现代化改动（`@deepseek-ai/*` 移入 peerDependencies、devDependencies 升到 `^0.2.0-rc.2`）与 `agent/created` 串行监听兼容修正。
   → 本功能必须以 0.2.0-rc.2 为基线；需等该改动落库后把 `feat/model-policy` 变基上去（或由用户确认后在 worktree 内自行完成同样的升级）。
2. **client bundle 是新引入的构建面**：插件首次带浏览器半，构建脚本的 wrapper 闭合、`load({ id })` 的 id 必须等于包名（`dsh-set-model`），否则整条 combo bundle 炸掉、Web 端 `Failed to load plugins`。构建后必须 `node --check lib/client.js`，并做无头浏览器验证。
3. **`inject` 数组必须写全**：新增 `settings` 之外还要写 `systemPrompt`（已有）；client 半需要 `slots` / `remote` / `remote.settings`。
4. **档位约束的语义边界**要在 README 写清：preset 模式约束的是 Agent，不是人。

## 6. 参考

- `@deepseek-ai/dsh-system-prompt` `lib/types/index.d.ts`（`PromptSection` / `SECTION_ORDERS`）
- `@deepseek-ai/dsh-api-session-controller` `lib/types/agent.js:349`（`selectForNextRequest`）
- `@deepseek-ai/dsh-settings` `lib/index.js:415-445`（`describe` → `ns = entry.options.id`）、`lib/types/index.d.ts`（`configure` / `mutate`）
- `@deepseek-ai/dsh-client-ui-plugin-manager` `lib/types/client/slot-contract.d.ts`（`plugins.item` 契约）
- `@deepseek-ai/dsh-client-ui-settings` `lib/types/client/contract/slots.d.ts`（`settings.section` 契约）
- `/root/projects/dsh-command-guard`（client 半 + `settings.section` + 数组编辑的本地先例）
