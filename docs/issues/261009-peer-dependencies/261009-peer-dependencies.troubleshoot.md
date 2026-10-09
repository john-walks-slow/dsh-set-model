# 261009 peer-dependencies 排障记录

对应 GitHub issue：[john-walks-slow/dsh-set-model#1「[Bug] 核心包声明为 dependencies 并锁死 0.1.2-rc.1：在 DSH 0.1.7+ 下导致宿主 typert 注册失败、会话列表消失」](https://github.com/john-walks-slow/dsh-set-model/issues/1)

## 1. 问题现象（转述 issue）

在 DSH ≥ 0.1.7 的 profile 上安装 `dsh-set-model@0.1.0` 后：

1. Web UI 会话列表全空（历史数据未损坏）；
2. 宿主启动日志报错，且文案完全不指向本插件：
   - `typert-loader: @deepseek-ai/dsh-llm invocation "@deepseek-ai/dsh-llm#llm/discoverModels" parameter codec has no create() factory`
   - `typert gateway: session/list: its strict definition was withdrawn and SRC fallback is forbidden`
   - `image-offload: TypeError: ctx.sessions.registerMessageProjection is not a function`

隔离复现（issue 提供）：新建 `DSH_HOME` + 干净 profile，只装本插件，启动即复现。

## 2. 根因确认

### 2.1 宿主解析机制（代码级证据）

DSH 通过 `@deepseek-ai/dsh-app-boot` 的模块解析拦截层统一解析插件依赖：

- `routeLinked()`（`dsh-app-boot/lib/index.js:1470-1510`）：解析 **link:** 插件目录内的 bare import 时，逐个向上检查 `node_modules` 所在目录的 `package.json`；**该包名出现在 `peerDependencies` 里 → 路由到宿主安装副本（installation entry）；否则使用本地 `node_modules` 副本**。
- `routeScoped()`（同文件 1418-1465）：profile 内安装的插件同理，本地 `node_modules` 副本优先，其次才回退到 installation entry（`scope === "installation"`）。
- `evaluatePluginCompatibility()`（同文件 284-320）：`peerDependencies` 中所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 条目会被当作**运行时版本要求**逐条与当前 dsh 版本做 semver 校验，不满足则给出安装期警告。

结论：`@deepseek-ai/*` 运行时包写在 `dependencies` 里，等于**主动让本地/被 hoist 的旧副本抢到解析权**；这是「宿主单例被旧副本顶掉」的唯一入口。

### 2.2 pnpm 行为实测（复现 issue 现场）

用 issue 的 pnpm 配置（`nodeLinker: hoisted` + `autoInstallPeers: false`，即 DSH `initProfile` 写死的模板，见 `dsh-app-boot/lib/index.js:565`）分别安装「旧 manifest」与「新 manifest」的等价 tarball：

| 探针 | 依赖声明 | `profile/node_modules/@deepseek-ai/` 被 hoist 的包 |
| --- | --- | --- |
| before | 核心包在 `dependencies`（锁死 `0.1.2-rc.1`） | `dsh-agent dsh-brand dsh-llm dsh-session dsh-timeout dsh-tools dsh-typert-protocol dsh-util-crypto dsh-util-values` + `cordis/cosmokit/schemastery`（版本 0.1.2-rc.1 / cordis 4.0.2） |
| after | 核心包移到 `peerDependencies` | 仅 `cosmokit schemastery`（3.18.4，叶子 schema 库，非 typert contributor） |

`dsh-llm@0.1.2-rc.1` 的 typert manifest 用键名 `schema`，0.1.7+ 的 loader 硬校验键名 `create` → contributor 注册失败 → `session/list` 的 strict definition 被撤回 → 前端会话列表空白。整条失败链由此闭合。

## 3. 修复

`package.json` 依赖声明重排（issue 建议的方向，与生态既有插件 `dsh-better-sidebar@0.24.1`、`dsh-mnemon@0.5.24` 一致）：

```json
"dependencies": { "@deepseek-ai/schemastery": "^3.18.4" },
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.4",
  "@deepseek-ai/dsh-agent": "^0.1.7-rc.2 || ^0.2.0-rc.1",
  "@deepseek-ai/dsh-llm": "^0.1.7-rc.2 || ^0.2.0-rc.1",
  "@deepseek-ai/dsh-session": "^0.1.7-rc.2 || ^0.2.0-rc.1",
  "@deepseek-ai/dsh-settings": "^0.1.7-rc.2 || ^0.2.0-rc.1",
  "@deepseek-ai/dsh-tools": "^0.1.7-rc.2 || ^0.2.0-rc.1"
},
"peerDependenciesMeta": { "@deepseek-ai/dsh-settings": { "optional": true } },
"devDependencies": { /* 对齐宿主 0.2.0-rc.2，仅供本地 tsc / node --test */ }
```

要点：

- **双版本区间**：`^0.1.7-rc.2 || ^0.2.0-rc.1` 同时满足 0.1.7-rc.2（issue 现场）与 0.2.0-rc.2（本机宿主）；0.1.2~0.1.6 会拿到明确的"插件与 dsh 版本不兼容"安装警告，而不是静默崩掉宿主。
- **`schemastery` 留在 `dependencies`**：叶子 schema 库、不注册 typert contributor；生态主流（better-sidebar / mnemon）也放在 deps，避免安装域缺失时解析失败。
- **`dsh-settings` 为 optional peer**：只在 `import type {}` 中用于类型增强，运行时不存在也应可加载。
- **devDependencies 提到 0.2.0-rc.2**：本地 link 开发时插件自己的 `node_modules` 与宿主同版本，不再有被旧副本顶掉的风险。
- **清理无用依赖**：`zod`（源码零引用）、`dsh-agent-default-model` / `dsh-plan-mode` / `dsh-token-meter`（源码零 import，均为早期 inject 服务列表的残留）。

附带代码改动一处：`src/index.ts` 的 `agent/created` 监听器显式 `return undefined`——0.2.0-rc.2 起该事件签名收窄为 `undefined | Promise<undefined>`（`dsh-agent/lib/types/runtime-types.d.ts:227`），原来隐式 `void` 无法通过类型检查。

## 4. 验证

| # | 验证项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | `npm run check`（0.2.0-rc.2 类型） | 通过 | 0 错误 |
| 2 | `npm test`（0.2.0-rc.2 运行时） | 通过 | 7/7 |
| 3 | 0.1.7-rc.2 全量类型检查 + 单测（隔离 scratch 目录，devDeps 钉 0.1.7-rc.2） | 通过 | 类型 0 错误、单测 7/7 → 双版本区间成立 |
| 4 | DSH 兼容性检查 `evaluatePluginCompatibility` | 0.2.0-rc.2 / 0.1.7-rc.2 / 0.2.1-alpha.2 均无警告；0.1.2-rc.1 给出明确不兼容提示 | 直接调用宿主 API |
| 5 | pnpm hoist 前后对照（复现 issue 现场） | 修复后仅剩 `cosmokit/schemastery`，9 个 dsh-* 旧副本全部消失 | 见 §2.2 表 |
| 6 | 宿主安装域覆盖检查 | 插件运行期 import 的 7 个包全部存在于 installation entries（511 条），版本与宿主一致 | `createRuntimeResolution()` |
| 7 | 隔离最小实例（`dsh-e2e`，`dsh-base + dsh-web-app + dsh-set-model`）启动 | 实例就绪，profile `node_modules` 内无 hoist 的 `@deepseek-ai`，`pluginInventory/list` 返回 `dsh-set-model \| enabled: true \| fiber: active` | 探针输出；证明 plugtree 正常加载、peer 解析落到宿主副本 |

## 5. 附带发现（不在本次修复范围，另案处理）

隔离实例里 `settings/describe` 的 19 个命名空间中**没有** `dsh-set-model`，说明插件的设置集成在 DSH ≥ 0.1.7 上静默失效：

- `src/index.ts` 调用 `settings.installSection(...)`（0.1.5-rc.3 及更早存在，实测 `dsh-settings@0.1.5-rc.3` 仍有该 API）；
- `dsh-settings@0.1.7-rc.2` / `0.2.0-rc.2` 已改为 `SettingsForms`（`settings` 服务只剩 `configure()` / `describe()`；0.2.0 走「插件 Loader entry 的 Config + `.volatile()` 即自动出表单」模型，命名空间 = loader entry id）。生态插件（如 `@hytime/dsh-thinking-effort`）用 `installSection → register → entry-config` 三级兼容分支处理这一漂移。
- 现象：仅设置 UI 缺表单、`planModel` 等只能通过 cordis.patch.yml 配置；插件其余功能不受影响（错误发生在 `ctx.inject(["settings"])` 子 fiber 内，父 fiber 仍 active）。

该项需独立设计与双版本验证，待确认后另开 issue/需求处理。
