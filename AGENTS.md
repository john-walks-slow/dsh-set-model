# dsh-set-model AGENTS.md

## 职责

为 DSH 提供模型策略（model policy）能力：
1. 向 Agent 注册调模工具——自由模式 `set_model` / `list_models`，档位模式 `switch_preset` / `list_presets`；
2. 与 Plan 模式联动的模型自动升降级（进入自动切高智力模型/档位，退出自动恢复）；
3. 把「阶段→模型」策略写成系统提示词段落，并提供插件自带的 Web 设置页维护档位与策略。

## 地图

- `src/config.ts` — 配置 Schema（mode、presets、policyPrompt、planPreset、planModel…）与 `resolveConfig`（归一化 + `problems` 诊断）；**所有可编辑字段必须标 `.volatile()`**，否则不会出现在设置表单里
- `src/presets.ts` — 档位查找/匹配/渲染：`findPreset`、`presetToSelection`、`matchPreset`、`renderPresetRoster`、`renderModelPolicySection`
- `src/controller.ts` — 核心控制器：模型校验（`ctx.llm.resolveCallConfig`）、Token 容量水位校验、活跃模型解析、事件写入（`model/selection`）
- `src/tools.ts` — 四个工具：`set_model`、`list_models`、`switch_preset`、`list_presets`（按 mode 二选一注册）
- `src/index.ts` — Cordis 插件入口：`dsh:model-policy` 系统提示词段落、运行时上下文行、按 mode 注册工具、`agent/pre-step` 联动 Plan 模式、`settings.configure({auto:false})`
- `src/client/` — 浏览器半：`index.ts` 注册 `settings.section`，`panel.tsx` 设置页（读写 `set-model` 命名空间）
- `scripts/build-client.mjs` — esbuild 打包浏览器半为 `lib/client.js`（lazy-CJS，`id` 必须等于包名），构建后自动 `node --check`
- `e2e/verify-policy-page.mjs` — dsh-e2e 无头浏览器验证设置页注册/读写/持久化
- `test/` — 单元测试与场景化断言

## 开发规范（dev-dsh-plugin）

- 编译与检查：`npm run check`（宿主 + 浏览器半两份 tsc）→ `npm test` → `npm run build`
- **依赖声明（踩过，issue #1）**：DSH 运行时包（`@deepseek-ai/cordis`、`dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-tools`…）必须声明在 `peerDependencies`，**绝不能**放 `dependencies`。宿主 `dsh-app-boot` 的模块解析层只把 peerDependencies 中的包名路由到宿主自带副本；写进 `dependencies` 会让 pnpm 把旧副本 hoist 进 profile，顶掉宿主单例，导致 typert 注册失败、会话列表消失（报错完全不指向本插件）。本地编译/测试所需的同版本副本放 `devDependencies`；纯叶子库（`@deepseek-ai/schemastery`）可留在 `dependencies`
- **浏览器半的 inject 必须写全**：客户端 ctx 代理对未注入的服务访问直接抛错（`cannot get property "remote.session" without inject`），错误只在浏览器控制台可见。当前需要 `slots`、`remote`、`remote.settings`、`remote.session`
- **浏览器半是构建产物**：改完必须 `npm run build`（或 `npm run build:client`）重建 `lib/client.js`；`__ModuleLoader__.load({ id })` 的 id 必须等于包名 `dsh-set-model`，否则整条 combo bundle 二次执行、Web 端 Failed to load plugins
- **设置页可见性**：DSH 0.2 的 `SettingsForms.describe()` 只收录含 volatile 字段的 Config，且只投影 volatile 字段；设置命名空间 = profile loader entry id（本插件为 `set-model`）
- **e2e 的配置必须播种成用户层，不能走 `dsh --patch`**：`--patch` 是覆盖层（overlay），设置页会判定该命名空间"被 home patch 或命令行覆盖"而**拒绝写入**，于是"页面保存 → 重载仍生效"的用例会变成假绿（保存静默失败，重载读到的其实是种子值）。种子写进 `$DSH_HOME/profiles/web/cordis.patch.yml`（`dsh-e2e start --patch e2e/fixture/cordis.patch.yml` 已按此实现）才可写、可复现
- 平台 API 以 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 的 `.d.ts` 为准；宿主版本切换时同步 `peerDependencies` 区间与 `devDependencies` 版本，并按 issue #1 的方式验证（`npm run check` + 0.2.x/0.1.7 双版本）

## 已知边界

- 档位模式只约束 Agent 的工具面：用户在 GUI 模型选择器的切换**无法**被插件拦截（`dsh-api-session-controller.selectForNextRequest` 无 hook），这是设计选择而非缺陷。
