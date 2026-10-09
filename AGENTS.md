# dsh-set-model AGENTS.md

## 职责

为 DSH 提供动态模型与思考深度切换能力：
1. 向 Agent 注册 `set_model`、`list_models` 自主调模工具；
2. 提供与 Plan 模式联动的模型自动升降级机制（进入 Plan 模式自动切为高智力模型，退出自动恢复日常执行模型）。

## 地图

- `src/config.ts` — 插件配置 Schema（planModel、autoRestorePlanModel、enableAgentTools 等）
- `src/controller.ts` — 核心控制器：模型校验（`ctx.llm.resolveCallConfig`）、Token 容量水位校验、活跃模型解析、事件写入（`model/selection`）
- `src/tools.ts` — 工具注册：`set_model`、`list_models`
- `src/index.ts` — Cordis 插件入口：服务注入、工具注册、`agent/pre-step` 钩子联动 Plan 模式
- `test/` — 单元测试与场景化断言

## 开发规范（dev-dsh-plugin）

- 编译与检查：`npm run check`（`tsc --noEmit`）→ `npm test` → `npm run build`
- **依赖声明（踩过，issue #1）**：DSH 运行时包（`@deepseek-ai/cordis`、`dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-tools`…）必须声明在 `peerDependencies`，**绝不能**放 `dependencies`。宿主 `dsh-app-boot` 的模块解析层只把 peerDependencies 中的包名路由到宿主自带副本；写进 `dependencies` 会让 pnpm 把旧副本 hoist 进 profile，顶掉宿主单例，导致 typert 注册失败、会话列表消失（报错完全不指向本插件）。本地编译/测试所需的同版本副本放 `devDependencies`；纯叶子库（`@deepseek-ai/schemastery`）可留在 `dependencies`
- 平台 API 以 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 的 `.d.ts` 为准；宿主版本切换时同步 `peerDependencies` 区间与 `devDependencies` 版本，并按 issue #1 的方式验证（`npm run check` + 0.2.x/0.1.7 双版本）
