# 调研报告：DSH 动态模型与思考深度切换 (dsh-set-model)

## 1. 需求与目标概述

### 1.1 背景与用户诉求
在 DSH（DeepSeek Harness）研发过程中，不同任务阶段对模型能力和推理开销有不同诉求：
1. **计划与架构设计阶段（Plan Mode）**：需要超高逻辑推理能力、深度思考（如 DeepSeek-R1 / Claude-3.7-Sonnet Thinking / O3 等），以生成完备、严谨的实施方案；
2. **日常代码编写与执行阶段（Normal Execution Mode）**：需要高吞吐、低延迟、高性价比模型（如 DeepSeek-V3 / Claude-3.5-Sonnet / Lite 模型），减少无谓的 Thinking Token 消耗；
3. **复杂问题攻坚（Agent 自主升级）**：Agent 在执行过程中遇到死锁排查、疑难 Bug 或算法设计时，能够**自主调用工具临时升级模型或思考深度**，攻坚完成后再降级。

### 1.2 核心特性目标
- **跨模型支持（Cross-Model Switching）**：不仅支持同模型下调节思考深度（`reasoningEffort: off | low | high | max`），还支持跨 Provider / Model 切换（例如从 `deepseek/deepseek-chat` 切换到 `anthropic/claude-3-7-sonnet` 或 `deepseek/deepseek-reasoner`）。
- **Agent 自主调模工具（Agent Tool）**：提供 `set_model` / `switch_model`、`get_model`、`list_models` 工具，让 Agent 能够根据任务上下文自主调整。
- **Plan 模式自动升降级联动（Plan Mode Auto-Transition）**：
  - 进入 Plan 模式（`/plan on`）时，自动暂存当前日常模型，并无缝切到配置的 Plan 高智力模型；
  - 退出 Plan 模式（`exit_plan_mode` 批准 或 `/plan off`）时，自动恢复进入 Plan 模式前的日常模型。

---

## 2. DSH 既有架构与内核机制深入剖析

### 2.1 会话级模型选择（Model Selection）链路
在 DSH 核心中，模型选择是持久化在会话日志（Session Log）中的状态：
1. **事件流与投影**：
   - `model/selection` 事件：携带 `{ provider: string, model: string, reasoningEffort?: string }`。
   - `modelSelection` 投影（位于 `dsh-api-session-controller`）：
     - 维护 `{ lastUsed, pending }` 状态；
     - 当收到 `model/selection` 事件时，更新 `pending`；
     - 当收到 `request/header` 事件时，更新 `lastUsed` 并清空匹配的 `pending`；
     - 通过 wire view 向 Web 前端暴露 `{ lastUsed, next }`。
2. **Step 请求头组装与覆盖（`installModelSelection`）**：
   - `dsh-agent` 中的 `installModelSelection` 监听了 `system-prompt/assemble` 与 `agent/request`。
   - 在每个 Step 开始前，从 `selection.assembled` 读取待选模型，并将目标 `provider`、`model`、`reasoningEffort` 注入到当次请求中。
   - 下发 LLM 请求后，`dsh-agent-loop` 会向会话日志写入最新的 `request/header` 事件。

### 2.2 模型解析与校验机制（`ctx.llm.resolveCallConfig`）
DSH 提供了统一的 LLM 路由器服务 `ctx.llm`：
- `ctx.llm.resolveCallConfig({ provider, model, reasoningEffort })`：
  - 校验指定的 provider 是否有已注册的适配器（Adapter）；
  - 校验指定的 model 在该 provider 下是否合法；
  - 校验 `reasoningEffort` 是否为目标模型所支持的值；
  - 如果非法，抛出明确错误（如 `UNSUPPORTED_REASONING_EFFORT` 或 `NO_ADAPTER`）；如果合法，返回规范化后的 CallConfig。
- `ctx.llm.modelCatalog` / `ctx.apiSessionController`：
  - 维护了系统中所有已配置的 Providers 与 Models 元数据。

