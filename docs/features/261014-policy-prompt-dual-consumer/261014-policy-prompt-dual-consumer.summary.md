# 实施总结：策略提示词统一为「Agent + Jev」共用的单一出处

- **目标目录**：`/root/projects/dsh-set-model`
- **对应版本**：`0.3.0`（同版本还带出未发布的 `independent switches` / `preset effort-only` / Jev 自动切档位）
- **交付状态**：已完成（单测 61 项 + 设置页 e2e 24 项全绿）

---

## 1. 需求

改造前「阶段 → 档位」这条策略有三个载体，读者各不相同且互不声明：

| 载体 | 进 Agent 提示词 | 进 Jev 判据 |
|---|---|---|
| `policyPrompt` 自由文本 | 总是（只要有内容） | ❌ |
| `preset.when` | ✅（花名册行尾） | ✅（criteria） |
| `preset.name` / `id` | ✅ | 仅当 `when` 为空时兜底 |

由此产生的问题：用户写的策略文本对自动决策完全不可见（手动策略与自动决策读两份数据）；同一信息在提示词里出现两遍且可能矛盾；`when || name || id` 的静默回退让 Jev 只剩档位名可判却没有提示；`policyPrompt` 在工具全关、Jev 也关的部署里仍被注入。

本次要求：**`policyPrompt` 是这条策略的唯一出处**，同时供 Jev 决策与 Agent（在它持有调模工具时）使用；并顺手把静默问题暴露成 warning，再调整设置页布局——把原本顶部的两个工具开关下移。

## 2. 实现

| 位置 | 变更 |
|---|---|
| `src/jev.ts` | `queryJevPresetDecision` 的入参由 4 个位置参数收敛为 `JevDecisionRequest { context, presets, policyPrompt? }`；payload 的 `state` 在无策略时保持纯字符串，有策略时变为 `{ policy, context }`（Decisions API 的 `state` 本就接受对象）；`runJevModelInference` 传入 `initialConfig.policyPrompt` |
| `src/presets.ts` | `renderModelPolicySection` 注入策略文本的条件改为 `enableModelTools \|\| enablePresetTools`（Agent 侧）；档位清单条件不变 |
| `src/config.ts` | 两条新 warning：`policyPrompt` 有值但无任何读者；`jevEnabled` 时存在缺 `when` 的档位。`policyPrompt` / `when` 的 schema description 同步说明读者 |
| `src/client/panel.tsx` | 顶部两个工具开关下移，与 `allowedProviders` 合并为「Agent 调模能力」卡片，置于策略提示词之下；策略提示词标签改为「告诉 Agent 与 Jev 各阶段该用哪个模型/档位」并补一行作用范围说明；档位「适用阶段」标签补充「Jev 也据此判定」 |
| `e2e/fixture/cordis.patch.yml` | 清理 0.2.1 已删除的 `mode` / `enableAgentTools`，改为两个独立开关 |
| `e2e/verify-policy-page.mjs` | 删除已不存在的模式单选组断言；新增「策略提示词位于工具开关之上」的布局断言；Plan 目标守卫改为操作档位下拉；新增截图步骤产出 README 首图 |

## 3. 关键设计

- **一份文本、两个读者、各自的到达条件**：Agent 只在能执行它的时候读到（有调模工具），Jev 在开启时随请求读到。两者都不在时该配置不被读取——不写进提示词，也不发往网络。
- **策略与态势分开送到 Jev**：`state.policy` 是部署规则，`state.context` 是当前指令与上一轮回复；命名分开，让决策模型不必从一段混合文本里猜哪句是规则。
- **判据缺口显式化**：`when` 从「给提示词看的一行文案」升级为「Jev 的判定依据」，缺它就是缺判据，因此给 warning 而不是静默用档位名兜底。
- **布局按「定义 → 策略 → 授权 → 自动化」排序**：档位表（什么是档位）→ 策略提示词（怎么用）→ Agent 调模能力（把能力交给谁、范围多大）→ Plan 模式 → Jev。工具开关从顶部移出后，设置页第一眼看到的是它实际要维护的对象。

## 4. 影响面与注意

- **行为变化**：工具开关全关且 Jev 关闭的部署，`policyPrompt` 不再注入系统提示词（此前会注入）。其余组合不受影响。
- **Jev 请求体变化**：配置了 `policyPrompt` 时 `state` 由字符串变为对象；未配置时保持字符串。只消费 `answers` 的调用方无感知。
- `JevDecisionRequest` 是内部导出（单测直接调用），不是对外 API。

## 5. 测试

- `npm run check` / `npm test`（61 项，新增 4 项：策略随请求送出、策略注入门槛、两条新 warning）/ `npm run build` 全绿。
- **设置页 e2e**（`dsh-e2e start --patch e2e/fixture/cordis.patch.yml` + `dsh-e2e run e2e/verify-policy-page.mjs`）：24 项全绿，含开关状态与种子一致、策略提示词位于工具开关之上、保存 → 重载持久化、Plan 目标守卫；`assets/model-policy-settings.png` 已按新布局更新。

![动态模型设置页](../../../assets/model-policy-settings.png)
