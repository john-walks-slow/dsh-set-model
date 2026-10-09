# 检视报告：261009-model-policy（模型策略）· 第二轮

> 检视对象：worktree `.worktrees/model-policy`（分支 `feat/model-policy`，基线 d86583a）全部未提交改动
> 检视方式：静态阅读全部改动 + 平台源码核对（`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`：`cordis`、`cordis-plugin-loader`、`schemastery`、`cosmokit`、`dsh-settings`、`dsh-app-boot`、`dsh-config-editor`、`dsh-tools`、`dsh-system-prompt`、`dsh-client-ui-*`）。**未运行**构建、单测与 e2e
> 上一轮报告（结论：不准入）已移存为 [261009-model-policy.review.round1.md](261009-model-policy.review.round1.md)

## 概要

第二轮按「修复是否真正成立」的方式复核了全部实现，而非只看改动点：两个阻塞问题**均已真正修复**，且修法与平台机制一致（详见下方逐条证据）。新增的 `SetModelLiveConfig` / `snapshotConfig` 解包层、`loader/volatile-update` 驱动的工具集重建、`liveConfig()` 真实校验夹具都是正确方向。剩余问题均为非阻塞性质：自由模式 Plan 目标的半填状态仍会静默失效、模式切换遗留字段会刷错误日志、e2e 依赖未入库的 fixture。

## 需求对齐

与 `261009-model-policy.plan.md` §3–§8 一致：策略段落（order 550）、工具按 mode 二选一、`planPreset` / `planModel` 分流、命名空间 `set-model`、浏览器半 + 构建脚本 + e2e、双语文档均已落地。偏离仅实现细节（section `order: 132`，plan 写 130，无实质影响）。

- plan §2.1「改动即时生效（settings 为 live），无需重启 dsh」与 §11「未配置任何新项时行为与升级前一致」——**本轮成立**（依据见 B1/B2 复核）。
- plan §10 的两项仍无自动化覆盖：上下文行出现 `preset: xx`（无单测，mock 的 `systemPrompt.context` 是空实现）、e2e 中「真实会话里 Agent 调 `switch_preset` 生效」。`validation.md:47` 已如实标注后者，可接受；前者在总结中不应算作已覆盖。
- 未发现范围蔓延、过度设计或与调研结论冲突的设计。文档边界（档位模式只约束 Agent 的工具面）在 README / AGENTS 中说明到位。

## 上一轮阻塞问题的复核结论

**B1（把 Volatile 引用当普通值读）——已修复，成立。**

- `src/config.ts:159-182` 导出 `SetModelLiveConfig`（每字段 `Volatile<T>`）与 `snapshotConfig()`，逐字段 `.get()` 后交给 `resolveConfig`；`src/index.ts:59` 每次使用取快照（`current()`），四个工具工厂签名为 `(ctx, live: () => ResolvedSetModelConfig)`（`src/tools.ts:42,154,234,348`），并在 `execute` 内 `live()`（`tools.ts:112,224,304,410`）。
- 平台侧核对：`cordis/lib/index.js:956-962` 的 `resolveConfig` = `Config["~standard"].validate(config).value`；`schemastery/lib/index.mjs:265-277` 对 `meta.volatile` 节点返回 `createVolatile(value)`（缺省字段亦然，`.get()` 得 `undefined`）；同源插件 `dsh-experimental-speech-to-text/lib/index.js:111-112` 正是 `this.config.defaultProvider.get()` 的写法。修复方向与平台 canonical 一致。
- `planModel` 由「内层字段 volatile」改为「整对象 volatile」是必需的：`schemastery/lib/index.mjs:246` 明确禁止 volatile 嵌套在 volatile 内；且 `cosmokit` 的 `volatileEntries()` 不深入引用内部，若保留旧形状，`cordis-plugin-loader/lib/index.js:408-413` 的 `path.reduce(...)` 会取到 `undefined` 再 `.get()` 而抛错。
- 测试夹具 `test/helpers.ts:16-26` 用真实 `Config["~standard"].validate()` 构造，volatile 形状与线上一致——第一轮「单测全绿但真实路径未覆盖」的问题已消除。

**B2（全 volatile 时 loader 走 `_commitVolatile`，`apply` 不重跑）——已修复，成立。**

