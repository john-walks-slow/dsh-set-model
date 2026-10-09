# 检视报告：261009-model-policy（模型策略）

> 检视对象：worktree `.worktrees/model-policy`（分支 `feat/model-policy`，基线 d86583a）全部未提交改动
> 检视方式：静态阅读 + 平台 API（`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`）源码核对；未运行构建、测试与 e2e

## 概要

需求切分清楚、模块边界（`config` / `presets` / `tools` / `controller` / `client`）合理，文档与测试布局完整，`installSection` 死代码与命名空间 `set-model` 的修正方向正确。

但插件读取配置的方式与 DSH 的 volatile 机制不符：Config 全字段标 `.volatile()` 后，`apply()` 拿到的是引用对象而非普通值，而 `resolveConfig()` 按普通值读取；同时「loader 每次设置变更都会重新 apply」的假设在全 volatile 配置下不成立。两者叠加使**新功能在生产环境完全失效，并回归了既有 `planModel` / `allowedProviders` 行为**。单测全绿是因为 mock 直接喂普通对象，真实路径未被覆盖。

## 需求对齐

- 与 `261009-model-policy.plan.md` §3–§8 基本一致：策略段落（order 550）、工具按 mode 二选一、`planPreset` / `planModel` 分流、命名空间修正、浏览器半 + 构建脚本 + e2e、双语文档均已落地。偏离项仅实现细节（客户端 section `order: 132`，plan 写 130，无实质影响）。
- **plan §2.1「改动即时生效（settings 为 live），无需重启 dsh」与 §11「未配置任何新项时行为与升级前完全一致」在当前实现下均不成立**（见阻塞 B1 / B2）。
- plan §10 的 e2e 清单第 4 项「一次真实会话中 Agent 调用 `switch_preset` 成功且下一 step 生效」未自动化；`validation.md` 已如实标为需用户实机确认，可接受，但不应在总结中算作已覆盖。
- 未发现范围蔓延或与调研结论冲突的设计；「档位模式只约束 Agent、不拦截 GUI 切模」的边界在 README / AGENTS 中说明到位。

## 阻塞问题

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| B1 | `src/config.ts:83,88,93,98,106,111,116`（Config 字段 `.volatile()`）、`src/config.ts:35-37`（planModel 内层新增 volatile）、`src/config.ts:221-256`（`resolveConfig`）、`src/index.ts:53` | **把 Volatile 引用当普通值读，导致新功能完全不生效，且回归既有行为。** cordis 传给 `apply(ctx, config)` 的 config 是 schemastery 校验结果：`Fiber._reload` → `_resolveConfig` → `runtime.Config["~standard"].validate()` → `Schema.resolve()`，对每个 `meta.volatile` 节点用 cosmokit `createVolatile()` 包成 `{ get(), [write] }` 冻结对象。因此 `resolveConfig(initialConfig)` 的所有类型判断都落空：<br>· `source.mode === "preset"` 恒 false → **档位模式永不生效**（`config.ts:228`）<br>· `Array.isArray(source.presets)` 恒 false → `presets` 恒 `[]`（`config.ts:174,229`）<br>· `typeof source.policyPrompt === "string"` 恒 false → **策略段落恒为空**（`config.ts:249`）<br>· `planPreset` 恒 `undefined`（`config.ts:231`）<br>· `planModel` 内层也是 volatile → `text(candidate.provider)` 得 `""` → 恒被丢弃并打 error 日志（`config.ts:160-171`）→ **既有 Plan 自动切模回归**<br>· `autoRestorePlanModel` / `enableAgentTools` / `allowedProviders` 恒落默认值 → `enableAgentTools: false` 失效、**Provider 白名单静默失效**（`config.ts:225-227,252-254`）<br>证据链：`dsh-settings/lib/types/schema.js` 的 `plainConfig()` 专门 unwrap 引用；平台插件 `dsh-agent-default-model/lib/index.js:32` 读 `this.config.provider.get()`；同作者已上线的 `dsh-clear-mind/src/index.ts:56-77` 对每个 volatile 字段显式 `.get()`。<br>单测未发现的原因：`test/helpers.ts:144` 的 mock 与 `test/plugin.test.ts` 直接传普通对象，未经 schemastery 校验。 | 按「引用 → 值」的规范读写：`resolveConfig` 先对每个字段做 `isVolatile(v) ? v.get() : v` 解包（可在 `config.ts` 内封装 `unwrap()`）；并在单测里用 schemastery 的真实校验结果作为 `apply` 入参（例如 `Config["~standard"].validate(raw).value`），把引用路径纳入回归。 |
| B2 | `src/index.ts:51-53`（注释与 `const currentConfig`）、`src/index.ts:69-73,82,92-106,145` | **「设置变更会重新 apply」的假设在全 volatile 配置下不成立，热生效链路是断的。** `cordis-plugin-loader` 的 `Entry.update` 在判定 `volatileOnly`（`equalExceptVolatile` 认为两次 config 只在 volatile 路径上不同）时走 `_commitVolatile()`，**原地更新引用、不重启 fiber**。由于本插件 Config 的所有字段都是 volatile，任何设置页保存都满足该条件 → `apply` 不会重跑，闭包里的 `currentConfig` 永远是首次加载时的快照（即便修好 B1 也一样）。直接后果：保存后提示词、档位清单、Plan 目标、工具集都不会变；用户看到「已保存并热生效」但实际要重启 dsh 才生效。`src/index.ts:51-53` 的注释、README.md:147 / README.en.md:147 的说明、面板的「已保存并热生效」文案均基于该错误假设。 | 区分两类字段（可参考 `dsh-clear-mind` 的做法）：<br>· **数据字段**（`presets` / `policyPrompt` / `planPreset` / `planModel`、`allowedProviders`）改为「保留引用、使用时 `.get()` 实时取值」，不要做 apply 期快照；<br>· **结构字段**（`mode`、`enableAgentTools`）会改变「注册哪套工具」，需要在 `ctx.on("loader/volatile-update", …)` 里用 `ctx.tools.register()` 返回的 disposer 换掉工具集（`dsh-tools` 的 `register` 返回卸载函数），否则切模式必须重启 dsh；<br>· 若不愿处理结构变更，就接受「切模式需重启」并同步修正注释 / README / 面板文案与 e2e 声明。 |

