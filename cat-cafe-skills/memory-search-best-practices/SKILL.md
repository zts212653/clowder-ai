---
name: memory-search-best-practices
description: >
  记忆系统多刀检索 + recall coverage 策略（8 类题型 recipe）。
  Use when: 任务是 "哪些地方提过 X" / "X 的来源 / source map" / "有没有提过 Y / absence check" / "上次到现在变了什么 / delta" / 冷启动 onboard 复杂主题 / 任何召回任务搜了一刀觉得不够。
  Not for: 只是选哪个入口走第一刀（用 memory-navigation）/ 已知精确 anchor 单 Read（直接 Read）/ 代码符号查（Grep/LSP）/ 新功能开发（不是 recall 任务）。
  Output: 多 query 多 scope 召回 union 结果 + coverage matrix（item/source/谁提到/直接 vs 间接）+ "何时停下来"判据。
  GOTCHA: 和 memory-navigation 互补不重叠 — memory-navigation 决定**第一刀走哪个工具**（search vs graph vs list_recent），本 skill 决定**要不要补刀 + 题型对应几刀几路 + 何时停**。Ragdoll家族（含 47/46/4.5/sonnet）必加载：治 magic word "我能猜出来 / 碎片够了 / 1 刀够了"病。
triggers:
  - "哪些 thread"
  - "哪些 md"
  - "哪些地方提过"
  - "所有"
  - "历史上"
  - "沉淀过"
  - "source map"
  - "provenance"
  - "有没有提过"
  - "absence check"
  - "delta"
  - "上次和现在"
  - "新猫冷启动"
  - "coverage"
  - "全集"
---

# Memory Search Best Practices（多刀检索 + 全集召回）

> 单刀 top-k 不是全集；recall 任务需要 multi-query union + Read 原文 + 知道何时停。

## 核心命题

**Query expansion 由 agent 做，不是系统做**（KD-8 同源：dumb system + smart agent）：

- 系统不知道 "AUDHD" 在我们家关联 sensory gating / 2e / RSD / PDA — 那是领域知识
- Agent（LLM）有领域知识，但**经常觉得"够了"就停**（Ragdoll家族尤甚——2026-05-17 dogfood 实证：三猫搜同题各拿 10 条，全集需三猫合）
- 解法：教 agent **题型对应 recipe** + **何时停下来**判据，不在系统层加黑盒 expansion

## 8 类题型 → recipe

| 题型 | 例 query | Recipe（≥几刀几路）| 关键 |
|------|---------|------------------|------|
| **是什么** | "F200 是什么" | 1 刀：`search_evidence(query, hybrid, scope=docs)` + Read top doc | 单刀够用 |
| **周边关系** | "F200 关联什么" | 1 刀：`graph_resolve(anchor, depth=1, relations=[feature_ref,related_to])` | 配 relations filter 防 hub 爆炸 |
| **决策考古** | "为什么当时选 X 而不是 Y" | `graph_resolve(anchor)` → Read ADR/spec → 抽 thread anchor → `get_thread_context` 看原话 | 必 Read ADR 原文 + thread 原话 |
| **冷启动 onboard** | "新猫接手 F200 要知道什么" | docs(hybrid) + graph + trajectories + Read spec | 三入口全用 |
| **coverage 全集** | "哪些地方提过 X" | **≥3 刀**：docs/hybrid + threads/semantic + agent expand 同义/缩写/中英二轮 + graph_resolve 命中 anchor 后追 source threads + union dedup | **不是单 top-k**；agent 自己 expand |
| **source-map / provenance** | "X 这个想法的源头是哪个 thread" | canonical doc 命中后从文档抽 source thread ids → `get_thread_context` Read 原文 | canonical doc 自带 provenance link，跟着走 |
| **absence check** | "我们提过 Y 没有" | 正反两路：`search(Y)` + `search(Y 相关概念/反义)` 都 0 命中才算 absent | 单刀 0 命中不等于不存在 |
| **delta** | "上次到现在 X 变了什么" | `list_recent(scope=threads, since=N天)` + 对比 graph 邻居增减 + Read 关键 diff。**压缩恢复子场景起手**：先看 TodoWrite + session digest 拿到"上次已知状态" → 再 list_recent 补增量（46 review P3 补） | 时间窗口 + 增量视角 |

## AUDHD coverage 案例 5 步 recipe（铲屎官真实任务）