- 复核链路：`dsh-config-editor/lib/index.js:125-131` 写 profile patch → `dsh-app-boot/lib/index.js:3468-3485` 的 `reconcileProfilePatches()` → 根 Include entry `update()` → 子 entry `Entry.update()`；`cordis-plugin-loader/lib/index.js:380-382` 判定 `volatileOnly`（`equalExceptVolatile` 对 volatile 路径一律视为相等，故本插件恒成立）→ `_commitVolatile()` 原地 `updateVolatile()` 并 `fiber.ctx.emit(self, "loader/volatile-update", paths)`（同文件 414-421）。`fiber.config` 保留引用（`_reload` 里 `this.config = this._resolveConfig(this._config)`，`cordis/lib/index.js:1355`），因此提交可生效。
- 事件可达性：`cordis/lib/index.js:262-263` 用 `thisArg[Context.filter]`（loader 设为 `owner.fiber === fiber`）过滤监听器；`hook.ctx` 是注册时的插件 ctx（`events` 服务的 traceable 代理把 `.ctx` 解析为访问方 ctx，`cordis/lib/index.js:127,232,679,890-893`），故 `src/index.ts:130` 注册的监听器会被调用。平台上 `dsh-llm-pi-ai/lib/index.js:2628` 与 `dsh-experimental-speech-to-text/lib/index.js:21` 用同一模式，属既有实践。
- `ctx.tools.register()` 确实返回精确的卸载函数（`dsh-tools/lib/types/index.d.ts:634-636`），`WeakMap<Agent, disposer[]>` 的换装写法成立；`test/plugin.test.ts:101-135` 用 cosmokit 的 `updateVolatile` 模拟提交，覆盖了「换模式」「关工具」两条路径。
- 提示词侧同步成立：`section.text` 允许函数且每次装配调用（`dsh-system-prompt/lib/types/index.d.ts:60`、`lib/index.js:342`），`renderModelPolicySection(current())` 因此随配置实时变化；空文本会被丢弃。
- e2e 的间接证据：`e2e/verify-policy-page.mjs:120-127` 刷新页面后 `describe().value`（= `plainConfig(entry.fiber.config)`，`dsh-settings/lib/index.js:437`）读到改写后的档位名，说明真实宿主里引用确实被原地提交过。

## 阻塞问题

无。

## 建议修改

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| R1 | `src/client/panel.tsx:135-150`（`validate`）、`164-201`（`buildOps`），配合 `src/config.ts:195-208` | **自由模式「Plan 目标」的半填状态仍会静默失效。** S2 只修了「provider 与 model 都为空就 unset」；若用户只填了其中一个（例如填了 provider 没选 model），`buildOps:185-198` 仍会写入 `{provider: "x", model: ""}`，页面提示「已保存并热生效」，而宿主侧 `normalizePlanModel` 判定非法、整条丢弃（`config.ts:202-205` 仅落一条宿主日志）。从 GUI 看不到任何异常，Plan 模式却不切模型。 | 把「要么都填、要么都不填」并入 `validate()`（自由模式不再直接 `return undefined`）；或在 `buildOps` 里对只填一半的情况直接拒绝保存并给出提示。 |
| R2 | `src/config.ts:276-278`、`src/client/panel.tsx:181-199`、`src/index.ts:61-65` | **合法配置组合被记为 error，且每次保存都刷日志。** 面板在切到档位模式时保留 `planModel`（不 unset），于是 `problems` 里的 `planModel is ignored in preset mode; declare planPreset instead` 会在每次加载与每次保存时被 `ctx.logger.error` 打一遍。反向亦然：自由模式下保留 `planPreset`、之后清空档位表，就会持续报 `planPreset ... matches no declared preset`。这两条都是"用户按面板操作必然产生"的状态，不是错误。 | 二者取一：(a) 切模式时 unset 另一种模式的目标字段（preset 侧同时清 `planPreset`），让 `problems` 只剩真错误；(b) 把提示类诊断降为 `logger.warn`，仅 `mode: preset` 却无可用档位这类硬错误保持 error。 |
| R3 | `e2e/verify-policy-page.mjs:94-99,120-127`、`.gitignore:7` | **e2e 的前置 fixture 未入库，18/18 无法在别的机器/新克隆上复现。** 脚本断言 `presetIds === "daily,deep"`、`preset mode is the live mode`，这些来自 `.dsh-e2e-home/profiles/web/cordis.patch.yml` 里手写的 `mode: preset` + 两条档位 + `planPreset: deep`；而 `.dsh-e2e-home/` 被 gitignore。同时脚本第 7 行硬编码 `/root/projects/camoufox-mcp/node_modules/playwright-core/index.js`。 | 把种子 patch 提交为 `e2e/fixture/cordis.patch.yml`（并在 `validation.md` 写明 `dsh-e2e start` 前如何落到实例 home），playwright 路径改为环境变量或本地依赖解析。 |

