---
name: expert-panel
description: >
  多猫专家辩论团：在现有协作习惯上加一层轻量编排 + WHY 链标准 + 交付链。
  Use when: 技术趋势判断、竞品分析、行业事件分析、需要多视角决策支持、铲屎官说"帮我分析一下"。
  Not for: 单猫能搞定的问题、代码实现、bug fix、日常聊天。
  Output: 洞察卡片(rich block) + 语音总结 + 正式报告(DOCX/PDF)。
triggers:
  - "帮我分析一下"
  - "专家辩论"
  - "expert panel"
  - "技术参谋"
  - "竞品分析"
  - "行业分析"
  - "趋势判断"
  - "多猫分析"
  - "三猫讨论"
  - "showcase"
---

# Expert Panel — 多猫专家辩论团

**定位：编排层，不是独立流程。** 复用已有协作习惯，只添加三样东西：角色分配、WHY 链标准、交付链。

**核心原则：结论不值钱，论证过程才值钱。**

## 本 skill 只管三件事

1. **角色分配**：按视角分工，确保多元
2. **WHY 链标准**：每个结论必须有证据 → 推理 → 结论（这是 expert-panel 的独有增量）
3. **交付链**：洞察卡片 + 语音 + 报告

其余规则不重写，直接遵循已有 skill。协作交接用五件套（What/Why/Tradeoff/Open/Next）。

## 角色分配

参与猫按视角分工。最少 2 猫，推荐 3 猫。

| 角色 | 视角 | 职责 |
|------|------|------|
| **Analyst** | 架构/技术 | 技术深度、架构对比、可借鉴点 |
| **Assessor** | 风险/成本 | 成本结构、合规风险、踩坑预警 |
| **Strategist** | 生态/趋势 | 行业定位、大图景、用户/人才视角 |
| **Convergence Lead** | 收敛+交付 | 默认 Analyst 兼任，可指定 |

## 最小执行骨架

```
Dispatch → Independent → Synthesis → Contributor Check → Delivery
```

不是刚性 Phase，是自然节奏。有分歧就讨论，没有就是共识，不演。

### 1. Dispatch — 分发独立调研

Convergence Lead 用 `multi_mention` 分发给各猫。

**dispatch payload 只允许包含**：
- 铲屎官的原始问题（一字不改）
- 该猫的角色和视角
- 范围（调研边界）
- 输出格式要求（WHY 链四格）
- 原始材料（如有，如铲屎官发的文件/链接）

**dispatch payload 禁止包含**：
- Lead 自己的判断、倾向、provisional conclusion
- Lead 的拆题方式或 framing（各猫自己决定怎么拆）
- 其他猫的摘要或分析

**Lead 自己的分析等其他猫回来后再发，或和其他猫同时出。**

### 2. Independent — 独立调研 + 独立分析

每只猫独立完成调研和分析，互不可见。

**调研分两档**：

| 档位 | 何时用 | 方法 |
|------|--------|------|
| **Light**（默认） | 日常分析、快速判断 | WebSearch + search_evidence + 已有知识 |
| **Full** | 高 stakes / 铲屎官说"调研" / 需要多源验证 | 启动 `deep-research` skill 完整流程 |

不确定用哪档 → 用 Light。Light 不够再升级。

**独立性保护规则**（从 collaborative-thinking Mode B 内联）：
- 禁止互看：每只猫独立完成，不预测他人观点
- 防锚定：有背景材料时，先形成自己想法再参考
- 标注不确定性：区分确信的结论和猜测

**分析输出格式 — WHY 链四格**：

每个核心判断必须有：
```
Evidence:   具体证据（案例/数据/事件 + 来源URL或引用）
Reasoning:  从证据到结论的逻辑链（为什么这个证据支持这个结论）
So what:    对我们意味着什么（行动含义）
Confidence: 确信 / 中等 / 猜测
```

**禁止**：
- 光给结论不给论证（"基于行业经验" 不是证据）
- Evidence 和 Reasoning 混在一起（拆开写）

### 3. Synthesis — 收敛

Convergence Lead 汇总所有猫的分析，产出收敛报告。

