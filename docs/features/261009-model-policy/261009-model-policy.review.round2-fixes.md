# 检视报告：261009-model-policy · 第二轮建议复核（c6fc4e7）

> 检视对象：worktree `.worktrees/model-policy`（分支 `feat/model-policy`）提交 `c6fc4e7`
> 检视方式：**静态阅读 + 平台源码核对**（`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`：`schemastery`、`cosmokit`、`cordis`、`cordis-plugin-loader`、`dsh-settings`、`dsh-app-boot`、`dsh-config-editor`、`dsh-tools`、`dsh-system-prompt`、`dsh/lib/bin.js`）；另读取了运行中 e2e 实例的 home 文件作为旁证。**未**改代码、**未**跑构建/单测/e2e
> 前序报告：[review.round1.md](261009-model-policy.review.round1.md)（第一轮，不准入）、[review.md](261009-model-policy.review.md)（第二轮，条件准入）

## 概要

五项待核对的内容我逐条复核过，**全部成立**，且 R1 的修复是可验证的闭环（页面 `validate()` 拦在 `mutate` 之前，宿主 `normalizePlanModel` 的整条丢弃路径从此不可达）。R3 的平台结论我也独立验证了：`--patch` 覆盖层与会话内可写层的分界确实是 `dsh-config-editor/lib/index.js:122` 那条 composition 判定，播种 profile 用户层是 canonical 选择。另有一处关于「假绿根因」的机制性澄清（见 §3），以及 4 条非阻塞建议。

## 逐项复核

### 1. R1（自由模式 Plan 目标半填）——**成立**

- `src/client/panel.tsx:135-145`：`validate()` 在 `state.mode !== "preset"` 分支里比较 `hasProvider !== hasModel`，不等即返回「自由模式的 Plan 目标需要同时填写 provider 与 model，或两者都留空。」。
- 拦截点在写入之前：`save()`（`panel.tsx:415-423`）先 `const problem = validate(state)`，非空则 `setMessage({kind:"err"})` 直接 return，**不调用** `mutate`；`buildOps` 的 `unset`/`set` 分支未变（`panel.tsx:188-211`）。
- 因此「页面说已保存、宿主整条丢弃」不再可达：宿主侧 `normalizePlanModel`（`src/config.ts:197-210`）只在 `provider === "" || model === ""` 且二者不同时为空时才忽略；该输入组合已被页面拦下。面板里该字段可清空，所以用户不会被错误配置锁死（单向门不存在）。
- 残留（见非阻塞 N2）：只选了「思考强度」而 provider/model 都空时，`buildOps` 走 `unset planModel`，用户选的 effort 被静默丢弃（提示为成功）。
- `modelCatalog()` 兜底复核：`panel.tsx:317-324` 改为 `void Promise.resolve().then(() => remote.session?.modelCatalog()).then(res => { if (res?.ok …) }).catch(() => {})` —— 同步抛错被 Promise 链接住、`remote.session` 缺失时 `res` 为 `undefined` 已被 `res?.ok` 覆盖、拉取失败仍静默降级（下拉退化为「当前值」选项）。**未引入新问题。**

### 2. R2（error / warn 划分）——**成立，但有一条同源漏项**

- `src/config.ts:147-150` 新增 `warnings`（注释明确「Legitimate but worth saying out loud」），`resolveConfig` 里 `planModel is unused in preset mode` 移入 `warnings`（`config.ts:279-281`），`src/index.ts:61-67` 分两路 `logger.error` / `logger.warn`。`test/config.test.ts:109` 有断言。语义与「error = 该条配置被废弃/不可用；warn = 合法但有话要说」一致。
- 逐条过一遍现有 `problems`：`presets[i] 非对象` / `缺 id|provider|model` / `重复 id` / `provider 越白名单` 都是**整条丢弃** → error ✓；`mode=preset 但无可用档位` → 功能不可用 → error ✓；`planPreset 指向不存在的档位` → Plan 联动不可用 → error ✓（**但缺 mode 判断，见建议 R1**）。
- 边界一处值得再定夺：`normalizeEffort`（`config.ts:190-195`）的 `unknown reasoningEffort "x"; falling back to the model default` 并**不丢弃**该档位（只是退回模型默认），按你的判据更像 warn。属口味问题，列入非阻塞 N1。
- 未发现「该降级却仍是 error」的其它项（除 R1 那条）。