### 2.3 Plan 模式机制（`dsh-plan-mode`）
Plan 模式是 DSH 的一等协作状态：
1. **事件与状态**：
   - `plan/mode` 事件：记录 `{ active: boolean }`。
   - `plan` 投影：跟踪 `{ active: boolean, wanted: boolean | null, running: ... }`。
2. **生命周期触发点**：
   - 用户命令 `/plan` 或 `/plan <message>`：设置 `wanted: true`，在下一个 `agent/pre-step` 写入 `plan/mode { active: true }` 并注入 `plan:policy` 系统提示词；
   - 工具 `exit_plan_mode` 审核通过 或 用户命令 `/plan off`：设置 `wanted: false`，在下一个 `agent/pre-step` 写入 `plan/mode { active: false }`。
3. **扩展钩子契机**：
   - 监听 `agent/pre-step` 或会话事件，可以精确捕获 Plan 模式的状态变迁（`inactive -> active` 与 `active -> inactive`），从而无侵入地触发模型切换。

---

## 3. 关键设计细节与风险考量

### 3.1 跨 Provider / Model 切换的上下文兼容性
1. **上下文窗口（Context Window）水位护栏**：
   - 会话历史较长时（例如 100k tokens），若切到小上下文模型（如 32k），会导致 API 报错。
   - **对策**：在切换前检查当前会话的预估 Token 数（通过 `ctx.tokenMeter`）与目标模型的 `contextWindow`，若超限则明确拦截并提示需先执行上下文压缩（Compaction）。
2. **思考内容（Reasoning Content / Thinking Blocks）过滤**：
   - DSH 底层的 `dsh-llm` 与各个 Provider 适配器已对消息历史做标准化投影与转换。但在某些严格网关下，跨模型携带非原生 thinking block 可能报错。
   - **对策**：依赖 DSH 原生 `dsh-llm` 消息标准化，确保传递标准 Message 格式。
3. **工具 Schema 兼容性**：
   - 切换到的目标模型必须支持 Function Calling / Tool Use。DSH 已安装的现代主力模型（DeepSeek、Anthropic、OpenAI、Gemini 等）均支持工具调用。

### 3.2 Plan 模式自动切换的“状态暂存与恢复”机制
1. **暂存（Stash）时机**：
   - 当 Session 首次进入 Plan 模式时，记录当前的 `activeModel`（即 `planEntryModel`）。
2. **恢复（Restore）时机**：
   - 当 Session 退出 Plan 模式时，若存在已暂存的 `planEntryModel`，自动切回该模型。
3. **边缘场景考量**：
   - **用户/Agent 在 Plan 模式中手动换模**：如果用户或 Agent 在 Plan 模式下显式换模，应视为更新当前 Plan 模式下的模型，退出 Plan 模式依然恢复到进入前记录的日常模型；
   - **会话恢复（Resume / Fork）**：状态应基于会话事件日志或轻量投影计算，保证即使会话重启/Fork，也能正确感知当前的暂存状态。

### 3.3 插件工程与稳定性规范（遵照 dev-dsh-plugin）
- 插件以 Cordis 插件形式开发，通过 `cordis.patch.yml` 挂载；
- 所有 `import` 的 `@deepseek-ai/*` 依赖必须在 `package.json` 的 `dependencies` 中严格显式声明，且本地执行 `npm install` 生成独立 `node_modules`，防止 link 包 ESM 解析失败导致整条 DSH 崩溃；
- 遵循单一职责与极简代码规范。

---

## 4. 结论

技术可行性完全具备，方案路径清晰：
1. 新建独立插件项目 `/root/projects/dsh-set-model`；
2. 实现 `SetModelController` 服务与 `set_model`、`get_model`、`list_models` 工具；
3. 挂载 `agent/pre-step` 监听器，实现 Plan 模式自动暂存与升降级切换；
4. 提供完整的单元测试与端到端验证。
