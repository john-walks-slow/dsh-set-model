# dsh-set-model 复杂度审计（bad-smell）

日期：2026-10-09 · 范围：`src/` 全部（约 650 行源码）

## 结论

整体**不算过度设计**：4 个文件各司其职（config / controller / tools / index），没有多余抽象层。
真正的"复杂"集中在 controller 的**防御式回退与降级**，以及一段**已经失效的 settings 集成**。

## 已修（本次）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| S1 | `src/index.ts` | `settings.installSection` 在 dsh-settings 0.2.x 已被移除（现为 `SettingsForms.configure/describe/update/replace/mutate`，见 dsh-settings/lib/index.js:330）。调用点只对 `settings` 做了可选链、方法缺失时直接抛 `TypeError`——2026-10-06 startup 日志实证：`settingsCtx.settings?.installSection is not a function`。settings UI 实际由 `describe()` 的 auto page 自动生成（`autoGenerate ?? true`），无需插件注册 | 删除整段集成；`currentConfig` 由 `let` 收敛为 `const`（配置变更经 loader 重新 `apply` 生效） |
| S2 | `src/controller.ts` | `resolveCurrentSelection` 5 层回退，其中 `projectionState.lastUsed` 与 `session.requestHeader()` 同源（投影的 lastUsed 正是 request/header 事件写入，见 dsh-api-session-controller/lib/types/model-selection-projection.js），且 lastUsed 不做 `adapterDefaults` 过滤、精度反而更低 | 删除 lastUsed 层，回退链 4 层，与核心 canonical 实现（`selectionFor`）对齐；`(agent as any).options` 改为类型化 `agent.options` |
| S3 | `src/controller.ts` | `listAvailableModels` 在 try/catch 里复制两份 entry 构造 | 抽 `readModelInfo()` 单点兜底，entry 只构造一次；并给返回值补上 `ModelListEntry` / `ProviderModels` 命名类型 |
| S4 | `src/controller.ts` | token 护栏用 `error.message.includes("exceeds target model context window")` 判断是否重新抛出，靠文案耦合；外部查询失败静默跳过属降级 | 只保留必要的错误包装，护栏判断移出 try，异常正常向上抛 |

净减 28 行；`npm run check` + 7/7 单测通过，实机 `list_models` 复测正常。

## 判定为「可接受，暂不动」

- **`config.ts` 的手工 `resolveConfig` 与 schemastery `Config` 重复**（默认值、planModel 校验两处维护）。理论上可用 `Config(raw)` 直接取 schema 默认值省掉约 15 行，但配置解析回归面大（plan 模型自动切换依赖它），收益有限，留待下次动配置时一并处理。
- **`(ctx as any)` 约 15 处**：跨 DSH 版本松耦合的收益目前大于类型损失。若要在不增加 peer 依赖的前提下恢复类型保护，可为用到的服务写本地最小接口（`LlmLike` / `TokenMeterLike` / `SessionProjectionsLike`）——S1 这类"API 没了还在调"的错误正是 `as any` 漏掉的。
- **`index.ts` 的 Plan 状态机**（WeakMap + 进入/退出两分支）：需要边沿检测，属必要复杂度。

## 遗留待办

- 无。`dsh-settings` 的 optional peer 声明、devDependency 与 README 第 111 行的依赖说明已随本次清理移除（代码已不再 import 它）。