### 3. R3 —— **结论成立、做法 canonical；机制描述需订正一处**

**(a) 用户层 vs 覆盖层就是「可写 / 不可写」的分界——已核实。**
判定点是 `dsh-config-editor/lib/index.js:118-122`：写入前把

```
readProfilePatches("dsh", profile, { ...loadProfileDirectory(dir), patches: <刚构造的新文档> })
```

重新组合一遍（`dsh-app-boot/lib/index.js:1023-1034`）——顺序为 **bundle 层 → 文档本身（= profile 用户层，即 `documentPath`）→ `$DSH_HOME/cordis.patch.yml`（home patch）→ `context.overlays`（argv `--patch`）**——再要求 `composeEntries([patches])` 里该 entry 的 `config` 与待写值 `isDeepStrictEqual`，否则 `throw new Error('Configuration for "set-model" is overridden by a home patch or command-line overlay')`。该 throw 在 `writeFileAtomic`（:123）**之前**，所以覆盖层存在时写入被拒、文件不动。

**(b) 播种 profile 用户层是唯一可写选择——成立，且有运行时旁的硬证据。**
`.dsh-e2e-home/profiles/web/cordis.patch.yml` 与 `e2e/fixture/cordis.patch.yml` 现在只差两行（`E2E 日常` → `E2E 日常 v2`、`e2e 探针…` → `v2`），其余注释与行完好 → 证明：dsh-e2e 的 `cp` 播种成功、设置页**真的写进了这个文件**、且 `dsh-config-editor` 用 YAML AST `setIn` 只改目标 entry 而不吞注释。实例日志里无 `patch: name mismatch` / `entry not found` 警告 → 种子各行按 id 命中既有 entry，没有产生重复 entry（`dsh-app-boot/lib/index.js:95-103` 的 name 校验通过）。

**(c) 假绿的根因需要订正一处（重要，建议改文档）。**
「覆盖层 → 保存被静默拒绝」这一因果链**不能解释一次全绿的 18/18**：覆盖层介入时写入是被**显式拒绝**的，页面会走 `setMessage({kind:"err", text: res.error.message})`，于是 e2e 里 `afterSave.includes("已保存并热生效")` 必然失败（页面显示的是 "…is overridden by a home patch or command-line overlay"）。真正让老用例变绿的是**写入值与种子值完全相同**：`buildOps` 写回的正是页面从 live config 读到的值，而 live config 来自种子；`composeEntries` 对该 entry 的 `config` 是**整对象覆盖**（`dsh-app-boot/lib/index.js:104-106`），值相同时组合结果与待写值恰巧 deep-equal，于是写入被接受、却被覆盖层遮蔽（boot 后生效的仍是覆盖层那份），读回自然等于写入值 —— 断言无法区分「写成功」与「被遮蔽」。你把它改成写 `v2` 才让两者分离（也正因此你此时观察到了那条 overridden 报错）。建议把 AGENTS.md/提交信息里这半句改写成「覆盖层会让该命名空间的写入**要么被 composition 校验拒绝、要么写入后被覆盖层遮蔽**（取决于待写值是否与覆盖层相同），两种情况下设置页都不可作为唯一真源」。结论（不能用 `dsh --patch` 播种、必须播种用户层）本身完全正确。

**(d) `--patch` 位置那条平台事实——成立。**
`dsh/lib/bin.js:11-21` 模块注释写明「Launcher flags therefore come first: the first token this parser does not recognize starts the inner arguments」，实现是 commander `.allowUnknownOption().passThroughOptions().enablePositionalOptions()`（同文件 :105）。所以 `dsh --profile web --port P --no-open --patch FILE` 里 `--port` 就是「第一个不认识的 token」，此后（含 `--patch`）全部原样交给 web app → 旧 dsh-e2e 的 `--patch` 从未生效。修法（改成播种、launch 行不再传 `--patch`）正确；`dsh tui --patch ./extra.yml` 这种「launcher 标志在前」的写法才是 canonical 用法。

