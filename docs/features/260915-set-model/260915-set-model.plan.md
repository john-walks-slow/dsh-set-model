# 实施计划：DSH 动态模型与思考深度切换 (dsh-set-model)

## 1. 概述与目标

为 DSH 提供一个轻量、健壮且无缝集成的插件 `dsh-set-model`，实现：
1. **Agent 自主调模能力**：注册 `set_model`、`get_model`、`list_models` 工具，赋予 Agent 根据任务复杂度自主切换模型和调节思考深度（`reasoningEffort`）的能力；
2. **Plan 模式自动升降级联动**：在进入 Plan 模式（`/plan on`）时自动升级至深度思考/高智力规划模型，并在退出 Plan 模式（`exit_plan_mode` 批准或 `/plan off`）时自动恢复之前的执行模型；
3. **跨 Provider / 跨 Model 广泛支持**：不仅支持同模型下思考深度微调，更支持跨 Provider 自由切换（如 DeepSeek、Anthropic、OpenAI 等），并带有模型合法性与 Context Window 水位校验。

---

## 2. 用户体验与典型工作流设计

### 2.1 场景 A：Plan 模式自动模型升降级（零人工干预）
1. 用户在日常开发中使用高性价比、低延迟的日常模型（如 `deepseek/deepseek-chat` 或 `anthropic/claude-3-5-sonnet`）；
2. 用户输入 `/plan 帮我重构鉴权模块`，进入 Plan 模式；
3. 插件自动捕获 Plan 模式开启事件，记录当前日常模型，并自动将 Session 切换为配置的高智力规划模型（如 `deepseek/deepseek-reasoner` 或 `claude-3-7-sonnet`，思考深度 `high`）；
4. Agent 使用顶配模型深度调研、推理并生成详尽的重构计划，调用 `exit_plan_mode` 提交用户审核；
5. 用户审核并通过计划（Approve）；
6. 插件自动捕获 Plan 模式退出事件，将 Session 自动切回之前的日常模型，进入高速、高性价比的代码编写与测试执行阶段。

### 2.2 场景 B：Agent 自主攻坚（自知之明与按需升维）
1. Agent 在执行某项排查任务时，发现遇到了复杂的并发竞争或疑难底层 Bug；
2. Agent 调用 `get_model` 查看当前模型，意识到当前处于 `reasoningEffort: low` 或轻量模型；
3. Agent 调用 `set_model({ reasoningEffort: 'max' })` 或 `set_model({ provider: 'deepseek', model: 'deepseek-reasoner' })`；
4. 工具返回切换成功确认；下一个 Step 开始，Agent 以满血推理能力攻克疑难问题；
5. 攻坚完成后，Agent 再次调用 `set_model` 降级，恢复正常执行。

---

## 3. 架构设计与核心组件

