# 实施总结：三个独立开关取代 free / preset 模式

- **目标目录**：`/root/projects/dsh-set-model`
- **对应版本**：`0.2.1`（移除 `mode`，不兼容旧配置，见 §4）
- **交付状态**：已完成

---

## 1. 需求

去掉「自由模式 / 档位模式」二选一，改成三个彼此独立的勾选框：

| 开关 | 作用 |
|---|---|
| `enableModelTools` | 注入自由调模工具 `set_model` / `list_models` |
| `enablePresetTools` | 注入档位工具 `switch_preset` / `list_presets` |
| `jevEnabled` | Jev 每轮自动切档位 |

## 2. 实现

| 位置 | 变更 |
|---|---|
| `src/config.ts` | 删除 `mode` 与 `enableAgentTools`（含 `toolEnabled` 别名）及 `ModelPolicyMode` 类型；新增 `enableModelTools`（默认 `true`）与 `enablePresetTools`（默认 `false`），默认值组合与旧行为完全一致；`presets` 为空或未声明一律回落到 `DEFAULT_PRESETS`（删除「零档位」状态与相关 problem/warning）；`planPreset` 匹配不到档位时始终记 problem；`planPreset` 与 `planModel` 同时设置时 warn |
| `src/index.ts` | 工具注册改为按两个开关分别累积；`resolvePlanTarget` 改为「`planPreset` 优先，否则 `planModel`」，未绑定路由的档位记 `沿用当前模型` |
| `src/presets.ts` | 策略清单的渲染条件由 `mode === "preset"` 改为 `enablePresetTools \|\| jevEnabled`；引导语按档位工具是否开启区分 |
| `src/tools.ts` | `list_presets` 输出与 schema 删除 `mode` 字段，渲染行改为 `Plan Mode: active/inactive` |
| `src/client/panel.tsx` | 删除模式单选组；新增三个勾选框；删除重复的「Agent 调模工具」全局开关与 Jev 卡片内的重复勾选框；Plan 目标两组字段同时展示（档位标注「优先」）；`buildOps` 保存时 `unset` 已废弃的 `mode` / `enableAgentTools` |

## 3. 关键设计

- **三个开关完全正交**：Jev 直接调 `applyModelSelection`，不经过 Agent 工具面，因此不依赖也不受两个工具开关影响。
- **默认值组合等于旧默认**：`enableModelTools: true` + `enablePresetTools: false` = 旧的 `mode: free` + `enableAgentTools: true`，老部署升级后行为不变。
- **`presets` 不存在空集**：空或未声明都回落到内置三档，消除了「Jev 无档位可判定」「档位工具开着但没有档位」这一整类边界状态。
- **Plan 目标不再依赖模式**：显式配了档位就用档位（更省事，且可只调思考深度），否则用裸模型路由。

## 4. 影响面与注意

- `mode`、`enableAgentTools`、`toolEnabled` 三个键不再被识别：schemastery 会容忍并忽略它们（不会导致加载失败），但设置页保存时会主动 `unset` 掉。
- 升级到本次改动时，本机 profile 已手工迁移：删除 `mode` / `presets: []`，把 `enableAgentTools: false` 改写为 `enableModelTools: false` + `enablePresetTools: false`（保留原「工具关着」的意图）。
- 档位工具的引导语、策略清单、README 中所有「自由模式 / 档位模式」表述均已改写。

## 5. 测试

`npm run check` / `npm test`（57 项）/ `npm run build` 全绿。覆盖：两个开关各自的注册结果与全关状态、volatile 热更新下的开关切换、`presets` 空值回落、`planPreset` 悬空与遮蔽告警、内置档位的策略清单渲染。

**真机验证**（隔离端口实例 + 无头 Chromium 打开设置页）：
- 插件在迁移后的 profile 配置下正常加载，无 plugin tree 错误；
- 页签显示「动态模型」，三个勾选框文案齐全，无任何 radio；
- 档位列表可见内置 low / medium / high；
- **浏览器控制台零错误**。
