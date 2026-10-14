# 检视报告

## 概要

本轮检视覆盖需求计划、总结文档、Jev 核心实现、插件入口、配置归一化、Web 设置面板、相关单元测试及 GUI E2E 脚本。核心修复已落实：Jev 仅使用插件配置或 `JEV_*` 环境变量，入口在 `step === 1` 读取 `payload.messages`，`keep` 保留字被拒绝，阈值有客户端校验，且存在请求取消生命周期钩子；但仍有宿主 API 违规使用、重复清理注册、交付文档过期和新增设置缺少 E2E 覆盖的问题。

本次仅进行静态检视，未执行测试、构建或 E2E。源码中静态统计到 49 个 `test(...)` 用例；“全部通过”仍应以实际 CI/验证记录为准。

## 需求对齐

- **纯正 Jev 凭据：已满足实现要求。** `resolveJevCredentials()` 只读取显式配置和 `JEV_API_KEY` / `JEV_BASE_URL` / `JEV_MODEL`，无 `api-vault`、`OPENROUTER_API_KEY` 或本机密码本读取逻辑；无 API Key 时返回 `null` 并跳过推断。
- **生命周期触发：已满足。** [src/index.ts:207](/root/projects/dsh-set-model/src/index.ts:207) 使用 `payload.step === 1`，与宿主 `agent/pre-step` 首步语义一致；`step === 2` 不会再次触发 Jev。
- **上下文时序：已满足核心场景。** [src/index.ts:209](/root/projects/dsh-set-model/src/index.ts:209) 将 `payload.messages` 传入 `runJevModelInference()`，后者再传给 `extractJevContext()`；测试静态覆盖当前消息尚未写入 session 的场景。
- **保留字：已满足。** [src/config.ts:293-296](/root/projects/dsh-set-model/src/config.ts:293) 丢弃 `id === "keep"` 的 preset 并记录 problem。
- **客户端阈值校验：已满足基本要求。** [src/client/panel.tsx:154-164](/root/projects/dsh-set-model/src/client/panel.tsx:154) 在启用 Jev 时校验有限数值及 `0.0–1.0` 范围。
- **资源回收：已接入，但重复注册。** [src/index.ts:57-58](/root/projects/dsh-set-model/src/index.ts:57) 和 [src/index.ts:221-223](/root/projects/dsh-set-model/src/index.ts:221) 各注册了一次 `abortAll()` 清理 effect。
- **独立开关与竞态：核心实现已覆盖。** `jevEnabled` 与 `enableAgentTools` 分开判断；generation、AbortController、提交前配置核验和 Plan Mode 避让均存在，相关测试源码也有对应场景。
- **文档同步：未完全满足。** 计划文档已采用纯 `JEV_*` 凭据与 `step === 1`，但总结文档仍保留 `OPENROUTER_API_KEY`、`step === 0` 和 48 项测试等过期描述。

## 阻塞问题

无。

## 建议修改

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| S-1 | [src/jev.ts:121-169](/root/projects/dsh-set-model/src/jev.ts:121) | Jev 新增代码仍调用 `session.snapshotEvents()`。宿主 `@deepseek-ai/dsh-session` 类型声明将该 API 标记为 deprecated，并明确写明“new calls are prohibited”。当前回合指令虽已改由 `payload.messages` 提供，但历史回退和助手背景仍走该禁止新增的同步事件读取路径。 | 改用 `session.deriveMessages()`，按 `role` 和 `source.kind` 提取历史用户/助手消息；同时删除事件对象的宽泛匿名断言。 |
| S-2 | [src/index.ts:57-58](/root/projects/dsh-set-model/src/index.ts:57)、[src/index.ts:221-223](/root/projects/dsh-set-model/src/index.ts:221) | 插件卸载时的 `defaultJevManager.abortAll()` 清理 effect 注册了两次。当前方法幂等，暂未形成明显运行故障，但会重复维护生命周期行为，且使资源边界不清晰。 | 只保留一处 effect 注册，并将“取消全部请求并清空 generation 状态”的职责说明集中在该处。 |
| S-3 | [docs/features/261013-jev-model-switching/261013-jev-model-switching.summary.md:10-16](/root/projects/dsh-set-model/docs/features/261013-jev-model-switching/261013-jev-model-switching.summary.md:10)、[docs/features/261013-jev-model-switching/261013-jev-model-switching.summary.md:30-43](/root/projects/dsh-set-model/docs/features/261013-jev-model-switching/261013-jev-model-switching.summary.md:30) | 总结文档与当前实现及计划不一致：仍写 `OPENROUTER_API_KEY` 回退、`step === 0`，并称单元测试为 48 项；当前实现只支持 `JEV_*`，生命周期为 `step === 1`，静态源码已是 49 项。 | 删除 OpenRouter 专用 Key 的描述，统一为配置项 → `JEV_*` 环境变量；将所有首步描述改为 `step === 1`，并以实际验证记录更新测试数量和结论。 |
| S-4 | [e2e/verify-policy-page.mjs:109-176](/root/projects/dsh-set-model/e2e/verify-policy-page.mjs:109) | GUI E2E 仍只验证既有模式、preset、策略提示词、Plan 目标和持久化，没有验证新增的 Jev 独立开关、API Key/Base URL/模型/阈值字段，也没有验证非法阈值的前端拒绝。客户端源码和 bundle 静态存在这些控件，不能证明 RPC 写入、重载持久化及错误提示真实可用。 | 增加 Jev 开关独立于 Agent 工具开关的保存/重载断言；填写三个凭据字段和阈值后验证持久化；分别提交 `NaN`、负数和大于 1 的值，确认保存被拦截并显示阈值错误。 |
| S-5 | [src/jev.ts:111-115](/root/projects/dsh-set-model/src/jev.ts:111)、[src/jev.ts:97-100](/root/projects/dsh-set-model/src/jev.ts:97) | `UserMessage.source` 在宿主类型中已带有 `kind`，但实现仍使用 `(msg.source as any)?.kind`，并额外判断不存在于当前 source 类型语义中的 `"user-rpc"`。宿主的 `user-rpc` 扩展实际使用 `kind: "user"` 加 `rpcId`，因此该分支是死逻辑，也削弱了类型约束。 | 直接使用 `msg.source.kind`，按宿主的 `kind: "user"` 语义判断；若要区分 RPC 消息，应使用对应扩展字段并明确类型，而不是比较错误的 kind 字符串。 |