**(e) 播种用户层是否会引入别的偏差——没有，仅两点需知情。**
- 该文件同时是设置页的写入目标（`documentPath` = `profileContext.patchPath`，`dsh-config-editor/lib/index.js:25`），因此每次 `dsh-e2e start --patch` 都会**整文件覆盖**用户层（冷启动回到 pristine 种子，这是好事；代价是同期手工在 GUI 里做的改动会被下一次 start 冲掉，对一次性 e2e home 可接受）。
- 同一陷阱对 `$DSH_HOME/cordis.patch.yml`（home patch，优先级在用户层之上）同样成立；当前 e2e home 里没有该文件（已确认），但将来若有人往里放东西，页面会立刻变为不可写——值得在 AGENTS.md 那条事实里点一句。

### 4. 新增单测（上下文行）——**覆盖到位，两个分支可再补**

`test/helpers.ts:154-167` 捕获 `systemPrompt.section/context` 贡献，`test/plugin.test.ts:101-131` 用 `contexts[0].text({ agent })` 断言：

- 命中档位（含 effort）：`[Current active model: deepseek/deepseek-reasoner · reasoning: max · preset: deep]` ✓ **正是 plan §10 要的那条**，且顺带覆盖了 effort 段拼接；
- 未命中档位：`[Current active model: cpa/omni]`（无 `preset:` 段）✓ 覆盖降级分支。

仍缺的（都便宜，非阻塞 N3）：① `[Plan Mode Active]` 后缀（`src/index.ts:94`，可在 mock `sessionProjections` 里置 `plan.active` 后断言，Plan 联动的另一处用户可见输出目前只有 e2e 覆盖）；② `!context.agent → ""` 的早退（`src/index.ts:88`）；③ 「档位未 pin effort 时同路由仍匹配」虽在 `test/presets.test.ts:34-38` 直接覆盖了 `matchPreset`，但没走上下文行。

### 5. 其余非阻塞项——**均已处理**

`requireAgent` 文案已中性化（`src/tools.ts:15-20`，去掉 `set_model:` 前缀）；`src/index.ts:68-70` 注释改成「declare this instance's page policy, exactly as the official settings pages do」——我核对了平台：`dsh-agent-default-model:31`、`dsh-client-ui-settings:16` 等 14 处官方插件用的正是 `child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))` 这一形态，**新注释准确**（已不再声称有可见的关闭效果）；`screenshots.json` 为 `["assets/model-policy-settings.png"]`，符合 `dev-dsh-plugin` 的「1-8 张、仓库根、相对路径、不跳出插件目录」✓；`summary.md:46` 的第一轮链接已改指 `review.round1.md` ✓、计数改为 29/22 ✓、新增第二轮处理表 ✓；`AGENTS.md` 两条平台事实与源码一致 ✓（仅 §3(c) 的机制描述建议订正）。

## 阻塞问题

无。

## 建议修改

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| R1 | `src/config.ts:276-278` | **R2 的同源镜像漏项**：`planPreset 指向不存在的档位` 无条件按 error 报，但自由模式下 `planPreset` 根本不参与决策（目标由 `planModel` 决定），且设置页在自由模式**不渲染** planPreset 选择框，用户没有可视化途径清理它（典型来路：preset→free 切模式后清空档位表）。这与「error = 该条配置被废弃/不可用；warn = 合法但有话要说」的判据不一致，会变成每次加载/保存都刷的永久 error。 | 加 mode 判断：preset 模式下悬空 → error；自由模式 → warn（或直接不报）。一行 guard 即可，并补一条 `test/config.test.ts` 断言。 |
| R2 | `src/client/panel.tsx:188-211` | **R1 同类残留（更窄）**：自由模式下只选了「思考强度」而 provider/model 均空时，`validate()` 放行（`hasProvider === hasModel === false`），`buildOps` 走 `unset planModel` → 用户选的 effort 被丢弃，页面仍提示「已保存并热生效」；刷新后该字段回空。 | 二选一：`validate()` 里把「有 effort 但无 provider/model」也判为不完整并提示；或在 UI 上把 effort 选择禁用至 provider/model 至少填一项。 |
| R3 | `scripts/dev-worktree.sh:8` | README/README.en:218 都写「需要图形界面验证时用 dsh-e2e 最小实例（见 `scripts/dev-worktree.sh`）」，但该脚本第 8 行是 `exec dsh-e2e start --wait-ready`（**没带 `--patch e2e/fixture/cordis.patch.yml`**），紧邻的文档块又给出带 `--patch` 的命令 → 照脚本走会得到一个未播种的实例（自由模式、无档位、设置页几乎是空的），无法做档位模式的人工验证。 | 脚本改成 `exec dsh-e2e start --wait-ready --patch e2e/fixture/cordis.patch.yml`（脚本已 `cd` 到仓库根，相对路径可用）。 |
| R4 | `AGENTS.md`（e2e 那条平台事实）、`c6fc4e7` 提交信息「副产物」段 | 「覆盖层 → 设置页拒绝写入 → 于是老 18/18 是假绿」的因果链有一处不成立（见 §3(c)）：覆盖层介入时页面会**显示拒绝**，e2e 的「已保存并热生效」断言必然失败，不可能绿；真正的假绿来自写入值与种子值相同 + 覆盖层遮蔽。这条事实会被后续开发者当作排查依据，建议订正为「覆盖层会让该 entry 的写入被 composition 校验拒绝，或写入后被覆盖层遮蔽（取决于值是否与覆盖层相同）」——结论（播种用户层）不变。 | 改写 AGENTS.md 该句 + 顺带把提交信息里这半句在未来 squash/amend 时同步（或仅以 AGENTS.md 为准）。 |

