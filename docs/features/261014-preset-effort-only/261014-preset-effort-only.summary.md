# 实施总结：档位可不绑定模型（只调思考深度）+ 内置三档默认

- **目标目录**：`/root/projects/dsh-set-model`
- **对应版本**：`0.2.1`（不兼容旧配置语义的放宽，见 §4）
- **交付状态**：已完成

---

## 1. 需求

只用 Jev 切换**思考深度**，不切换模型。为此需要：

1. 档位可以只声明 `reasoningEffort` 而不指定 `provider` / `model`；
2. 档位模式的默认值就是 `low` / `medium` / `high` 三档，且都不绑定模型（零配置即可用）。

## 2. 实现

| 位置 | 变更 |
|---|---|
| `src/config.ts` | `provider` / `model` 加 `.default("")`；`normalizePresets` 改为「两者同时填写或同时留空」，只填一个报 problem 并丢弃该条；新增 `DEFAULT_PRESETS`（low/medium/high，均不绑定模型，各带 `when` 判定描述）；`presets` 的 schema 默认改为 `DEFAULT_PRESETS`；`resolveConfig` 在 `presets` 未声明或为空时一律回落到 `DEFAULT_PRESETS`（该规则在同日的 `261014-independent-switches` 中收紧：不再区分「未声明」与「显式空数组」） |
| `src/config.ts` | `ResolvedModelPreset.provider` / `.model` 变为可选 |
| `src/presets.ts` | `presetToSelection` 未绑定路由时只交出 `reasoningEffort`（`applyModelSelection` 本来就会用当前会话补齐 provider/model）；新增 `pinsRoute`；`matchPreset` 改为「钉死路由优先、组内精确 effort 优先」；`formatPreset` 对未绑定路由的档位渲染为「沿用当前模型」 |
| `src/jev.ts` | `isSameSelection` 对未绑定路由的档位只比较思考深度；切换日志的 route 段回退为 `current model` |
| `src/tools.ts` | `list_presets` 的 `provider` / `model` 不再 `required`，未绑定时不输出该字段 |
| `src/client/panel.tsx` | Provider 选择器的空值文案改为「沿用当前模型」；未绑定模型时 Model 选择器置灰；未绑定模型时思考强度下拉交出完整档位列表（没有模型目录可查）；校验改为「provider 与 model 同时填写或同时留空」；新增 `REASONING_EFFORT_IDS` 常量并复用到自由模式 Plan 目标 |

## 3. 关键机制

- **「留空 = 沿用当前模型」不需要新的应用路径**：`applyModelSelection` 的既有语义就是 `target.provider ?? current.provider` / `target.model ?? current.model`，因此未绑定路由的档位天然只改思考深度。
- **零配置可用**：`jevEnabled: true` 且不声明任何 `presets` 时，Jev 的判定空间就是内置三档，判定依据是每档的 `when` 文案。

## 4. 影响面与注意

- 旧配置里 `provider` 只填了一个的档位，此前报「id, provider and model are all required」，现在报「provider and model must both be set or both be empty」，同样被丢弃。
- 未声明 `presets` 的部署现在会拿到内置三档：策略清单会多出三条；`jevEnabled` 为 true 时 Jev 不再因「无档位」而空转。由于 Jev 不区分模式，**自由模式**下开启 `jevEnabled` 也会按内置三档调节思考深度（`jevEnabled` 默认 false，不受影响的部署无变化）。
- 内置档位不绑定模型，因此不会把用户在 GUI 手动选择的模型拉回去。

## 5. 测试

`npm run check` / `npm test`（57 项）/ `npm run build` 全绿。新增覆盖：

- `resolveConfig`：内置三档、未声明回落到内置、显式空数组报 problem、半填路由报 problem 且继承型档位保留；
- `presets`：未绑定路由的档位只交出思考深度、匹配优先级、内置档位的策略清单渲染；
- `apply`：**Jev 选中未绑定路由的档位时只改思考深度、模型保持不变**（走真实 `agent/pre-step` step 1）。