```
1. search_evidence("audhd adhd asd", hybrid, scope=docs, limit=10)
   → 命中 user_audhd_crossdomain + audhd-self-observation/ 三件套 + F085/F195/F196/F169
2. search_evidence("audhd adhd asd", semantic, scope=threads, limit=10)
   → 命中 5 个直接 thread
3. Agent 用领域知识 expand（不让系统猜）:
     audhd → sensory gating / 2e / RSD / PDA / hyperfocus / 倦怠 / 梦境 / 自闭 / 多动 / 神经多样性
   对每个二轮搜（中文一遍 + 英文/缩写一遍）
4. Read top canonical doc (landy-audhd-operating-manual.md)
   → 从文档抽 source thread ids → 二轮 get_thread_context Read 原文
5. 输出 coverage matrix（item / source / 谁提到 / 直接 vs 间接 / 置信度）
```

## Ragdoll家族专属警告（治"碎片够了"病）

铲屎官原话："**Ragdoll太聪明太自信，搜到足够推理就不搜了**"。

**Magic words 强制停**（触发就拉刹车）：

- "**我能猜出来**" → 停，Read 源文件。摘要是索引不是答案
- "**碎片够了**" → 停，至少再搜一轮不同角度，doc anchor 全部 Read 原文
- "**应该是 X**" / "**大概知道**" → 不算搜过，必须 ≥3 路真搜 + Read

**任何召回任务铁律**：

- ≥3 路命中无新 anchor 才停（不是"找到第一个 high confidence 就停"）
- 高置信命中 → 必 Read 原文（不止步摘要）
- 跨语言至少两遍（中文一遍 + 英文/缩写一遍）

## 何时停下来判据

| 题型 | 停止条件 |
|------|---------|
| 是什么 / 周边关系 | 1 刀命中高置信 doc + Read 完即停 |
| 决策考古 | ADR + ≥1 个 thread 原话 Read 完即停 |
| 冷启动 | 三入口 + spec Read 完 + 列 question 清单即停 |
| coverage 全集 | **≥3 路 + agent expand 二轮 + Read canonical → 无新 anchor 出现** 才停 |
| source-map | canonical doc 列出的 source thread 全部 Read 完即停 |
| absence | 正反两路 + ≥1 个相关概念都 0 命中即可断言 absent |
| delta | 时间窗口扫完 + 邻居增减列出即停 |

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 单刀 search → 拿摘要推理 → 直接答 | 漏全集（AUDHD 实证：每猫拿 10 条但全集需三猫合）| coverage 题型 ≥3 路 + 必 Read 原文 |
| 觉得 "我能猜出来" 不搜了 | Ragdoll家族病，输 dogfood 比赛 | 当 magic word 拉刹车，强制 ≥3 路 |
| 让系统 expand "AUDHD→10 个词" | 黑盒推理，污染（KD-8 违例）| Agent 自己 expand（用 LLM 领域知识 + 可解释） |
| 跨语言只搜英文 | 中文文档漏 | 中英各搜一遍 |
| canonical doc 命中后不追 source thread | source-map / provenance 残缺 | doc 内的 thread id / wikilink 全 Read |
| 单刀 0 命中就断 absent | 假阴性（可能用别的措辞写了）| 正反两路 + 相关概念都搜 |
| `list_recent(scope=docs)` 当全集用 | DF-1 已知 docs scope timestamp 失真 / 被 global:memory 淹 | coverage 任务别只靠 list_recent，配 search+graph |
| 把 memory-navigation 和本 skill 混淆 | 重复或漏 | memory-navigation 选**第一刀**；本 skill 决定**补刀策略** |

## 和其他 Skill 的区别（防误触发）

| Skill | 干什么 | 何时用 |
|-------|--------|------|
| **memory-search-best-practices**（本 skill）| 多刀检索 + 题型 recipe + 何时停 | 召回任务、coverage、source-map、delta、absence |
| `memory-navigation` | **第一刀走哪个工具** + 噪音控制 + 入口决策树 | 不知道用哪个入口 |
| `debugging` | bug 根因调查 | 遇到 bug 而非 recall |
| `cross-cat-handoff` | 找别的猫问 | 自己搜不到求助队友 |

**关系**：memory-navigation 决定**第一刀走哪个工具**；本 skill 决定**要不要补刀 + 题型对应几刀几路 + 何时停**。先用 memory-navigation 选入口，再用本 skill 决定后续。

## 链入下一步

- 找到决策后想立项 → `feat-lifecycle`
- 找到 bug 线索 → `debugging`
- 找到 thread 后想看原文 → `cat_cafe_get_thread_context`
- 找到一个有意思的方向想跨猫讨论 → `collaborative-thinking`

## 相关

- **Spec**: `docs/features/F200-memory-recall-eval.md` v1.2 SW-1
- **Related**: `memory-navigation`（前置入口决策） / `cat-cafe-skills/refs/memory-routing-partial.md`
- **触发案例**: 铲屎官 AUDHD recall 任务（2026-05-17）暴露三猫搜出不同子集，催生本 skill