### 3.1 核心组件架构
```
┌─────────────────────────────────────────────────────────────────┐
│                        dsh-set-model                            │
│                                                                 │
│  ┌──────────────────────┐             ┌──────────────────────┐  │
│  │     Tools Layer      │             │   Lifecycle Layer    │  │
│  │  - set_model         │             │  - agent/pre-step    │  │
│  │  - get_model         │             │  - plan state diff   │  │
│  │  - list_models       │             │  - stash / restore   │  │
│  └──────────┬───────────┘             └──────────┬───────────┘  │
│             │                                    │              │
│             └─────────────────┬──────────────────┘              │
│                               ▼                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  SetModelController                       │  │
│  │  - Model Validation (ctx.llm.resolveCallConfig)           │  │
│  │  - Context Watermark Check (ctx.tokenMeter vs contextWin) │  │
│  │  - Event Emission (agent.session.append('model/selection'))│ │
│  │  - Active Model Resolution                                │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 插件配置定义（`Config`）
```ts
interface SetModelConfig {
  /** Plan 模式专用的目标模型配置（可选） */
  planModel?: {
    provider: string;
    model: string;
    reasoningEffort?: 'off' | 'low' | 'high' | 'max';
  };
  /** 退出 Plan 模式时是否自动恢复之前的非 Plan 模型，默认 true */
  autoRestorePlanModel?: boolean;
  /** 是否向 Agent 注册自主调模工具，默认 true */
  enableAgentTools?: boolean;
  /** 允许切换的 Provider 白名单（可选，空数组表示不限制） */
  allowedProviders?: string[];
}
```

### 3.3 工具契约定义

#### 1. `set_model`
- **入参（Zod Schema）**：
  - `provider` (string, optional): 目标 Provider（若省略则继承当前 Provider）；
  - `model` (string, optional): 目标模型 ID（若省略则继承当前 Model）；
  - `reasoningEffort` ('off' | 'low' | 'high' | 'max', optional): 思考深度；
  - 注：三者至少需提供一项。
- **执行逻辑**：
  1. 解析并继承当前未指定的字段；
  2. 调用 `ctx.llm.resolveCallConfig` 校验组合合法性；
  3. 检查白名单限制（若配置了 `allowedProviders`）；
  4. 检查当前会话 Token 水位（通过 `ctx.tokenMeter`）是否在目标模型上下文容量内；
  5. 向 `agent.session` 写入 `model/selection` 事件，更新 next step selection；
  6. 返回包含目标模型与生效说明的确认文本。

#### 2. `get_model`
- **入参**：无。
- **返回**：当前会话生效的 `provider`, `model`, `reasoningEffort`，以及当前是否处于 `planMode` 和是否有暂存模型。

#### 3. `list_models`
- **入参**：`provider` (string, optional)。
- **返回**：当前系统可用 Providers 及各 Provider 下已注册的可用 Models 列表与能力摘要（是否支持 reasoning 等）。

### 3.4 Plan 模式联动与状态机

- **状态管理**：
  - 为每个 Session 维护一个会话级上下文状态：`{ planActive: boolean, stashedNonPlanModel?: ModelSelection }`。
- **在 `agent/pre-step` 钩子中执行状态机检测**：
  1. 通过 `ctx.sessionProjections.stateOf(session, 'plan')` 获取当前 Plan 模式的实际状态；
  2. 若 `currentPlan.active === true` 且 `lastState.planActive === false`（**进入 Plan 模式**）：
     - 记录当前 Session 活跃的模型作为 `stashedNonPlanModel`；
     - 若配置了 `config.planModel`，自动调用 `switchModel` 切换至 `config.planModel`，并在日志中记录 `[dsh-set-model] Auto-switched to plan model`；
     - 更新 `lastState.planActive = true`。
  3. 若 `currentPlan.active === false` 且 `lastState.planActive === true`（**退出 Plan 模式**）：
     - 若 `config.autoRestorePlanModel !== false` 且存在 `stashedNonPlanModel`：
       - 自动调用 `switchModel` 恢复至 `stashedNonPlanModel`，并在日志中记录 `[dsh-set-model] Auto-restored execution model`；
       - 清除 `stashedNonPlanModel`；
     - 更新 `lastState.planActive = false`。

---

## 4. 实施阶段与步骤拆解

### Phase 1: 项目骨架与工程环境搭建
- [ ] 创建 `package.json`（严格声明 `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis`, `zod` 等 dependencies）；
- [ ] 创建 `tsconfig.json` 与 `tsconfig.build.json`；
- [ ] 创建 `cordis.patch.yml` 声明 bundle loader entry；
- [ ] 执行 `npm install` 安装本地 node_modules 确保 ESM link 稳定。

### Phase 2: 核心控制器与模型解析（`src/controller.ts`）
- [ ] 实现 `resolveActiveSelection(agent)`：准确提取当前 Session 正在生效的模型配置；
- [ ] 实现 `applyModelSelection(agent, targetSelection)`：封装模型校验、Token 容量检查与 `model/selection` 事件写入；
- [ ] 实现 `ModelCatalogQuerier`：从 `ctx.llm` 读取已配置的 Providers 和 Models。

### Phase 3: Agent 工具集实现（`src/tools.ts`）
- [ ] 实现 `set_model` 工具（含全参数校验、错误友好提示）；
- [ ] 实现 `get_model` 工具；
- [ ] 实现 `list_models` 工具；
- [ ] 为工具提供清晰的 schema 与调用指引说明。

### Phase 4: Plan 模式自动联动生命周期（`src/index.ts`）
- [ ] 实现 `agent/pre-step` 钩子对 Plan 模式变迁的无缝监听；
- [ ] 实现 `stash` 与 `restore` 状态流转；
- [ ] 实现针对会话 Resume / Fork 的状态容错处理。

### Phase 5: 测试套件与实机验证
- [ ] 编写单元测试（`test/controller.test.ts`）：模型解析、合法性校验、白名单过滤；
- [ ] 编写工具测试（`test/tools.test.ts`）：`set_model`、`get_model`、`list_models` 行为断言；
- [ ] 编写 Plan 模式联动测试（`test/plan-switch.test.ts`）：进入/退出 Plan 模式的模型自动切换与恢复断言；
- [ ] 本地独立端口启动 DSH 实例，验证插件加载无报错且功能正常。

---

## 5. 验收标准与防御清单

- [ ] `npm run check`（TypeScript 类型检查）完全通过；
- [ ] `npm test` 所有测试用例 100% 通过；
- [ ] 插件满足 `dev-dsh-plugin` 规范：`package.json` 显式声明全部依赖，本地包含 `node_modules`；
- [ ] Agent 可通过 `set_model` 自由切换 Provider、Model 与 ReasoningEffort；
- [ ] `/plan` 进入 Plan 模式时自动升为 `planModel`，退出时自动恢复原模型；
- [ ] 切模非法或 Token 超限时有明确报错提示，不会破坏 Session 状态。
