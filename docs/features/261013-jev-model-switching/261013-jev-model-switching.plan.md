# 需求计划：dsh-set-model 基于 TypeSafe Jev 的自动模型切换

- **特性分支/标签**：`feat/261013-jev-model-switching`
- **目标目录**：`/root/projects/dsh-set-model`
- **对应版本**：`dsh-set-model` (0.2.1 -> 0.2.2 或当前工作区演进)

---

## 1. 目标与背景

`dsh-set-model` 当前提供了面向 Agent 的调模工具（自由模式下的 `set_model` / `list_models` 与档位模式下的 `switch_preset` / `list_presets`），以及与 Plan 模式联动的自动切模能力。然而，在日常开发交互中，用户通常希望系统能够根据当前所处的任务阶段（如需求规划、架构设计、深度排障、常规实现、测试校验等），**自动、低成本、高可靠地选择最合适的模型档位**，而不需要模型每次耗费数十 token 去思考调用工具换模，也不依赖用户在 Web GUI 中手动切换。

本特性的核心目标：
1. **引入 TypeSafe Jev 决策模型**（基于 Jev Decisions API 协议），实现轻量、毫秒级（~300ms）、极低成本（~$0.000015/次）的自动模型档位决策。
2. **双独立开关架构**：
   - 模型工具开关（`enableAgentTools` / `toolEnabled`）：控制是否向 Agent 注入 `set_model` / `switch_preset` 等调用工具；
   - Jev 自动切模开关（`jevEnabled`）：控制是否在会话执行过程中自动推断并切换模型档位；
   - 两个开关完全解耦，用户可任意组合（仅工具、仅 Jev 自动、两者均开、两者均关）。
3. **基于预设（Presets）的目标映射**：
   - 将用户配置的档位列表（`id`, `name`, `when`）动态映射为 Jev 的 Choice Criteria；
   - 包含保留当前模型（`keep`）的候选，防止无意义的频繁切模；
   - 结合置信度阈值（默认 0.7）与模型变更检测，仅在明确阶段转换时调用 `applyModelSelection`。
4. **工业级鲁棒性与防护设计**：
   - **纯正 Jev 凭据体系（零本机环境绑定）**：配置 `jevApiKey` / `jevBaseUrl` / `jevModel` -> 环境变量 `JEV_API_KEY` / `JEV_BASE_URL` / `JEV_MODEL`；绝对不依赖 OpenRouter 专用 Key 或任何本机私有密码本（如 api-vault），保证任何环境开箱即用；
   - **Generation 竞态淘汰**：单会话请求控制器管理，新请求自动终止并废弃旧请求；
   - **双重提交核验**：提交变更前核验 generation 一致性与实时 `jevEnabled` 开关；
   - **Plan 模式避让保护**：Plan 模式生效期间保持其专属模型/档位锁定，避免 Jev 冲撞覆盖；
   - **超时与降级保底**：设置严格的请求超时，网络故障或超时不会阻塞主会话正常进行；
   - **完整复用核心控制器防线**：Provider 白名单、模型能力（reasoningEffort）自适应、Token 压力与上下文窗口护栏。

---

## 2. 架构设计与关键模块

### 2.1 配置层（`src/config.ts`）
新增以下 Volatile 配置字段：
- `jevEnabled`: `boolean`（默认 `false`）
- `jevApiKey`: `string`（默认 `""`）
- `jevBaseUrl`: `string`（默认 `""`）
- `jevModel`: `string`（默认 `""`，回落 `typesafe/jev-1.13`）
- `jevConfidenceThreshold`: `number`（默认 `0.7`，范围 `0.0` ~ `1.0`）

在 `resolveConfig` 中增加归一化处理与有效性校验。

### 2.2 Jev 决策模块（`src/jev.ts`）
- `JevInferenceManager`：会话级 generation 递增、旧请求 abort、活跃映射表；
- `resolveJevCredentials`：配置项与环境变量凭据解析（`JEV_API_KEY` / `JEV_BASE_URL` / `JEV_MODEL`）；
- `extractTurnContext`：从会话事件中提取最新用户指令及必要上下文；
- `queryJevModelPreset`：构造 Jev Decisions API 载荷，调用 Jev，校验响应的有限数值 confidence 与合法 choice；
- `runJevModelInference`：编排整个推断流程，判断与当前 selection 是否需要切换，并安全应用变更。

### 2.3 插件生命周期集成（`src/index.ts`）
- 在 `agent/pre-step`（当 `payload.step === 1`，即新回合开始首步）：
  - 检查 `jevEnabled` 是否启用且当前非 Plan Mode；
  - 直接传入从收件箱 claim 到但尚未写入 session 的 `payload.messages`；
  - 执行 Jev 自动切模；
  - 成功切换后追加 `model/selection` 事件，紧随其后的首个模型请求将立即使用新模型；
  - 插件 fiber 卸载时通过 `ctx.effect` 触发 `defaultJevManager.abortAll()` 释放所有进行中的请求。

### 2.4 Web 设置面板（`src/client/panel.tsx`）
- 保持原「启用 Agent 调模工具」复选框；
- 新增独立的「启用 Jev 自动模型切换」复选框及说明；
- 提供可折叠的 Jev 高级配置项（API Key 覆盖、Base URL、模型、置信度阈值）；
- 通过 RPC `mutate` 实时提交热更。

---

## 3. 实施步骤

1. **配置扩展**：修改 `src/config.ts` 增加 Jev 字段及解析。
2. **Jev 核心实现**：创建 `src/jev.ts`，实现凭据加载、API 通信、错误防御与并发管理。
3. **宿主集成**：修改 `src/index.ts`，在 `agent/pre-step` 首步挂钩 Jev 推断，处理 Plan 模式与白名单。
4. **客户端更新**：修改 `src/client/panel.tsx`，添加独立开关及表单控件；构建 `lib/client.js`。
5. **单元测试与验证**：编写 `test/jev.test.ts`，更新 `test/config.test.ts`、`test/plugin.test.ts`，执行 `npm run check`、`npm test`、`npm run build`。
6. **审查与总结**：拉起 reviewer 进行条件准入审查，生成总结报告。