## 非阻塞问题

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| N1 | `src/config.ts:190-195` | `unknown reasoningEffort … falling back to the model default` 不丢弃该档位（仅退回模型默认），却走 `problems`（error）。按你给的判据更像 warn。 | 视口味定：降 warn，或在文案里明确「该字段已丢弃」。 |
| N2 | `e2e/verify-policy-page.mjs:108,130` | 原地复跑时 STAGE 3 写入的 `E2E 日常 v2` 已在上一轮留下的用户层里，于是「刷新后仍持久化」这条断言在复跑时无法区分「本轮写成功」与「上一轮的残留」（冷启动 `--patch` 播种则无此问题）。 | 探针值掺入每次运行唯一的内容（`Date.now()` 后缀），或额外断言 `describe().revision` 在保存后递增——后者与值无关，是更硬的写入证据。 |
| N3 | `test/plugin.test.ts:101-131` | 上下文行缺两个分支：`[Plan Mode Active]` 后缀（`src/index.ts:94`）与 `!context.agent → ""` 早退（`src/index.ts:88`）。 | 各补一条断言（mock 已有 `sessionProjections.setState` 可置 plan 状态）。 |
| N4 | 文档一致性 | `docs/.../validation.md:13` 仍写 `npm test` 为 **28/28**（实际 29 例：config 8 + controller 3 + plan-switch 1 + plugin 6 + presets 5 + tools 6）；`AGENTS.md:12` 的地图行只提 `problems` 诊断，未提 `warnings`。 | 更新为 29/29，并在 config.ts 那行补 `warnings`。 |
| N5 | `~/.dsh/skills/dsh-e2e/SKILL.md:48` | 技能文档只列 `--patch FILE`，未说明它现在是「播种到 profile 用户层」（旧行为是转发给 `dsh` 且实际无效）；其它 agent 沿用旧认知时可能又把种子写成覆盖层而重踩假绿。 | 在技能里补一句语义 + 「不要用 dsh 的全局 `--patch` 播种」的坑（与 AGENTS.md 同源）。 |

## 准入结论

**结论**：`条件准入`（等价于「可以合并」：**无阻塞问题**，仅剩 4 条建议 + 5 条非阻塞）

**说明**：R1/R2/R3 的修复我都独立验证成立——R1 是完整闭环（页面拦在 `mutate` 之前，宿主丢弃路径不可达），R2 的 error/warn 划分与判据一致（仅剩 `planPreset` 那条镜像漏项），R3 的平台结论正确且播种用户层有运行时硬证据（实例用户层文件只剩两行差异、注释与行完好、无 name-mismatch 警告）。唯一的实质性订正是「假绿根因」的表述（R4），属文档准确性，不影响代码行为。R1–R3 三条建议都是一行/一处的小改，可在合并前顺手处理或留待后续迭代。
