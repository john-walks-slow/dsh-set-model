# dsh-set-model AGENTS.md

## 职责

为 DSH 提供动态模型与思考深度切换能力：
1. 向 Agent 注册 `set_model`、`get_model`、`list_models` 自主调模工具；
2. 提供与 Plan 模式联动的模型自动升降级机制（进入 Plan 模式自动切为高智力模型，退出自动恢复日常执行模型）。

## 地图

- `src/config.ts` — 插件配置 Schema（planModel、autoRestorePlanModel、enableAgentTools 等）
- `src/controller.ts` — 核心控制器：模型校验（`ctx.llm.resolveCallConfig`）、Token 容量水位校验、活跃模型解析、事件写入（`model/selection`）
- `src/tools.ts` — 工具注册：`set_model`、`get_model`、`list_models`
- `src/index.ts` — Cordis 插件入口：服务注入、工具注册、`agent/pre-step` 钩子联动 Plan 模式
- `test/` — 单元测试与场景化断言

## 开发规范（dev-dsh-plugin）

- 编译与检查：`npm run check`（`tsc --noEmit`）→ `npm test` → `npm run build`
- 依赖声明：`package.json` 必须显式声明所有 `@deepseek-ai/*` 依赖，且本地执行 `npm install`
- 平台 API 以 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 的 `.d.ts` 为准
