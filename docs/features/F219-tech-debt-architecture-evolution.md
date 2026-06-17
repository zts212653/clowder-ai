---
feature_ids: [F219]
related_features: [F215, F216, F023]
topics: [tech-debt, architecture, refactor, routing, dispatch, vision]
doc_kind: spec
created: 2026-06-02
---

# F219: 核心引擎技术债盘点 + 架构演进

> **Status**: spec | **Owner**: Ragdoll（Ragdoll/Opus-4.8）| **Priority**: P1
>
> **operator signoff**：operator 2026-06-02 04:45 UTC 明确立项 "f219 这个立项哦"，scope = 聚焦核心引擎债（不贪全量），routeSerial 走快线打头。立项前讨论见 Links 讨论草案。

## Why

### 触发（operator experience）

> "我们之后得解决这个债务……不只是 routeSerial 执行流，而是一个 feat 去盘点都有什么恐怖的技术债务，然后分 phase 评估如何去架构演进。"（2026-06-02 03:16）
>
> "scope 别贪'全部技术债盘点'……routeSerial 该走快线，别等全量盘点。"（2026-06-02 立项确认）

### 直接动因：F216 留下的怪物

F216（routeSerial 决策层/执行层分离重构）于 2026-06-02 诚实 close。它交付了 last-wins/supersede 用户价值 + routing decision 可测性，但 **AC-B2 明确标 NOT ACHIEVED**：routeSerial 本体 cognitive complexity 仍 **255**，与立项时完全相同，已确认为**独立技术债**（@gemini25 第三方愿景守护 signoff）。

routeSerial 实测现状（`route-serial.ts`，2026-06-02 核实）：

| 维度 | 数字 | 含义 |
|------|------|------|
| 文件行数 | **2376 行** | F216 拆出决策层纯函数后，本体仍庞大 |
| cognitive complexity | **255**（biome 报警被豁免） | 立项至今未降 |
| 并行路由路径 | **5 套** | inline mention / deferred mention / callback A2A / F215 malformed relay / executed-relay dedup，共享同一可变 `worklist` |
| 可变状态变量 | **15+** | `attemptHasContentOutput` / `suppressedMalformedError` / `shouldRetryWithoutSession` 等同作用域互相影响 |
| 脆弱度（F216 评） | **6/10** | 加任何路由决策都笛卡尔积式炸 edge case |

**不重构的代价**（F216 doc 原话）：后续每个路由相关 feature 都会重演 F215 的 7 轮 review 循环。这是"猫一碰就一堆 bug"的怪物，F215 七轮、F216 都没驯服它。

### 元教训：F216 立项愿景 vs 实际交付的分叉（本 feat 要根治的系统性问题）

F216 是从 F215 thread handoff 立项的。operator诊断根因：

> "立项当时是 F215 还是哪里立项交接过来，导致你们这里可能失去了上下文，所以新的立项你们要好好写清楚愿景。"

F216 doc 的 Why 写的是"降 complexity"，但 scope/AC 实际落地成"修 bug + 提可测性"——两者在执行中悄悄分叉，直到 close 前愿景守护才发现 gap。**这不是某只猫偷懒，是立项时愿景表述不够硬 + 交接丢上下文的系统性问题。**

> **本 feat 对这个元教训的处理：解耦。**
> "技术债盘点 + 架构演进"（工程活）= F219 本身。
> "立项愿景别再分叉"（流程/SOP 改进，事情 B）= **已从 F219 解耦出去**，由 owner 单独走 SOP / self-evolution 改进（KD-3）。原因：软目标若塞进工程 feat，必被盘点工作稀释——又一次分叉。讽刺地，那正是 F219 要根治的病。

## What

### Scope 边界（operator 2026-06-02 拍定 — 必读）

| | 内容 |
|---|------|
| **IN** | 核心引擎债：routing（routeSerial）/ dispatch（InvocationQueue/QueueProcessor）/ session-lifecycle 这一坨反复踩坑的核心调用链 |
| **OUT** | "全部技术债"全量盘点（明确排除——避免 meta-feat 愿景过大自我分叉，重蹈 F216 覆辙） |
| **解耦出去** | 立项愿景纪律 SOP 改进（事情 B，KD-3），不在 F219 交付物内 |

### Phase A: 核心引擎技术债盘点（research-heavy，非写代码）

实测扫描核心调用链，产出**技术债登记册**。每一项必须带：当前脆弱度证据（biome complexity / 文件行数）+ 历史 bug 频次（git log 看哪些文件反复被 hotfix / lessons-learned 反复出现的坑）+ 演进选项 + 预估投入。**禁止凭"感觉这块乱"**。

已知高脆弱度候选（routeSerial 已确认 #1，其余待 Phase A 实测验证，非定论）：

- **routeSerial 执行流** — `route-serial.ts`，2376 行 / complexity 255 / 5 路径共享可变 worklist。**已确认 #1，证据齐全，走快线（见下）。**
- InvocationQueue / QueueProcessor abort-resume + slot/mutex 时序 — dispatch cell，#2003 liveness、F216-c3 supersede 反复踩坑区。
- 前端 bubble/streaming/activeInvocations live-state reconciliation — bubble-pipeline cell，#2018、F194 反复修。
- session lifecycle / 重试 / sealing — identity-session cell，F211 一带。
- **ownership map drift** — routeSerial 无 ownership cell（F216 标 `routing` 但 `docs/architecture/ownership/cells/` 无此 cell），核心路由引擎"无主"。

