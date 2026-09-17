# dsh-set-model

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

为 DeepSeek Harness（DSH / cordis plugin）提供**动态模型与思考深度切换**的插件：Agent 通过 `set_model` / `list_models` 工具按任务难度自主切换 provider、model 与 reasoningEffort，插件把活跃模型注入运行时上下文，并随 Plan 模式自动升降级模型。

攻坚疑难问题时升到高推理档位，日常执行保持高性价比档位——不再需要用户手动改配置。

## 模型看到什么

插件通过 `systemPrompt.context` 在每个 step 的 Runtime Context 快照尾部注入一行当前活跃模型（cache-safe 追加，模型随时自查、无需调用工具）：

```
[Current active model: deepseek/deepseek-chat · reasoning: low]
```

处于 Plan 模式时附带状态标记：

```
[Current active model: deepseek/deepseek-reasoner · reasoning: high] [Plan Mode Active]
```

### 工具：set_model

`set_model({ provider?, model?, reasoningEffort?, reason })` —— `reason` 必填（每次切换都会使会话 KV cache 失效，工具说明要求 Agent 给出理由、避免频繁切换）：

```json
{ "model": "deepseek-reasoner", "reasoningEffort": "high", "reason": "疑难并发问题排查，需要深度推理" }
```

工具返回：

```
Model successfully switched to deepseek/deepseek-reasoner · reasoning: high. Effective from the next step.
Reason: 疑难并发问题排查，需要深度推理
```

### 工具：list_models

`list_models({ provider? })` 列出已注册 Providers 与模型能力（推理档位、上下文窗口）：

```
# Available Providers & Models:

## Provider: deepseek
- **deepseek-reasoner** (DeepSeek Reasoner) | Reasoning: [low, high, max] | Context: 128000
- **deepseek-chat** (DeepSeek Chat) | Context: 128000
```

切换自下一个 step 生效：插件向会话写入 `model/selection` 事件（与 GUI 模型选择器同一机制），Web UI 状态同步。

## Plan 模式自动升降级

插件监听 `agent/pre-step` 的 Plan 投影状态变迁，零人工干预：

- **进入 Plan 模式**（`/plan on`）：暂存当前日常模型，自动切换到配置的 `planModel`（高智力规划模型）；
- **退出 Plan 模式**（`exit_plan_mode` 批准 / `/plan off`）：自动恢复进入前的日常模型（`autoRestorePlanModel`，默认开启）；
- 自动切换失败仅 warn 降级，绝不打断 step。

## 安全护栏

- **Provider 白名单**：`allowedProviders` 非空时，白名单外的切换请求直接拒绝；
- **上下文窗口护栏**：当前会话 token 水位超过目标模型 contextWindow 时拒绝切换，并提示先压缩上下文（如 clear_mind）：

  ```
  Current session token pressure (70000 tokens) exceeds target model context window (65536 tokens).
  Please compact context (e.g. clear_mind) before switching to this model.
  ```

- **路由校验**：候选组合经 DSH 核心 `ctx.llm.resolveCallConfig` 校验（provider 适配器存在、模型合法、reasoningEffort 受支持），非法组合返回明确错误，不写入任何会话状态；
- **仅根 Agent**：工具只注册给根 Agent（subagent 不提供自主调模）；`enableAgentTools: false` 可整体关闭。

## 配置

Settings 命名空间 `dsh-set-model`（Web Settings UI 可视化配置，改动运行时动态生效）：

```yaml
dsh-set-model:
  planModel:                    # 可选：进入 Plan 模式自动切换的目标模型
    provider: deepseek
    model: deepseek-reasoner
    reasoningEffort: high
  autoRestorePlanModel: true    # 退出 Plan 模式自动恢复日常模型（默认 true）
  enableAgentTools: true        # 是否注册 set_model / list_models 工具（默认 true）
  allowedProviders: []          # 可选：可切换 Provider 白名单（空 = 不限制）
```

## 安装

```bash
dsh plugin --profile web add dsh-set-model
```

安装后无需手动改配置，插件自带的 `cordis.patch.yml` 自动挂载生效。

从 GitHub 直装（源码安装，pnpm ≥10 需允许构建脚本）：

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-set-model
# 首次 add 会被 pnpm 拦截：把 pnpm 提示的包名加入
# ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds 后重跑
```

## 权限与兼容

- **零直接副作用**：无外部服务、无插件自身网络请求（模型路由与能力查询均经由 DSH 核心 `llm` 服务）、无直接文件系统写入；仅通过会话事件 API 写入 `model/selection` 事件（由 DSH 会话系统落盘）并注入一行 Runtime Context
- **依赖**：`@deepseek-ai/cordis` 4.0.2 / `@deepseek-ai/dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-tools` 0.1.2-rc.1（与 dsh 0.1.2-rc.1 锁定版本对齐）、`zod` ^3.24.2；Node ≥ 22.5
- **失败降级**：Plan 模式自动切换失败只 warn 不打断 step；工具校验失败向 Agent 返回明确错误，不污染会话状态

## 本地开发

```bash
npm install
npm run build     # tsc → dist/src
npm test          # tsc(含 test) + node --test dist/test/*.test.js
```

## License

MIT

## 发新版

改动入库后一条命令完成测试、版本号、打包（`npm version` 会自动 commit 并打 tag）：

```bash
npm run release        # patch；较大更新改用：npm version minor 或 major
```

然后指纹发布并推送：

```bash
node ~/.agents/skills/npm-publish/scripts/publish-webauthn.cjs /tmp/dsh-set-model-<新版>.tgz
git push --follow-tags
```

发布后 `npm view dsh-set-model version` 复验。批量发多个包时，在指纹页勾选“5 分钟内同 IP 不再挑战”，一次指纹即可连发。
