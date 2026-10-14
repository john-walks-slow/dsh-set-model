# 实施总结：dsh-set-model 基于 TypeSafe Jev 的自动模型切换

- **特性分支/标签**：`feat/261013-jev-model-switching`
- **目标目录**：`/root/projects/dsh-set-model`
- **对应版本**：`0.2.1`（向后兼容功能扩展）
- **交付状态**：已完成并准入

---

## 1. 核心目标达成情况

为 `dsh-set-model` 模型策略插件成功引入基于 TypeSafe Jev 决策模型的自动模型档位切换能力：
1. **双独立开关架构**：
   - 模型工具开关（`enableAgentTools` / `toolEnabled`）：控制是否向 Agent 注入 `set_model` / `switch_preset` 等调用工具；
   - Jev 自动切模开关（`jevEnabled`）：控制是否在会话执行过程中自动推断并切换模型档位；
   - 两个开关完全解耦，用户可任意组合（仅工具、仅 Jev 自动、两者均开、两者均关）。
2. **纯正通用 Jev 凭据体系**：
   - 严格支持两层标准通道：插件配置项（`jevApiKey` / `jevBaseUrl` / `jevModel`）与通用环境变量（`JEV_API_KEY` / `JEV_BASE_URL` / `JEV_MODEL`）；
   - 彻底移除了对 OpenRouter 专用 Key 及本机私有 api-vault 密码本的硬依赖，零本机环境绑定；
   - 默认 Decisions API 端点指向 `https://openrouter.ai/api/alpha/decisions`，默认模型为 `typesafe/jev-1.13`，单次决策延迟约 200~300ms，成本仅约 $0.000015 / 次。
3. **真实宿主生命周期对齐与时序防护**：
   - 挂钩于宿主真实回合首步 `agent/pre-step`（`payload.step === 1`），后续 step（2, 3...）不重复触发；
   - 上下文提取优先从当前回合收件箱刚 claim 到但尚未写入 session 的 `payload.messages` 提取真实意图，杜绝读取上一回合过期指令的时序错位；
   - 历史回退与助手背景摘要全面采用宿主标准的 `session.deriveMessages()` API，杜绝使用已被废弃且禁止新增调用的 `snapshotEvents()`。
4. **工业级鲁棒性与防护设计**：
   - **Generation 竞态淘汰**：单会话请求控制器管理，新请求自动终止并废弃旧请求；
   - **双重提交核验**：提交变更前核验 generation 一致性与实时 `jevEnabled` 开关；
   - **Plan 模式避让保护**：Plan 模式生效期间保持其专属模型/档位锁定，避免 Jev 冲撞覆盖；
   - **超时与降级保底**：3 秒超时熔断，网络故障或超时仅记录警告并平滑回退，绝不阻塞主会话正常运行；
   - **保留字防冲突**：配置归一化阶段主动拦截并拒绝 `id === "keep"` 的预设档位，防止与 Jev 内部保持选项冲突；
   - **资源清理**：插件通过 `ctx.effect(() => () => defaultJevManager.abortAll())` 在卸载或重载时优雅取消所有在途请求；
   - **完整复用核心控制器防线**：Provider 白名单、模型能力（reasoningEffort）自适应、Token 压力与上下文窗口护栏。
5. **Web 设置面板更新**：
   - 设置面板（「模型档位」）提供清晰独立的调模工具与 Jev 自动切模开关；
   - 提供折叠展开的 Jev 高级选项（API Key、Base URL、模型、置信度阈值）；
   - 客户端 `validate()` 强约束置信度阈值（0.0 ~ 1.0）；
   - 顺利构建为 `lib/client.js` 并通过静态语法检查。

---

## 2. 代码改动清单

| 文件 | 变更说明 |
| ---- | -------- |
| `src/config.ts` | 扩展 Schema：新增 `jevEnabled`、`jevApiKey`、`jevBaseUrl`、`jevModel`、`jevConfidenceThreshold`；增加 `keep` 保留字校验与归一化逻辑 |
| `src/jev.ts` | 新增 Jev 决策核心模块：凭据解析、`extractJevContext`（基于 `payload.messages` 与 `deriveMessages`）、Decisions API 通信、`JevInferenceManager` generation 竞态保护与 `runJevModelInference` 调度 |
| `src/index.ts` | 生命周期接线：在 `agent/pre-step`（`step === 1`）触发 Jev 自动推断并透传 `payload.messages`；注册 `ctx.effect` 清理回调 |
| `src/client/panel.tsx` | Web 界面：新增独立的 Jev 自动切换复选框与高级凭据表单，添加客户端数值校验，更新保存与突变逻辑 |
| `lib/client.js` | 重新构建的客户端打包产物（`esbuild` 打包，通过 `node --check` 语法检查） |
| `test/config.test.ts` | 增加 Jev 配置项解析、默认值、阈值边界及 `keep` 保留字校验测试 |
| `test/jev.test.ts` | 针对凭据解析、消息时序提取、Decisions API 通信、竞态淘汰、独立开关与 Plan 模式避让的完整单元测试套件 |
| `test/plugin.test.ts` | 真实 1-based step 生命周期测试：首步触发 Jev、次步不重复触发、与工具开关独立运作 |
| `README.md` / `README.en.md` | 中英文文档：补充 Jev 自动切模特性说明、独立双开关设计、配置项示例与权限说明 |
| `AGENTS.md` | 项目级指引更新 |

---

## 3. 验证结果

- **TypeScript 类型检查**：`npm run check`（宿主与浏览器半两份配置）严格通过，0 错误；
- **自动化测试**：`npm test` 全量 **49 项用例全部通过**，涵盖所有关键路径与异常边界；
- **客户端构建**：`npm run build` 成功打包 `lib/client.js`（32KB），且 `node --check lib/client.js` 验证通过；
- **审查准入**：Reviewer 给出准入结论，所有设计与时序问题已彻底闭环。
