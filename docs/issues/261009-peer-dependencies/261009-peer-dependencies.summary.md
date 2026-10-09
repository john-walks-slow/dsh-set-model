# 261009 peer-dependencies 修复总结

## 背景

GitHub issue [#1](https://github.com/john-walks-slow/dsh-set-model/issues/1)：`dsh-set-model@0.1.0` 在 DSH ≥ 0.1.7 的 profile 上安装后，Web UI 会话列表整体空白，宿主日志报 `typert-loader ... codec has no create() factory`——报错文案完全不指向本插件，人工排查成本极高。

根因与宿主解析机制的完整证据链见 [261009-peer-dependencies.troubleshoot.md](261009-peer-dependencies.troubleshoot.md)。一句话：核心 `@deepseek-ai/*` 包被写进 `dependencies` 并锁死 `0.1.2-rc.1`，pnpm 将它们 hoist 进 profile，抢在宿主自带副本之前被 DSH 的模块解析层加载；旧版 `dsh-llm` 的 typert manifest 键名（`schema`）与 0.1.7+ loader 的硬校验（`create`）不匹配 → contributor 注册失败 → `session/list` strict definition 撤回 → 会话列表空白。

## 改动

| 文件 | 改动 |
| --- | --- |
| `package.json` | 5 个 DSH 运行时包 + `cordis` 从 `dependencies` 移到 `peerDependencies`（区间 `^0.1.7-rc.2 \|\| ^0.2.0-rc.1`）；`dsh-settings` 为 optional peer；`devDependencies` 对齐宿主 0.2.0-rc.2；删除零引用的 `zod`、`dsh-agent-default-model`、`dsh-plan-mode`、`dsh-token-meter` |
| `package-lock.json` | 按新依赖声明重建（旧核心包 0 残留） |
| `src/index.ts` | `agent/created` 监听器显式 `return undefined`（0.2.0-rc.2 起该事件签名收窄为 `undefined \| Promise<undefined>`） |
| `README.md` / `README.en.md` | 「权限与兼容」改写为宿主版本要求 + peerDependencies 声明说明 |
| `AGENTS.md` | 依赖声明规范改为「运行时包必须 peerDependencies」，并写明机制与后果 |
| `.gitignore` | 补 `.dsh-e2e-home/`、`.mnemon/` |
| `docs/issues/261009-peer-dependencies/` | troubleshoot / validation 记录 |

## 验证

- `npm run check` 0 错误；`npm test` 7/7 通过（devDeps = 0.2.0-rc.2）。
- **双版本**：隔离 scratch 目录把 devDeps 钉到 0.1.7-rc.2 后，类型检查 0 错误、单测 7/7 通过 → `^0.1.7-rc.2 || ^0.2.0-rc.1` 区间成立。
- 宿主 `evaluatePluginCompatibility`：0.2.0-rc.2 / 0.1.7-rc.2 / 0.2.1-alpha.2 无警告；0.1.2-rc.1 给出明确不兼容提示（旧宿主不再静默崩）。
- **复现 issue 现场**：用同一 pnpm 配置（`nodeLinker: hoisted` + `autoInstallPeers: false`，DSH `initProfile` 默认）对照安装前后 manifest —— 修复后 `@deepseek-ai/*` 被 hoist 的包从 9 个降到 0（仅剩叶子库 `schemastery`/`cosmokit`）。
- 宿主安装域覆盖检查：插件运行期 import 的 7 个包全部命中 installation entries（511 条）。
- 隔离最小实例（`dsh-e2e`）：启动就绪，profile 内无 hoist 副本，`pluginInventory/list` 返回 `dsh-set-model | enabled: true | fiber: active`。

检视步骤按 workflow 的豁免条款跳过：代码改动 2 行、风险集中在依赖声明本身，且已用上述 7 项实测（含 issue 现场对照复现）覆盖；结论由证据而非人工阅读支撑。

## 待跟进

1. **发布**：`npm run release`（生成 0.1.1 tgz）→ 指纹发布 → `git push --follow-tags`。发布动作需要用户 passkey 指纹。
2. **用户验证**：见 [261009-peer-dependencies.validation.md](261009-peer-dependencies.validation.md)，重点是干净 profile 上 registry 安装的端到端确认。
3. **另案**：插件设置集成在 DSH ≥ 0.1.7 上静默失效（`settings.installSection` 已被 `SettingsForms` 取代），导致 Web Settings UI 无本插件表单、`planModel` 只能走 cordis.patch.yml。需按生态做法（`installSection → register → entry-config` 三级兼容）单独设计并双版本验证；本次未纳入范围。
4. 可考虑在 issue #1 下回复修复说明并请报告者在其 Windows/0.1.7-rc.2 环境复验（需用户同意后再对外发言）。
