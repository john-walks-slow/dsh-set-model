# peer-dependencies 用户验证

## 验证说明

- 验证对象：issue #1 修复——核心 `@deepseek-ai/*` 运行时包改用 `peerDependencies` 声明，消除旧副本 hoist 顶掉宿主单例导致「会话列表空白 + typert codec 报错」的链路。
- 环境/前置条件：DSH ≥ 0.1.7 的**干净 profile**（`DSH_HOME` 独立、`pnpm-workspace.yaml` 保持 DSH 默认的 `nodeLinker: hoisted` + `autoInstallPeers: false`）；Windows + pnpm 为 issue 现场环境，本机 Linux 亦可复现同类解析。

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| -------- | -------- | -------- | ---- | --------- |
| 1. `npm run release` 打出 0.1.1 tgz 后指纹发布；`npm view dsh-set-model@0.1.1 dependencies peerDependencies` 检查清单 | `dependencies` 仅剩 `@deepseek-ai/schemastery`；`peerDependencies` 出现 6 条（cordis + 5 个 dsh-*），版本区间为 `^0.1.7-rc.2 \|\| ^0.2.0-rc.1` | | 待验证 | 发布动作需要用户指纹（npm passkey），Agent 无法代做 |
| 2. 干净 `DSH_HOME`（如 `%TEMP%\dsh-repro`）执行 `dsh plugin --profile web add dsh-set-model@0.1.1` 后启动，打开 Web UI | 启动日志无 `codec has no create() factory` / `session/list ... withdrawn`；侧栏会话列表正常显示（含既有历史会话）；profile 的 `node_modules/@deepseek-ai/` 下没有 `dsh-llm` 等被 hoist 的副本 | | 待验证 | 这是 issue 的原始复现路径，需要真实 profile 才能确认端到端 |
| 3. 在 issue #1 下回复修复说明并请报告者复验（其环境为 DSH 0.1.7-rc.2 / Windows） | 报告者复验通过或反馈新问题 | | 待验证 | 需用户同意后再对外回复 |

状态使用：`待验证`、`通过`、`不通过`、`受阻`。

## 验证结论

待验证。

## 待跟进

- issue #1 复现路径的 registry 安装验证（上表第 2 项）尚未在真实 profile 上执行；本机已用等价探针（pnpm hoist 前/后对照 + 隔离最小实例 `fiber: active`）覆盖了同一解析链路。
- 另案：插件设置集成在 DSH ≥ 0.1.7 上静默失效（`settings.installSection` API 已被 `SettingsForms` 取代，见 `261009-peer-dependencies.troubleshoot.md` §5），是否本轮一并修复待确认。