## 建议修改

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| S1 | `src/index.ts:63-65` | `settings.configure({ auto: false })` 未传 `owner`，也未注册 disposer。`SettingsForms.configure(presentation, owner = this.ctx.fiber)` 的默认 owner 是**调用点所在的 ctx**——这里处在 `ctx.inject(["settings"], …)` 创建的子 fiber 中，于是策略被记在子 fiber 名下；而 `describe()` 取的是 `presentations.get(entry.fiber)?.auto ?? true`（`dsh-settings/lib/index.js`），即 loader entry 的 fiber，两者不同 → `auto: false` 不生效，且注册项从不释放（`presentations` 是 `Map`，键是 fiber，会随每次重载累积）。 | 用平台与同作者插件的既有写法一次改到位：恢复 `import type {} from "@deepseek-ai/dsh-settings"`（diff 中删掉的类型增强），改为 `ctx.inject(["settings"], (settingsCtx) => { settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber)); });`（`dsh-clear-mind/src/index.ts:136-138` 即此形态）。同时：0.2.0-rc.2 的客户端 bundle 里没有任何代码读取 `autoGenerate`（全量 grep 仅命中 host 侧与 remote 编解码），因此「自动生成的配置页已关闭」很可能并未真正生效（Plugins 页仍会为 `set-model` 渲染一份生成表单）——请实机确认后二者取一：修好该调用，或删除该调用与 README 中的表述。 |
| S2 | `src/client/panel.tsx:120-132`、`164-193`（尤其 185-193） | 自由模式下「Plan 目标」未填时 `readRow(undefined)` 得到三个空串，`buildOps` 仍 `set planModel = { provider: "", model: "" }`，且 `validate()`（135-150）只校验档位模式。结果是首次打开设置页保存一次，就把一份非法 `planModel` 写进 profile：插件加载时打 `planModel: provider and model are both required; ignoring it`，页面却提示「已保存并热生效」。 | 读取时对缺失的 `planModel` 用默认值兜底（或保留「未配置」状态）；写入时 provider/model 为空则 `unset`，并把这一校验并入 `validate()`。 |
| S3 | `src/presets.ts:53-64` + `src/index.ts:97-105` | `enableAgentTools: false` 时仍不注册任何工具，但档位模式的策略段落仍写「进入对应阶段时调用 switch_preset 换档」，提示词要求调用一个不存在的工具。 | `renderModelPolicySection` 接收 `enableAgentTools`，为 false 时改写成「由用户决定档位」之类的表述，或改用不提及工具名的措辞。 |
| S4 | `src/tools.ts:389-405` vs `src/presets.ts:37-46` | `list_presets` 的 render 把 `formatPreset` 的标签/强度/适用阶段拼装逻辑又抄了一遍（仅多了 `← current`），两处文案今后必然漂移。 | render 里复用 `formatPreset(preset)`，再追加当前标记。 |
| S5 | `src/client/panel.tsx:391` | `mutate(NS, ops, undefined)` 放弃 revision 栅栏；plan §7.2 要求回传 revision，平台自身的表单（`ConfigFormController`）都带 revision，否则并发写入静默覆盖。 | 把 `describe()` 读到的 `source.revision` 存进 state，保存时传给 `mutate`，冲突时给出可读提示。 |
| S6 | `src/config.ts:236-238` | 自由模式 + 保留档位表时每次都 `logger.error`（面板在自由模式下也会保留 `presets`，用户切模式就会持续刷错误日志）。这是提示而非错误。 | 降为 `logger.warn`，或仅在 preset 模式无档位时保留 error 级别。 |

