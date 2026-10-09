# 261009-model-policy 验证记录

## 验证说明

- 验证对象：`dsh-set-model` 的「模型策略」能力——可配置的「阶段→模型」系统提示词 + 档位模式（`switch_preset` / `list_presets`）+ 插件自带 Web 设置页。
- 自动化环境：worktree `.worktrees/model-policy` + `dsh-e2e` 最小实例（dsh-base + dsh-web-app + 本插件），无头 Firefox（camoufox）+ playwright-core。

## 自动化验证结果

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 证据 |
| -------- | -------- | -------- | ---- | ---- |
| `npm run check` | 宿主与浏览器半两份 tsc 均通过 | 0 错误 | 通过 | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit` |
| `npm test` | 全部单测通过（含以真实 `Config["~standard"].validate()` 构造的 volatile 夹具） | 30/30 通过 | 通过 | `node --test dist/test/*.test.js` |
| `npm run build` | 产出 `dist/src/**` 与 `lib/client.js`，且后者语法合法 | 构建成功，`node --check lib/client.js` 通过 | 通过 | `scripts/build-client.mjs` 内置语法检查 |
| `dsh-e2e run e2e/verify-policy-page.mjs` | GUI 启动无 pageerror/console.error；设置页注册、读写、连续保存、刷新后持久化；自由模式 Plan 目标半填与只填思考强度被拦 | 22/22 断言通过 | 通过 | 见下方「e2e 覆盖」 |
| 配置诊断 | 重复 id / 缺 provider / 无效 planPreset 只记日志、跳过该条，插件照常加载 | 与预期一致 | 通过 | `test/config.test.ts` |
| 模式分支 | 自由模式只注册 `set_model`/`list_models`；档位模式只注册 `switch_preset`/`list_presets` | 与预期一致 | 通过 | `test/plugin.test.ts` |
| 策略段落渲染 | 未配置时为空；自由模式仅用户文本；档位模式附自动生成清单 | 与预期一致 | 通过 | `test/presets.test.ts` |

### e2e 覆盖（`e2e/verify-policy-page.mjs`）

- 启动无 pageerror、无 console.error（证明客户端 bundle 语法与注册正确）；
- 设置导航出现「模型档位」，页面正文渲染，`set-model` 命名空间被解析（无「未找到设置命名空间」）；
- 页面正确读出 profile 里预置的两条档位与档位模式（证明宿主解析出的配置与设置页看到的一致）；
- 编辑档位显示名与策略提示词（写入**与种子不同的新值**，避免"读到的其实是种子"的假绿）并保存 → 成功；**连续第二次保存**同样成功（验证 revision 续期，否则会被判为陈旧写入）；
- 刷新页面后重新打开：编辑后的显示名与策略提示词均已持久化；
- 切到自由模式后只填 Plan 目标的一半 → 页面**拒绝保存**并给出提示，不出现"已保存并热生效"；两栏都清空 → 保存成功；最后切回档位模式保存，使重复执行可幂等。

种子的可复现做法：`e2e/fixture/cordis.patch.yml` 入库，`dsh-e2e start --wait-ready --patch e2e/fixture/cordis.patch.yml` 把它播种到 profile 的**用户 patch 层**。

## 需用户实机确认的场景

自动化已覆盖设置页与配置链路；下面两条依赖真实模型调用，留给用户按需确认（建议在本 worktree 的临时实例上跑）：

- 临时实例：<http://127.0.0.1:55603/?token=e2etest>（dsh-e2e 一次性实例，端口动态分配；换机器/重启后用 `dsh-e2e status` 取当前 URL，用完 `dsh-e2e stop`）

| # | 场景 | 看哪里、看什么 |
|---|------|---------------|
| 1 | 档位模式按策略换档 | 开一个新会话，提一个需要先规划再实现的任务；看工具卡片里是否出现 `Switch preset: deep`，以及回答是否随档位切换而切换模型 |
| 2 | Plan 联动 | 输入 `/plan ...` 进入规划模式，看运行时上下文是否显示 `preset: deep [Plan Mode Active]`；批准/退出后再看是否恢复进入前的档位 |
| 3 | 设置页观感 | 设置 → 模型档位，确认档位表增删排序、下拉选择、保存反馈是否符合预期（截图见 [assets/model-policy-settings.png](../../../assets/model-policy-settings.png)） |

## 验证结论

自动化验证全部通过。核心交互（设置页注册/读写/持久化、工具注册分支、策略段落、Plan 联动）均有自动化覆盖；剩余为用户观感与真实会话行为确认。

## 待跟进

- 用户在 GUI 模型选择器手动切模不受档位模式约束（平台无拦截接口），如需要"连人也锁死"须另行设计（见 summary 的「未做/待议」）。
- 第一轮检视的两个阻塞问题（volatile 引用读取、volatile-only 保存不重跑 `apply`）已修复并有单测覆盖；但其"平台交接"这一段（真实 Loader 把校验结果交给 `apply`）无法在最小 e2e 实例里观测（该实例没有可用模型 provider，也无法读插件日志），故建议场景 1 时顺带确认档位模式确实只暴露 `switch_preset`。
