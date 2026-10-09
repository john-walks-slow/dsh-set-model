# 261009-model-policy 实施总结

## 背景与目标

`dsh-set-model` 原本只提供"任意切模"（`set_model` / `list_models`）与 Plan 模式自动升降级。本次把它扩成**模型策略**：

1. **附带的系统提示词**：用户可配置一段策略文本，声明"不同阶段用什么模型"；档位模式下由插件自动生成档位清单追加其后；
2. **档位模式（preset mode）**：部署声明一组「模型 + 思考强度」档位，Agent 只能在档位间切换，不再能任意指定 provider/model；
3. **插件自带设置页**：可视化维护档位表与策略，保存即热生效。

计划见 [261009-model-policy.plan.md](261009-model-policy.plan.md)，调研见 [261009-model-policy.research.md](261009-model-policy.research.md)。

## 交付内容

| 层 | 变更 |
|---|---|
| 配置 | `src/config.ts`：`mode`、`presets[]`、`policyPrompt`、`planPreset`；`resolveConfig` 产出 `problems`（error，条目废弃）与 `warnings`（warn，合法但有话要说）两类诊断，只记日志不抛，避免拖垮插件树 |
| 档位逻辑 | `src/presets.ts`（新）：查找、反向匹配、策略段落渲染 |
| 工具 | `src/tools.ts`：新增 `switch_preset` / `list_presets`，按 mode 与 `set_model` / `list_models` 二选一注册 |
| 入口 | `src/index.ts`：`dsh:model-policy` 系统提示词段落（order 550）、上下文行追加 `preset: xx`、Plan 联动按 mode 选目标、`settings.configure({auto:false})` |
| 浏览器半 | `src/client/index.ts` + `panel.tsx`（新）：`settings.section`「模型档位」页；`scripts/build-client.mjs` 构建 `lib/client.js` |
| 工程 | `tsconfig.client.json`（新）、`package.json`（exports/files/scripts/`dsh.client`/devDeps）、`e2e/verify-policy-page.mjs` + `e2e/fixture/cordis.patch.yml`（新，可复现的种子配置）、`assets/`（设置页截图） |
| 测试 | `test/config.test.ts`、`test/presets.test.ts`、`test/plugin.test.ts`（新）+ `test/tools.test.ts`（扩），共 30 例 |
| 文档 | 双语 README 重写、`AGENTS.md` 地图与规范更新 |

## 关键设计决策

- **约束边界只看 Agent**：DSH 的 `session/selectModel` → `selectForNextRequest` 路径没有 waterfall/hook，插件无法 canonical 地拦截用户在 GUI 的切模。因此档位模式定义为"不注册 `set_model` / `list_models`，只注册档位工具"，人的手动切换保留为兜底通道，并在 README/AGENTS 中写明。
- **动态信息留在尾部**：策略段落是静态的（只随配置变化，不破坏 prompt cache）；"当前档位/当前模型"这类每步会变的信息继续走 `systemPrompt.context` 的尾部快照。
- **配置错误不致命**：插件加载期抛错会让整棵 plugin tree 失败、全站不可用。故所有校验问题汇总进 `problems`，逐条 `logger.error`，工具在运行期给出明确错误。
- **不引入 `defaultPreset`**：会话起始模型仍由 DSH 默认模型配置决定，Agent 按策略自行换档，避免与 `agentDefaultModel` 争权。

## 平台事实（本次踩到的坑，已写入 AGENTS.md）