## 非阻塞问题

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| N1 | `src/tools.ts:15-20` | `requireAgent()` 的报错文案固定写 `set_model:`，但 `switch_preset` / `list_presets` 共用它，诊断会指错工具。 | 改为把工具名作参数传入，或写成中性文案。 |
| N2 | `src/client/index.ts:53`、`src/client/panel.tsx` 全文 | 界面文案（导航名「模型档位」、字段标签、提示）硬编码中文，未使用客户端 locale 服务；而工具描述与策略段落是英文。切到英文 locale 的用户会看到中英混排。 | 若坚持中文 UI，至少在接受范围内；否则按平台惯例 `ctx.locale.register(NS, { zh, en })` + `label: () => t("nav")`。 |
| N3 | `src/client/panel.tsx:414-429` | 两个 `<input type="radio">` 没有共享 `name` 属性，键盘方向键无法在两者间切换，屏幕阅读器会当成两个独立分组。 | 补 `name="mode"`。 |
| N4 | `src/client/panel.tsx:626`、`194-234` | 内联样式未复用 design token / 平台组件：成功/失败色写死 `#4caf7d` / `#e06666`，分隔线用 `rgba(128,128,128,.4)`（后者能自适应明暗，前者在亮色主题下对比度偏弱）；也未使用 `dsh-client-ui-primitives`。小屏布局（`repeat(auto-fit, minmax(150px,1fr))` + `maxWidth: 860px`）本身没问题。 | 颜色改用主题变量或深浅自适应的语义色；若介意体积可继续保持零依赖，但至少让状态色适配主题。 |
| N5 | `src/client/panel.tsx:552-585` vs `318-376` | Plan 目标的 provider/model 是自由文本输入，而档位表里是下拉选择（同一份数据、两套交互）；plan §2.1 的「无需手打 ID」在 Plan 目标处没有兑现。 | 复用 `renderRoute` 的下拉（档位模式下 `planPreset` 已经是下拉，自由模式可对齐）。 |
| N6 | `package.json:9,15`、`.gitignore` | `lib/client.js` 是构建产物且未被 gitignore（`dist/` 已忽略），`files` 含 `lib`，`prepare` 会在打包/安装时重建。是否入库需要明确：不入库则新克隆 + `link:` 本地安装必须先 `npm run build`（README「本地开发」已写，但没有点明「否则 Web 端加载不到客户端半」）。 | 二选一并写清：要么把 `lib/` 加入 `.gitignore` 并在 README 强调构建步骤；要么提交产物。避免 `git add -A` 时无意中提交或漏提交。 |
| N7 | `docs/features/261009-model-policy/261009-model-policy.settings.png` 与 `assets/model-policy-settings.png` | 两份同尺寸截图重复（前者未被任何文档引用）。 | 只保留 `assets/` 下那份，删掉重复文件。 |
| N8 | 仓库根目录 | 缺少发布生态要求的 `screenshots.json`（市场详情页截图清单），README 的截图不会进入市场详情页。 | 发布前按 `dev-dsh-plugin` 的 publish checklist 补上。 |

## 准入结论

**结论**：`不准入`

**说明**：存在 2 个阻塞问题——配置读取未解包 Volatile 引用（B1，功能整体失效且回归 `planModel` / `allowedProviders`），以及全 volatile 配置下 `apply` 不会重跑导致热生效链路断裂（B2）。二者都不改变单测与 e2e 的结论，因此当前「25/25 + e2e 14/14 通过」的绿灯不能作为准入依据；修复后需补一个以 schemastery 真实校验结果为入参的单测，以及一次「保存后不重启 dsh 即生效」的实机确认，再重新检视。
