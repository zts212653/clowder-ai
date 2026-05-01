---
feature_ids: [F184]
related_features: [F176, F183]
topics: [bubble, frontend, rendering, chat-message, dom-mount, debugging]
doc_kind: spec
created: 2026-04-30
---

# F184: ChatMessage Rendering Mount Investigation — F176 撤销后未查的 DOM 缺失真 bug

> **Status**: spec | **Owner**: 待定（建议跨 family review；候选 47 牵头 + Maine Coon review） | **Priority**: P2
>
> **Unblocked**: F183 Phase A 已 done（2026-04-30 team lead自治放行 ADR-033 v2）。F184 立项已解锁；可启动 Phase A repro & diagnosis。
>
> ⚠️ **不可与 F183 实施 Phase B-E 并发**（team lead 2026-04-30 push back：耦合层修改并发 = "又 n 个真相源解决不了了"）。F184 实施按 KD-2 与 F183 Phase B-E 串行排期。

## Why

F176 (Native CLI Assistant-Speech vs CLI-Stdout) 在 2026-04-26 被team lead revert，原因是误诊——把"DOM 缺失"误读成"内容被折叠"。F176 修了不存在的 bug，**真 bug 至今没人查**。

team experience（2026-04-26 01:02，三个感叹号纠正）：
> "我滴吗 这个 f176 你们完全理解错了啊，当时是为了修这个 bug 的，就是Ragdoll和Maine Coon互相 at 然后互相说话了，但是我前端连他们的头像 cli thinking 什么都看不到！！"

`thread_mnux2eewbo4otg17` 实测现象：
- ✅ 顶部Maine Coon GPT-5.5 那条消息：完整渲染（头像 + 标题 + CLI Output）
- ✅ BriefingCard 系统消息 / DirectionPill：正常渲染
- ❌ opus / codex 互 @ 之后的所有 cat 消息：**整条 ChatMessage 不渲染**
  - 没头像 / 没标题 / 没气泡 div / 没 CLI Output
  - 但 messageStore 里有 opus-47 / codex 的 message.content（多条真实存在）

**真问题**：store 有数据，前端 `ChatMessage` 不渲染它们 —— 是 **rendering mount 层** bug，不是 identity contract 层（这就是 F183 不收编它的原因，见 F183 KD-8）。

## What

调查 ChatMessage 不 mount 到 DOM 的根因。候选层（不预设结论）：

- ChatMessage 早 return null（条件判断）
- dedup 误杀
- merge 吃掉
- catData 缺失（catId 找不到 catalog metadata）
- 其它 mount-time 守卫

**禁止凭印象猜根因**（F176 误诊教训）。必须基于 F12 实测 DOM + 代码定位。

## Phases

### Phase A: Repro & Diagnosis（在 F183 Phase A done 后启动）

- 复现 thread_mnux2eewbo4otg17 现场（或新构造同型 thread）
- F12 看 DOM 是否有占位 vs 完全无元素
- 沿 ChatMessage 渲染链定位早 return / dedup / merge / catData / mount 哪一层吃了消息
- 用证据排除每一层，不止血式补 fallback

### Phase B: Fix（与 F183 后续 Phase 串行，不并发）

按 Phase A 结论修对应层；新增 mount-time 守卫测试 + 回归测试。

## Acceptance Criteria

### Phase A（Diagnosis）
- [ ] AC-A1: thread_mnux2eewbo4otg17 现象可复现 + DOM 缺失证据收集（F12 inspect / screenshot）
- [ ] AC-A2: 根因定位到具体 hunk（早 return / dedup / merge / catData / 其他）
- [ ] AC-A3: 与 F183 identity contract 兼容性确认（rendering 层修改不破坏 reducer 假设）

### Phase B（Fix）
- [ ] AC-B1: 修复合入 + ChatMessage 整体不渲染症状消失
- [ ] AC-B2: 新增 mount-time 守卫测试 + 回归测试通过
- [ ] AC-B3: alpha 实测 thread_mnux2eewbo4otg17 现象不复发

### 端到端
- [ ] AC-E1: 与 F183 实施 Phase 不重叠（roadmap 串行约束）
- [ ] AC-E2: 修复方案文档化（F176 误诊教训写进 lessons-learned）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "我前端连他们的头像 cli thinking 什么都看不到" (2026-04-26) | AC-A1, AC-B1 | F12 + alpha | [ ] |
| R2 | F176 误诊后真 bug 没人查 | AC-A2, AC-B1 | code review + repro | [ ] |
| R3 | 不能与 F183 并发去修（避免引入新不一致） | AC-E1 | roadmap 检查 | [ ] |
| R4 | F176 误诊教训沉淀 | AC-E2 | lessons-learned 链接 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式

## Dependencies

- **Blocked by**: F183 Phase A（identity contract 必须先稳定，~2026-05-04 完成）
- **Related**:
  - F176（reverted 2026-04-26，本 feature 是其真 bug 的独立排查 successor）
  - F183（架构层重构；KD-8 明确 F184 不并入 F183 + roadmap 串行）
- **Roadmap 串行**：F183 Phase A done → F184 启动；F184 Phase B 与 F183 Phase B-E 实施时间线串行，不重叠

## Risk

| 风险 | 缓解 |
|------|------|
| 复现失败 | thread_mnux2eewbo4otg17 历史数据已存在，理论可重放；不行就构造同型 thread（多猫互 @）|
| 根因可能横跨 mount 链多层 | Phase A 显式排除每一层，不止血式补 fallback（F176 教训）|
| 与 F183 reducer 改动冲突 | roadmap 串行；每 PR rebase 等 F183 B1 落地后再 merge；冲突率高时主动 hold |
| 重蹈 F176 误诊覆辙 | Spec § Why 必须基于图/原话 verbatim quote；Phase A AC 必须用 DOM 证据，禁止凭印象 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F184 不并入 F183；分 feat 走 | rendering mount 层 ≠ identity contract 层（不同抽象层），F176 误诊教训说明混层修复风险高 | 2026-04-30 |
| KD-2 | F184 立项 + 实施时间线与 F183 串行（team lead push back） | 耦合点：F183 改 message 数据结构 / reducer / cache contract；F184 改 ChatMessage mount——并发会 break 假设 + 文件冲突 | 2026-04-30 |
| KD-3 | Phase A 禁止凭印象猜根因，必须基于 F12 DOM 证据 + 代码定位 | F176 误诊教训：从图 → spec → 实现一路按错误前提推进，4 轮 review + cloud + alpha 验收都没人 push back § Why | 2026-04-30 |