收敛必须包含（来自 collaborative-thinking Mode B Phase 4）：
- 各方观点摘要
- 共识区
- **分歧区**（不抹平！各方理由都保留）
- Tradeoffs / 适用边界（结论在什么场景成立、什么场景不适用）
- Open Questions（待铲屎官拍板）
- 行动项

### 4. Contributor Check — 原作者复核

各猫确认收敛报告没有误读自己的观点。（来自 collaborative-thinking Mode B Phase 5）

这步不能跳过——收敛者可能误读原意。各猫快速确认或修正即可。

### 5. Delivery — 交付

收敛完成后，Convergence Lead **一次性交付**（趁凭证新鲜）：

**a) 洞察卡片**（card rich block）：
- 核心结论（每条附一句 Evidence 和 Reasoning 摘要）
- 共识区 + 分歧区
- Tradeoffs / 适用边界
- Open Questions
- Premortem（最可能翻车在哪）

**b) 语音总结**（audio rich block，~50s）：
- 核心结论 + 最大风险 + 需要拍板的事

**c) 正式报告**（generate_document，优先 DOCX）

**d) 收敛沉淀检查**（来自 collaborative-thinking Mode C）：
```
1. 否决理由 → ADR？[有/没有]
2. 踩坑教训 → lessons-learned？[有/没有]
3. 操作规则 → 指引文件？[有/没有]
```

## 报告结构

1. **命题与范围**：在讨论什么，不讨论什么
2. **核心判断**（每条四格）：
   - Evidence：基于什么证据
   - Reasoning：推理过程
   - So what：对我们意味着什么
   - Confidence：确信度
3. **证据矩阵**：各猫调研发现汇总（来源 + 可靠度）
4. **推理链**：从证据到结论的逻辑链，含分歧点和各方理由
5. **Tradeoffs / 适用边界**：推荐在哪些场景成立、哪些场景不适用
6. **Premortem**：最可能翻车在哪 + 护栏
7. **行动建议**（分层：决策者 / 执行者）
8. **Open Questions**：待铲屎官拍板
9. **独立贡献记录**：各猫的独立判断摘要 + 独特洞察

## 什么时候叠加其他 skill？

| 场景 | 用什么 |
|------|--------|
| 日常"帮我分析一下" | expert-panel 单独用（Light 调研档） |
| 高 stakes 决策、铲屎官说"调研" | expert-panel + `deep-research`（Full 调研档） |
| 分析后需要立项 | expert-panel → `feat-lifecycle` |
| 分析后需要沉淀 | expert-panel → `collaborative-thinking` Mode C |
| 需要和外部猫交接分析结果 | expert-panel → `cross-cat-handoff` 五件套 |

## 交付时机铁律

multi_mention 回调链会反复 supersede invocation 导致 MCP 工具 stale_ignored。

- 洞察卡片在收敛消息里**同步发**
- 语音+报告在**最后一只猫回调时立即发**
- 凭证过期 → 报告存本地 + 告诉铲屎官"下轮对话发"

## Common Mistakes

| 错误 | 修复 |
|------|------|
| Lead 在 dispatch 里夹带自己的判断/拆题 | dispatch 只含原始问题+角色+范围+格式，禁止注入 |
| 默认走 full deep-research | 默认 Light，高 stakes 才升级 |
| Evidence 和 Reasoning 混在一起写 | 拆成两个独立字段 |
| "基于行业经验"当证据 | 必须指向具体案例/数据/事件+来源 |
| 收敛时抹平分歧 | 分歧必须保留+各方理由 |
| 报告结论像万能答案 | 加 Tradeoffs/Boundary，说清适用边界 |
| 跳过 Contributor Check | 收敛者可能误读，原作者必须确认 |
| 报告攒到最后才发 | 趁凭证新鲜立即发 |

## 应急降级

| 风险 | 降级方案 |
|------|---------|
| 某猫超时（>3min） | 不等，剩余猫继续 |
| 语音发不出 | 改文字总结 |
| DOCX 生成失败 | 降级发 card rich block |
| 争论不起来 | 那就是共识，不演 |
| 凭证过期 | 报告存本地 + 下轮对话发 |

## 下一步

- 行动项 → `feat-lifecycle` 立项
- 更深调研 → `deep-research`
- 需要沉淀 → `collaborative-thinking` Mode C
