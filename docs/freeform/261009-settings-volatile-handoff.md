# settings 集成修复：交接说明（给 model-policy 任务）

> 交接人：issue #1 修复会话 · 2026-10-09
> 来源：`docs/features/261009-model-policy/261009-model-policy.research.md` §2.3 已把「settings 死代码」与「命名空间不符」纳入本任务范围，本文件补齐**实现所需的平台事实**与验证方法，避免重走弯路。
> 任务归属：这两个问题的实现在 model-policy 任务内完成；本文档只提供结论与证据，不代改代码。

## 1. 结论（两条硬事实，必须先落地）

### 1.1 配置字段必须标 `.volatile()`，否则设置页里根本不会出现这个插件

- `dsh-settings` 的 `SettingsForms.describe()`（`dsh-settings/lib/index.js:413`）逐条遍历 loader entries，取 `entry.fiber.runtime.Config` 作 schema（同文件 `schema(entry)`，538 行），然后：

  ```js
  const form = volatileForm(schema);
  if (form === void 0) return [];      // ← 整条 entry 被丢弃，设置页看不到
  ```

- `volatileForm()`（同文件 122 行起）对「自身及所有子字段都没有 volatile 标记」的 object schema 返回 `undefined`。
- 写入侧同样强校验：`SettingsForms.write()`（同文件 466 行起）在无 volatile 字段时抛 `Plugin entry "<ns>" has no volatile fields`，路径级校验抛 `Config field "<path>" is not volatile`。

⇒ 要让用户能在设置页编辑 preset/planModel，`Config` 的每个可编辑字段都要 `.volatile()`（可整棵子树标在容器字段上，形如 `planModel: Schema.volatile()`；参考 `@linxin666/dsh-client-ui-git-graph/lib/index.js:10-14` 的逐字段写法）。

### 1.2 加了 volatile 后，配置是「原地更新」，插件不会被重新挂载

当前 `src/index.ts` 的注释 `The loader re-applies this plugin on every Settings/entry change, so the resolved config is a per-application constant` 与实现不符。实际路径在 `cordis-plugin-loader/lib/index.js`（`Entry.update`，372-388 行 + `_commitVolatile` 392-425 行）：

```js
const volatileOnly = changes.length === 1 && changes[0] === "config" && this.fiber.state === 2 && ...
  && equalExceptVolatile(legacy.config, this.options.config, this.fiber.runtime?.Config);
if (volatileOnly) this.fiber._config = this.options.config;
const pending = volatileOnly && this._commitVolatile() ? [] : changes;
if (!pending.length && !force) return;          // ← 纯 volatile 变更：直接返回，不重启插件
...
this._patchContext(pending);                    // ← 只有普通字段变化才走重挂载生命周期
```

`_commitVolatile()` 做的事：`volatileEntries(fiber.config)` 取出**已交给插件的那份 config 里的引用**，逐个 `updateVolatile(ref, source)` 原地写入新值，然后 emit `loader/volatile-update`（带变更路径）。

⇒ 三种可行写法（按推荐排序）：

1. **使用时读取**：apply 里只保存 config 对象本身，需要时 `config.planModel?.get() ?? config.planModel`（兼容未标 volatile 的旧宿主）。参见 `@linxin666/dsh-client-ui-git-graph/lib/index.js:22-26`。
2. **监听事件**：`ctx.on("loader/volatile-update", paths => ...)`，用于需要副作用（如重注册工具）的场景；`dsh-thinking-effort` 用 `settings.describe()` + 文档更新事件做等价事情。
3. **工具函数工厂**：`setModelTool(ctx, config)` 这类把配置当快照传参的写法要改成传 getter（`() => ResolvedSetModelConfig`），否则工具内部永远看到挂载那一刻的值。

判空/解包可复用 `isVolatile`（`@deepseek-ai/cosmokit/lib/index.js:116`，判定用 `Symbol.for("cosmokit.volatile.write")`，**跨 ESM/CJS 副本有效**，所以 hoist 一份 cosmokit 也不会失灵）。`dsh-mnemon/lib/index.js:9922-9930` 是现成的 `plain()` 递归解包实现。

## 2. 命名空间