> Phase A 是 research pipeline（`feedback_research_before_spec`），不跳过 research 直接写 spec。

### Phase B: 架构演进路线评估（expert-panel 多猫圆桌）

对登记册排优先级，每个高优项给"演进方案 + tradeoff + 分期"。多猫圆桌评估（Ragdoll主导设计 + Maine Coon review + 多视角）。

### routeSerial 快线（pilot，与 Phase A 并行，不等全量盘点）

operator 拍定：routeSerial 证据已齐（F215/F216 两 feat 验证），不等盘点 Phase A 完成。它单独走快线，作为 F219 的演进 pilot——既最快止血最痛的债，也为 Phase B 的演进方法论打样。下一步是 routeSerial 本体**状态机化**（state enum + transition table，即 F216 评估为"属于瘦身技术债"的 AC-C1），而非从零拆（F216 已完成决策/执行分离，是"动了一半"不是"原地")。

### Phase C+: 按优先级逐个演进

每个独立子重构按自己的 phase 走，各自有清晰愿景 + 写硬的完成判据（吸取 F216 教训）。

## Acceptance Criteria

### Phase A（盘点）
- [ ] AC-A2: 登记册每项标注 ownership cell；routeSerial 的 ownership gap（无 cell）作为独立条目登记，给出归属建议
- [ ] AC-A3: **Phase A 完成判据写硬**——登记册经至少 1 只非 owner 猫 review 确认"核心引擎模块无遗漏 + 每项证据可复核"，才算 Phase A done（防 F216 式"做着做着算完了"）

### Phase B（演进路线）
- [ ] AC-B1: 登记册按"脆弱度 × 历史bug频次 × 演进ROI"排优先级
- [ ] AC-B2: 每个高优项给演进方案 + tradeoff + 分期，经 expert-panel 多猫圆桌评估

### routeSerial 快线（pilot）
- [ ] AC-R1: routeSerial 本体 cognitive complexity 实测下降（biome lint 为准，目标值 Phase B 定），**不是只提可测性**（区别于 F216 的 AC-B2 教训）
- [ ] AC-R2: merge 前真实 runtime 验证 + 刻意触发 5 套路由场景（LL-064 铁律，core path feat 不只信单测）
- [ ] AC-R3: 零回归——F215 relay + F216 coalesce/supersede 全量路由测试通过

## Dependencies

- **Evolved from**: F216（routeSerial complexity 255 未降转独立技术债，本 feat 接棒）
- **Related**: F215（routeSerial 7 轮 review 引爆点，证明脆弱度）
- **Related**: F185 / ADR-034（dispatch cell busy-gate 分层，invocation 债候选所在）

## Risk

| 风险 | 缓解 |
|------|------|
| meta-feat 愿景过大，自我分叉（重蹈 F216） | scope 锁核心引擎（OUT 排除全量）+ 每 Phase 写硬完成判据（AC-A3） |
| 立项纪律（事情 B）被工程盘点稀释 | 已解耦出 F219（KD-3），不在本 feat scope |
| routeSerial 重构高危，单测假绿 | LL-064：真实 runtime + 刻意触发多路由场景（AC-R2）；F216 的 relay battle-tested block 不轻动 |
| routeSerial 快线与 Phase A 抢资源/上下文污染 | 快线 owner context 纯 routeSerial，盘点并行独立 thread（参照 F216 双向防污染做法） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | scope 聚焦核心引擎债，不贪"全部技术债"全量盘点 | 全量 meta-feat 愿景过大→自我分叉，重蹈 F216；聚焦能更快出价值 | 2026-06-02（operator signoff） |
| KD-2 | routeSerial 走快线 pilot，不等全量盘点 Phase A | F215+F216 已验证其脆弱，证据齐；每天还在核心路径产 bug，不能等 | 2026-06-02（operator signoff） |
| KD-3 | "立项愿景纪律"SOP 改进从 F219 解耦，owner 单独走（✅ 已落地 PR #2034） | 软流程目标塞进工程 feat 必被稀释→又一次愿景分叉（正是本 feat 要治的病） | 2026-06-02（operator signoff "对齐了"） |
| KD-4 | **F23 dir-size Phase 2 拆分协调裁决**：F23 本周可全拆 5 目录（含 `invocation/`），不必等 F219 Phase A 1-2 周 | 唯一真**文件级**冲突点是 `invocation/`（F23 移文件 vs F219 改 QueueProcessor 内容，同一批文件）；`routes/`(147) 是 HTTP handler 层、与 F219 service 层（`routing/`+`invocation/`）正交——callback handler 运行时调 dispatch service 属**调用耦合非文件冲突**，F219 不碰 `routes/` 目录。F23 拆分（移文件+改 import，位置重组）与 F219 重构（改 service 内容/降 complexity，纵向）正交；invocation/ sub-dir 边界（queue/registry/progress…）是好 cell 划分，F219 纵向重构不推翻。F219 本周写操作以 `route-serial.ts` 为主 + Phase A 只读盘点，若快线需触碰 invocation/ 文件提前同步 4.7 错峰。撤回 F23 doc"等 Phase A 06-22"协议（同 4.7 撤回"每周一个"的过度保守，徒增 06-30 deadline 撞墙风险）。低概率 Phase A 若发现 invocation/ 需模块级重组，F219 owner 担责届时协调 | 2026-06-02 |

## Review Gate

- Phase A: 盘点登记册经 ≥1 只非 owner 猫 review（AC-A3）
- routeSerial 快线: 跨族 review（Maine Coon优先）+ remote review + 真实 runtime 愿景守护（LL-064）