## 非阻塞问题

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| N-1 | [src/client/panel.tsx:154-164](/root/projects/dsh-set-model/src/client/panel.tsx:154) | 阈值校验只在 `jevEnabled` 为 true 时执行。用户可先输入非法值、再关闭 Jev 保存；服务端会回落到默认值，但本次界面不会提示输入被归一化。 | 保存时始终校验该字段，或在禁用 Jev 时主动恢复默认值并同步显示实际生效值。 |
| N-2 | [src/jev.ts:391-407](/root/projects/dsh-set-model/src/jev.ts:391) | Jev 推断在 `agent/pre-step` 中被同步 `await`，网络异常时最多等待 3 秒才进入首个模型请求。这样保证切换后的模型用于当前首步，但与计划中“超时不会阻塞主会话”的表述不完全一致。 | 明确文档口径为“Jev 网络请求最多阻塞首步 3 秒”；若必须严格不阻塞，应重新设计首步切换时序，不能仅将调用改为 fire-and-forget。 |
| N-3 | [src/jev.ts:104-117](/root/projects/dsh-set-model/src/jev.ts:104) | 当 `payload.messages` 不含 user 消息时，代码仍会把其他文本消息作为指令；若多个非 user 消息存在，反向扫描最终可能选中较早的一条。后台唤醒或合成通知场景下，决策输入可能不是用户最新意图。 | 明确无 user 指令时直接跳过 Jev，或按宿主消息来源定义提取一条结构化任务摘要；避免把任意通知当作用户指令。 |
| N-4 | [src/jev.ts:194-216](/root/projects/dsh-set-model/src/jev.ts:194)、[README.md:224](/root/projects/dsh-set-model/README.md:224) | Jev 开启后会直接向配置的 Base URL 发起网络请求，但 README 权限说明仍概括为“无外部服务、无插件自身网络请求”，与该特性实际行为冲突。 | 将权限说明拆分为普通模型策略路径与 Jev 路径，并明确 Jev 会向用户配置的 Decisions API 发送当前任务上下文及认证请求。 |
| N-5 | [src/config.ts:9](/root/projects/dsh-set-model/src/config.ts:9)、[src/client/panel.tsx:734-739](/root/projects/dsh-set-model/src/client/panel.tsx:734) | 默认端点和 UI placeholder 仍是 `openrouter.ai`。这不再构成 OpenRouter 专用 Key 依赖，但“完全独立于 OpenRouter”的文档措辞容易让用户误解为默认端点也不是 OpenRouter。 | 明确这是 Jev Decisions API 的默认托管端点；若产品要求真正平台中立，则取消默认端点并要求用户显式提供 `jevBaseUrl`。 |

## 准入结论

**结论**：`条件准入`

**说明**：未发现会使 Jev 核心自动切模路径失效的阻塞缺陷，用户确认的 1-based 首步、当前消息时序、纯 `JEV_*` 凭据、保留字和独立开关均已在实现中体现。但宿主明确禁止的新 `snapshotEvents()` 调用、重复资源清理注册、过期总结文档和缺少 Jev 设置 E2E 会影响长期维护与交付可信度，建议合并前处理 S-1 至 S-4。