1. **`installSection` 已不存在**：dsh 0.2 起插件 Config 由 `SettingsForms.describe()` 自动发现，原调用是静默死代码；设置命名空间是 **profile loader entry id**（本插件为 `set-model`），不是包名。
2. **只有 `.volatile()` 字段会进设置表单**：`describe()` 用 `volatileForm()` 过滤，Config 里没有任何 volatile 字段时命名空间对设置页完全不可见。所有可编辑字段已标 `.volatile()`。
3. **客户端 ctx 代理对未注入服务直接抛错**：`remote.session` 漏在 `inject` 里 → `cannot get property "remote.session" without inject`，且只在浏览器 console 暴露（表现为 `slot entry crashed in 'settings.section'`）。
4. **浏览器半是构建产物**：`__ModuleLoader__.load({ id })` 的 id 必须等于包名，构建脚本已内置 `node --check lib/client.js`。
5. **全 volatile 配置下 `apply()` 不会因保存而重跑**：Loader 只把新值原地提交进引用并广播 `loader/volatile-update`；结构性的行为变更（如工具集）必须监听该事件自行重建。
6. **`dsh --patch` 是覆盖层，会让设置页拒绝写入**：配置经 `--patch` 叠加时，设置页显示"Configuration for \"set-model\" is overridden by a home patch or command-line overlay"并静默拒绝保存。e2e 的种子必须写进 profile 用户层（`$DSH_HOME/profiles/web/cordis.patch.yml`），否则"保存并持久化"的用例是假绿。
7. **`dsh --patch` 只能在 app 选项之前**：一旦出现 `--port` / `--no-open`，后续参数整体透传给 app，全局选项被判为 `unknown option`（`dsh-e2e` 的 `--patch` 因此一直是坏的，已修）。
8. **`autoGenerate` 在 0.2.0-rc.2 客户端没有渲染消费者**：`settings.configure({ auto: false })` 目前看不到可见差异，保留只为符合平台约定。

## 检视与修复

第一轮检视结论为**不准入**（报告见 [261009-model-policy.review.round1.md](261009-model-policy.review.round1.md)），指出两个阻塞缺陷，均出在"把 volatile 字段当普通值用"这一平台机制上：

| # | 问题 | 修法 |
|---|---|---|
| B1 | `apply()` 收到的是 schemastery 校验结果，volatile 字段是 `Volatile<T>` 引用对象；`resolveConfig` 按普通值读 → mode 恒 free、presets 恒空、策略段落恒空、`planModel`/`allowedProviders` 等既有能力静默回归 | 新增 `SetModelLiveConfig` + `snapshotConfig()`，运行时一律 `.get()` 后实时快照；四个工具工厂改为接收 `live: () => ResolvedSetModelConfig` |
| B2 | Config 全字段 volatile 时，Loader 对"仅 volatile 变化"走 `_commitVolatile()` 原地提交引用、**不重跑 `apply()`** → 设置页保存不生效 | `planModel` 改为整对象 volatile（schemastery 禁止 volatile 嵌套）；监听 `loader/volatile-update`，用 `tools.register()` 的 disposer 重建根 Agent 工具集 |

同时处理了 6 项建议：`settings.configure` 显式传 entry fiber 并包进 `effect`；自由模式下空 `planModel` 改为 `unset`；工具关闭时策略段落不再要求调用 `switch_preset`；`list_presets` 渲染复用 `formatPreset`；设置页写入带 revision 并用 `mutate` 返回值续期（顺带修掉"上一次成功提示的定时器清掉下一次提示"的 UI bug）；README 删除"已关闭自动生成配置页"这一核实不成立的表述。

测试侧的关键改进：新增 `liveConfig()` 夹具——它用**真实的 `Config["~standard"].validate()`** 构造配置，使单测的 volatile 引用形状与线上一致；并新增"volatile-only 写入后工具集原地切换"的用例。

第二轮检视结论为**条件准入**（无阻塞，报告见 [261009-model-policy.review.md](261009-model-policy.review.md)），逐段复核了 B1/B2 两条链路（`resolveConfig` → `volatileEntries` → `_commitVolatile` → `loader/volatile-update` 可达性），并认定 `planModel` 改整对象 volatile 是必需项。剩余建议已一并处理：

