# dsh-set-model

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

为 DeepSeek Harness（DSH / cordis plugin）提供**模型策略**：把"不同阶段用什么模型"变成部署可声明、Agent 可遵守的显式规则。

- **自由模式**（默认）：Agent 用 `set_model` / `list_models` 按任务难度自主切换 provider、model 与 reasoningEffort；
- **档位模式**：部署声明一组「模型 + 思考强度」档位，Agent 只能在档位间切换（`switch_preset` / `list_presets`），不再允许任意指定模型；
- 两种模式都可配置一段**策略提示词**，写进系统提示词告诉 Agent 各阶段该用哪个档位；
- 插件把当前模型与档位注入运行时上下文，并随 Plan 模式自动升降级。

攻坚疑难问题时升到高推理档位，日常执行保持高性价比档位——不再需要用户手动改配置。

![模型档位设置页](assets/model-policy-settings.png)

## 两种模式

| | 自由模式 `mode: free`（默认） | 档位模式 `mode: preset` |
|---|---|---|
| Agent 工具 | `set_model`、`list_models` | `switch_preset`、`list_presets` |
| 可切换范围 | 任意已注册 provider / model / 思考强度 | 仅配置里 `presets` 声明的档位 |
| Plan 联动目标 | `planModel` | `planPreset` |
| 适合 | 单个开发者按需调模 | 团队/部署统一模型口径，避免 Agent 乱选模型 |

> 档位模式约束的是 **Agent 的工具面**；你在 GUI 模型选择器里的手动切换不受限制（DSH 未提供拦截用户切模的插件接口），可作为人工兜底通道。两种模式都不影响 GUI 的既有行为。

## 模型策略提示词

配置 `policyPrompt` 会作为 `## Model policy` 段落写进系统提示词（自由模式只写这段话；档位模式自动追加档位清单）：

```yaml
policyPrompt: |
  规划与疑难排查一律先切 deep；日常实现、改文件、跑测试用 daily。
```

档位模式下 Agent 实际看到的（由 `presets` 的 `id`/`name`/`when` 自动生成，无需手写）：

```
## Model policy

规划与疑难排查一律先切 deep；日常实现、改文件、跑测试用 daily。

本部署只允许在下列模型档位之间切换；进入对应阶段时调用 switch_preset 换档：

- **daily（日常执行）** — deepseek/deepseek-chat · reasoning low — 适用：常规实现、修改、测试
- **deep（深度攻坚）** — deepseek/deepseek-reasoner · reasoning max — 适用：疑难排查、架构设计
```

未配置任何策略时段落为空，不会在提示词里留下痕迹。

## 模型看到什么

插件通过 `systemPrompt.context` 在每个 step 的 Runtime Context 快照尾部注入一行当前活跃模型（cache-safe 追加，模型随时自查、无需调用工具）：

```
[Current active model: deepseek/deepseek-chat · reasoning: low · preset: daily]
```

处于 Plan 模式时附带状态标记：

```
[Current active model: deepseek/deepseek-reasoner · reasoning: max · preset: deep] [Plan Mode Active]
```

`preset: xx` 仅在当前模型命中某个档位时出现。

## 工具

### set_model（自由模式）

`set_model({ provider?, model?, reasoningEffort?, reason })` —— `reason` 必填（每次切换都会使会话 KV cache 失效，工具说明要求 Agent 给出理由、避免频繁切换）：

```json
{ "model": "deepseek-reasoner", "reasoningEffort": "high", "reason": "疑难并发问题排查，需要深度推理" }
```

### list_models（自由模式）

`list_models({ provider? })` 列出已注册 Providers 与模型能力（推理档位、上下文窗口）：

```
# Available Providers & Models:

## Provider: deepseek
- **deepseek-reasoner** (DeepSeek Reasoner) | Reasoning: [low, high, max] | Context: 128000
- **deepseek-chat** (DeepSeek Chat) | Context: 128000
```

### switch_preset（档位模式）

`switch_preset({ preset, reason })` —— `preset` 是配置里的档位 id，`reason` 必填；id 不存在时返回可用档位清单：

```
Model preset switched to deep (深度攻坚) — deepseek/deepseek-reasoner · reasoning: max. Effective from the next step.
Reason: 疑难并发问题排查，需要深度推理
```

### list_presets（档位模式）

`list_presets({})` 列出允许的档位、各自适用阶段与当前生效档位：

```
# Model presets

Mode: preset · Plan Mode active
Current: deepseek/deepseek-reasoner · reasoning max · preset deep

- **daily（日常执行）** — deepseek/deepseek-chat · reasoning low — 适用：常规实现、修改、测试
- **deep（深度攻坚）** — deepseek/deepseek-reasoner · reasoning max — 适用：疑难排查、架构设计 ← current
```

切换自下一个 step 生效：插件向会话写入 `model/selection` 事件（与 GUI 模型选择器同一机制），Web UI 状态同步。

## Plan 模式自动升降级

插件监听 `agent/pre-step` 的 Plan 投影状态变迁，零人工干预：

- **进入 Plan 模式**（`/plan on`）：暂存当前模型，自动切换——自由模式切到 `planModel`，档位模式切到 `planPreset` 指定的档位；
- **退出 Plan 模式**（`exit_plan_mode` 批准 / `/plan off`）：自动恢复进入前的模型（`autoRestorePlanModel`，默认开启）；
- 自动切换失败仅 warn 降级，绝不打断 step。

## 安全护栏