- 0.1.7-rc.2 / 0.2.0-rc.2 的 `describe()` 取 `entry.options.id`（`dsh-settings/lib/index.js:432`），即 **loader 条目 id**，不是包名。
- 本插件当前 `cordis.patch.yml` 的 insert id 是 `set-model`，故真实命名空间为 `set-model`；`SETTINGS_NAMESPACE = "dsh-set-model"` 这个常量在 entry-config 模型下没有消费方（可删）。
- 若希望命名空间与包名/README 一致：把 `cordis.patch.yml` 的 id 改成 `dsh-set-model` 即可（已确认本机 profile 的 `cordis.patch.yml` 与 `package.json` 都没有引用 `set-model` 这个 id；但要保留旧 id 兼容性的话就维持 `set-model` 并同步 README）。**这是你的取舍，两种都可接受。**
- 已同步核对：`dsh-settings@0.1.7-rc.2` 与 `0.2.0-rc.2` 在这一点上实现一致（都没有 `register`，`describe()` 都基于 `volatileForm`）——即 `peerDependencies` 区间 `^0.1.7-rc.2 || ^0.2.0-rc.1` 内只有这一种模型，**不需要** `installSection → register → entry-config` 三级兼容分支。

## 3. 与 issue #1 修复（已提交 `d86583a`）的衔接

- `package.json` 的 DSH 运行时包已全部改为 `peerDependencies`（区间 `^0.1.7-rc.2 || ^0.2.0-rc.1`），`@deepseek-ai/dsh-settings` 是 **optional peer**，`dependencies` 里只剩 `@deepseek-ai/schemastery`。
  - 若新代码需要 `isVolatile` / `createVolatile`，把 `@deepseek-ai/cosmokit`（`^1.8.5`）加进 `dependencies`（叶子库，跨副本协议安全；`dsh-mnemon` 同样处理）。
  - **不要**把核心包挪回 `dependencies`——那会重新触发 issue #1 的 hoist 顶替单例问题（`AGENTS.md` 已写明）。
- `src/index.ts` 的 `agent/created` 监听器现在显式 `return undefined`，是 0.2.0-rc.2 事件签名（`undefined | Promise<undefined>`）的硬要求，合并时请保留。
- 若采用「使用时读取」，请为 `resolveConfig` 补一条 volatile 解包单测：用 `createVolatile({...})` 造真引用（不要手搓 `{get()}`，会绕过 `Symbol.for("cosmokit.volatile.write")` 协议）。

## 4. 验证方法（可直接复用）

### 4.1 设置页是否出现（隔离实例）

```bash
cd <plugin-root> && dsh-e2e start --wait-ready     # 端口见输出，token 固定 e2etest
PORT=<打印的端口>
curl -s -c /tmp/c.txt "http://127.0.0.1:$PORT/?token=e2etest" -o /dev/null
curl -s -X POST "http://127.0.0.1:$PORT/api/settings/describe" -b /tmp/c.txt \
  -H 'Content-Type: application/json' \
  -d '{"type":"client-request","rpcId":"p1","method":"settings/describe","payload":{"args":{}}}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).result.value??JSON.parse(s).result;console.log(r.namespaces.map(n=>n.ns).join(', '))})"
dsh-e2e stop
```

命名空间出现在列表里 = schema 可被 `volatileForm` 识别；再用 `settings/update`（`{ns, patch, expectedRevision}`）写入一次，重新 `describe` 看 `value` 是否变化，即可验证「原地更新 + 使用时读取」这条链。

### 4.2 双版本类型检查

`npm run check` + `npm test` 走宿主线（当前 0.2.0-rc.2）；再复制一份工程把 `devDependencies` 里所有 `@deepseek-ai/dsh-*` 钉到 `0.1.7-rc.2` 跑 `npx tsc -p tsconfig.json --noEmit`（issue #1 修复时用此法确认区间成立）。

## 5. 已确认的旁证

- 隔离实例（`dsh-base + dsh-web-app + dsh-set-model`）中 `settings/describe` 的 19 个命名空间里没有本插件 —— 与 1.1 的判定一致（当时 Config 无 volatile 标记）。
- 同一实例 `pluginInventory/list` 返回 `dsh-set-model | enabled: true | fiber: active`，说明插件本体加载正常，问题只在设置页。
- 宿主错误日志可在 `<home>/logs/startup-*.log` 里查到历史 `settingsCtx.settings?.installSection is not a function`（0.1.x 时代线上启动日志亦有），确证该调用早已是静默 no-op。
