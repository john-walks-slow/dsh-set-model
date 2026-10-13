# 261013-adaptive-reasoning-effort Summary

## 背景与目标

1. DSH 底层（`@deepseek-ai/dsh-llm-pi-ai`）支持完整的 7 级思考深度阶梯：`["off", "minimal", "low", "medium", "high", "xhigh", "max"]`，但 `dsh-set-model` 原本仅声明了 `["off", "low", "high", "max"]` 4 个枚举值，导致 Agent 无法按策略提示词选择 `medium`、`minimal`、`xhigh` 等档位。
2. 不同模型暴露的 `reasoningEfforts` 集合不完全一致（例如 `cpa/omni` 支持 `[off, low, medium, high, max]`、`cpa/medium` 与 `cpa/high` 支持 `[off, low, medium, high]`、`cpa/hybrid` 支持 `[off, high, max]`、非推理模型无 `reasoning`）。若请求或跨模型携带了目标模型未声明的档位，宿主 `ctx.llm.resolveCallConfig` 会直接抛 `UNSUPPORTED_REASONING_EFFORT`。

## 实施内容

- **`src/config.ts`**：将 `REASONING_EFFORTS` 与 `ReasoningEffortSchema` 扩展为完整 7 档 `["off", "minimal", "low", "medium", "high", "xhigh", "max"]`。
- **`src/controller.ts`**：新增 `adaptReasoningEffort(desired, supportedEfforts)` 并在 `applyModelSelection` 中接入：
  - 目标模型无推理能力时自动剥离 `reasoningEffort`；
  - 目标模型直接支持所选档位时原样保留；
  - 目标模型不支持所选思考档位时，沿阶梯 `off < minimal < low < medium < high < xhigh < max` 在非 `off` 候选中就近钳制（距离相同时优先向高档位取整），并在 `set_model` 输出中注明 `(adapted from ...)`。
- **`src/tools.ts` & `src/client/panel.tsx`**：同步更新 `set_model` 工具参数枚举、适配提示文案及 Web 设置页自由模式 Plan 思考强度选项。
- **`test/`**：增强 mock `resolveCallConfig` 的严格档位校验，新增 `adaptReasoningEffort` 与跨模型自适应切换的单元测试。

## 验证结果

- `npm run check`（宿主 + 客户端双 `tsc --noEmit`）通过。
- `npm test` 全部 32 项单元测试通过。
- `npm run build` 构建产物与 `node --check lib/client.js` 校验通过。