| # | 建议 | 处理 |
|---|---|---|
| R1 | 自由模式 Plan 目标**半填**（只填一侧）静默失效，页面却提示已保存 | 设置页 `validate()` 增加"必须同填或同空"校验，直接拦在保存前 |
| R2 | 切档位模式后遗留的 `planModel` 被当 error 每次保存刷日志 | 拆出 `warnings` 通道（`logger.warn`），该提示降级；错误只留给真正加载不了配置的情形 |
| R3 | e2e 依赖未入库的 `.dsh-e2e-home/.../cordis.patch.yml`，且 playwright 路径硬编码 | 种子配置入库为 `e2e/fixture/cordis.patch.yml`，由 `dsh-e2e start --patch` 播种到 profile 用户层（见下条平台事实）；playwright/camoufox 路径改为 `DSH_E2E_PLAYWRIGHT` / `DSH_E2E_BROWSER` 可覆盖 |
| — | `requireAgent` 文案固定写 `set_model:`、`settings.configure` 注释与 0.2.0-rc.2 事实不符、Plan 目标半填/`modelCatalog` 同步抛错未兜住 | 逐条修正 |
| — | plan §10「上下文行出现 `preset: xx`」缺单测 | 夹具捕获 `systemPrompt.context`/`section` 贡献，新增用例断言含档位与 effort 的完整上下文行、未匹配档位的降级输出、无 agent 时为空、Plan Mode 后缀 |
| 复核追加 | `planPreset` 悬空在自由模式下按 error 每次刷；未知 `reasoningEffort` 按 error（实际只是退回模型默认）；自由模式只填思考强度仍被静默丢弃 | 前者按 mode 分流（档位模式 error / 自由模式 warn），后者降 warn，面板补"只填了思考强度"的校验 |
| 复核追加 | `scripts/dev-worktree.sh` 没带 `--patch`，照 README 做人工验证会得到未播种实例 | 脚本补上种子参数 |
| 复核追加 | e2e 断言值等于种子/上轮残留时会假绿；成功的提示靠固定 sleep 等待，宿主写回慢时闪红 | 探针值改为每轮唯一的 `probe-${Date.now()}`，成功提示改为 `waitForFunction` 轮询（同时异步等待写回完成） |

## 与主干合并（1f5c4aa）

接手了 issue #1 会话的交接文档 [`docs/freeform/261009-settings-volatile-handoff.md`](../../freeform/261009-settings-volatile-handoff.md)：它给出的两条硬事实（配置字段必须 `.volatile()` 否则设置页看不到本插件；纯 volatile 变更走 `_commitVolatile` 原地更新、插件不重挂载）与本实现的写法一致，无需返工。合并事实：

- 主干 `c6b0302` 在 `src/index.ts` 留下的注释「the resolved config is a per-application constant」与上述第二条相反；合并时该文件整体采用本分支实现（`snapshotConfig()` 实时解包 + `loader/volatile-update` 重建工具集），该注释随之消失，`installSection` 死代码也早已被 `settings.configure` 取代。
- 主干删掉的 `@deepseek-ai/dsh-settings` 依赖需要保留：宿主半用它的类型标注 `ctx.settings.configure`，浏览器半注入 `remote.settings`。已恢复为 optional peer + devDependency（核心运行时包仍在 `peerDependencies`）。
- 主干 `c6b0302` 对 `src/controller.ts` 的精简（去掉冗余的 `lastUsed` 回退、`requestHeader()` 不再可选调用）无冲突合入，本分支 30 例单测全绿。
- 实测 `settings/describe`：命名空间列表 20 项且包含 `set-model`（交接文档记录修复前为 19 项、不含本插件），`revision: 3`，`value.mode: preset`、`presets: daily,deep`。

## 验证结果

- `npm run check`（宿主 + 浏览器半两份 tsc）通过；
- `npm test` 30/30 通过；
- `npm run build` 产出 `dist/src/**` 与 `lib/client.js`（`node --check` 通过）；
- `dsh-e2e run e2e/verify-policy-page.mjs` 22/22 通过（wipe 后冷启动一次 + 原地复跑一次均全绿）：GUI 无 pageerror/console.error、设置页注册并解析 `set-model` 命名空间、经页面编辑保存（连续两次，验证 revision 续期）后刷新仍持久化、自由模式 Plan 目标半填被拦；
- 额外实测：把两份档位的 YAML 直接写进 profile patch，设置页正确渲染（证明手写配置与设置页两条路都通）。

细节与用户实机确认项见 [261009-model-policy.validation.md](261009-model-policy.validation.md)。

## 未做/待议

- **不可拦截用户切模**：若将来需要"连人在 GUI 也锁死"，只能走客户端替换模型选择器（本插件已具备浏览器半，改造成本可控），或在 `model/selection` 事件上做回滚（非 canonical，会在会话日志留下脏事件）。
- **`defaultPreset`**：会话起始即套用某档位，本次刻意不做，需要时再加。
- **档位与 DSH Agent 预设的关系**：本插件的档位是模型层概念，与 `dsh-agent-preset`（composition 级会话预设）正交，文档中统一称「模型档位」以免混淆。