## 非阻塞问题

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| N1 | `src/tools.ts:15-20` | `requireAgent()` 报错文案硬编码 `set_model:`，`switch_preset` / `list_presets` 共用它，诊断会指错工具（第一轮 N1，未处理）。 | 把工具名作参数传入或改成中性文案。 |
| N2 | `src/index.ts:68-73`、`docs/.../261009-model-policy.summary.md:40` | 注释声称 `settings.configure({ auto: false })` "suppress the schema-generated one"，但 0.2.0-rc.2 客户端没有任何 `autoGenerate` 读取方（全仓 grep 仅命中 host 侧 `dsh-settings` 与 remote 编解码；`dsh-client-ui-plugin-manager` 的表单只对 `plugins.row.config` 声明的行渲染，本插件未声明）。summary 已如实记录「看不到可见差异」，代码注释未同步。**该结论未在真实 GUI 上确认**（本轮未跑 e2e）。 | 注释改为「按平台约定声明页策略；当前客户端版本无消费者」，或实机确认后直接删掉该调用与其对 `dsh-settings` 的依赖。 |
| N3 | `src/client/index.ts:53`、`src/client/panel.tsx` 全文；`panel.tsx:444-461` | UI 文案（导航名「模型档位」、字段标签、提示）硬编码中文，未走 `ctx.locale`，与英文 locale 的 shell 混排（第一轮 N2）；两个 `<input type="radio">` 未共享 `name`，方向键无法在两模式间切换、读屏会当成两组（第一轮 N3）。 | 按平台惯例接 locale 服务；两个 radio 补 `name="mode"`。 |
| N4 | `src/client/panel.tsx:653`、`203-243` | 状态色写死 `#4caf7d` / `#e06666`，未使用主题变量或 `dsh-client-ui-primitives`，亮色主题下对比度偏弱（第一轮 N4）。小屏布局（`repeat(auto-fit, minmax(150px,1fr))`）本身没问题。 | 状态色改用主题/语义色变量。 |
| N5 | `src/client/panel.tsx:586-600` | 自由模式「Plan 目标」的 provider/model 是自由文本，档位表里却是下拉选择（同一份数据两套交互），plan §2.1「无需手打 ID」在此处未兑现（第一轮 N5）。 | 复用 `renderRoute` 的下拉。 |
| N6 | `src/client/panel.tsx:310-317` | `void remote.session?.modelCatalog().then(...)`：`.catch()` 只兜 Promise 拒绝，若 `modelCatalog()` **同步**抛错会冒泡出 `useEffect`（React 渲染期错误），而 describe 分支是有 `try/catch` 语义的。 | 用 `Promise.resolve().then(() => remote.session?.modelCatalog())` 或在 effect 内包 try/catch。 |
| N7 | 仓库根目录、`docs/.../261009-model-policy.summary.md:23` | 缺少发布生态要求的 `screenshots.json`（第一轮 N8）；`summary.md` 表格写「共 25 例」而实际 28 例（`npm test` 计数为 8+3+1+5+5+6）。 | 发布前补 `screenshots.json`；顺手把 25 改成 28。 |
| N8 | `test/` 全量 | plan §10 的「上下文行在命中档位时出现 `preset: xx`」无单测覆盖（`test/helpers.ts:154-161` 的 `systemPrompt.context` 是空实现，回调从未执行），而 `preset: xx` 正是 `matchPreset` 与渲染拼接的组合行为（`src/index.ts:84-97`）。 | 让 mock 记录并调用 `context.text(...)`，补一条断言。 |

## 准入结论

**结论**：`条件准入`

**说明**：两个阻塞问题（volatile 引用读取、全 volatile 下 `apply` 不重跑导致热生效断裂）均已按平台 canonical 方式修复，并经平台源码逐点复核成立；`liveConfig()` 真实校验夹具补上了第一轮的测试盲区。剩余问题都不影响交付正确性，建议在合并前处理 R1（半填 `planModel` 静默失效）与 R3（e2e fixture 入库），R2 可随后续迭代一并清掉。

> 说明：本轮报告写入 `261009-model-policy.review.md`，上一轮报告原文已保留在 [261009-model-policy.review.round1.md](261009-model-policy.review.round1.md)；`summary.md:44` 中「第一轮检视报告见 review.md」的链接需同步改指该文件。