- **Provider 白名单**：`allowedProviders` 非空时，白名单外的切换请求直接拒绝；档位模式下它同时约束档位（白名单外的档位会在加载时被丢弃并记录错误日志）；
- **上下文窗口护栏**：当前会话 token 水位超过目标模型 contextWindow 时拒绝切换，并提示先压缩上下文（如 clear_mind）：

  ```
  Current session token pressure (70000 tokens) exceeds target model context window (65536 tokens).
  Please compact context (e.g. clear_mind) before switching to this model.
  ```

- **路由校验**：候选组合经 DSH 核心 `ctx.llm.resolveCallConfig` 校验（provider 适配器存在、模型合法、reasoningEffort 受支持），非法组合返回明确错误，不写入任何会话状态；
- **配置诊断不致命**：重复档位 id、缺 provider/model、`planPreset` 指向不存在的档位等会写入宿主日志（`dsh-set-model: ...`）并跳过该条，插件照常加载——配置错误不会拖垮整棵插件树；
- **仅根 Agent**：工具只注册给根 Agent（subagent 不提供自主调模）；`enableAgentTools: false` 可整体关闭。

## 设置界面

插件自带 Web 设置页「模型档位」（设置 → 模型档位），可可视化维护：

- 模式切换（自由 / 档位）；
- 档位表增删排序，provider / model / 思考强度均为下拉选择（数据取自当前模型目录），附 `id`、显示名、适用阶段；
- 策略提示词、Plan 目标（档位或模型）、`autoRestorePlanModel`、`enableAgentTools`、`allowedProviders`。

保存后宿主即时重新应用插件配置，无需重启。字段需标记为 `volatile` 才会出现在设置表单里（DSH 设置系统的约定）。

## 配置

Settings 命名空间为插件在 profile 里的 loader entry id：**`set-model`**（Web Settings UI 可视化配置，改动运行时动态生效）。

```yaml
# profile 的 cordis.patch.yml（或设置页写入的用户层）
- id: set-model
  name: dsh-set-model
  config:
    mode: preset                  # free（默认）| preset
    presets:                      # 档位模式必填且非空
      - id: daily                 # 稳定标识，Agent 用它切换
        name: 日常执行             # 展示名，缺省用 id
        when: 常规实现、修改、测试  # 适用阶段，写进策略清单
        provider: deepseek
        model: deepseek-chat
        reasoningEffort: low      # off | low | high | max，缺省跟随模型默认
      - id: deep
        name: 深度攻坚
        when: 疑难排查、架构设计
        provider: deepseek
        model: deepseek-reasoner
        reasoningEffort: max
    policyPrompt: |               # 可选：附加策略说明（两种模式都生效）
      线上事故排查一律先切 deep。
    planPreset: deep              # 档位模式：进入 Plan 模式使用的档位 id
    planModel:                    # 自由模式：进入 Plan 模式使用的模型
      provider: deepseek
      model: deepseek-reasoner
      reasoningEffort: high
    autoRestorePlanModel: true    # 退出 Plan 模式自动恢复（默认 true）
    enableAgentTools: true        # 是否注册调模工具（默认 true）
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

- **零直接副作用**：无外部服务、无插件自身网络请求（模型路由与能力查询均经由 DSH 核心 `llm` 服务）、无直接文件系统写入；仅通过会话事件 API 写入 `model/selection` 事件（由 DSH 会话系统落盘）并注入一行 Runtime Context 与一段系统提示词
- **浏览器半**：设置页以 `lib/client.js`（构建产物）注册 `settings.section`，仅调用 DSH 的 `remote.settings` / `remote.session` RPC，不发起自有网络请求
- **宿主版本要求**：DSH `^0.1.7-rc.2 || ^0.2.0-rc.1`（0.1.2~0.1.6 会得到明确的"插件与 dsh 版本不兼容"安装提示，请升级 DSH）
- **依赖声明**：DSH 运行时包（`cordis`、`dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-tools`，以及可选的 `dsh-settings`）全部声明为 `peerDependencies`——DSH 的模块解析层据此把插件内的 `@deepseek-ai/*` import 路由到**宿主自带副本**，插件绝不携带、也不 hoist 这些包的副本；唯一运行时依赖是纯 schema 库 `@deepseek-ai/schemastery`（`react` / `esbuild` / `@types/react` 只用于构建浏览器半，运行时由 Web 壳提供 React）。Node ≥ 22.5
- **失败降级**：Plan 模式自动切换失败只 warn 不打断 step；工具校验失败向 Agent 返回明确错误，不污染会话状态；设置页挂载失败只 console.error，不拖垮 GUI

## 本地开发

```bash
npm install
npm run check     # tsc(宿主) + tsc(浏览器半)
npm test          # tsc(含 test) + node --test dist/test/*.test.js
npm run build     # tsc → dist/src，esbuild → lib/client.js
npm run build:client   # 只重建浏览器半
```

需要图形界面验证时用 dsh-e2e 最小实例（见 `scripts/dev-worktree.sh`）：

```bash
dsh-e2e start --wait-ready --patch e2e/fixture/cordis.patch.yml
dsh-e2e run e2e/verify-policy-page.mjs
```

e2e 的种子配置在 `e2e/fixture/cordis.patch.yml`（档位、Plan 目标与策略提示词的样例值），启动时通过 `--patch` 注入；playwright / camoufox 路径可用 `DSH_E2E_PLAYWRIGHT` / `DSH_E2E_BROWSER` 覆盖。

浏览器半改完务必重建 `lib/client.js` 并跑一次 `node --check lib/client.js`（构建脚本内已内置）。

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
