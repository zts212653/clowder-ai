---
feature_ids: [F300]
related_features: [F233, F293, F167, F220, F153, F276, F296, F298, F299]
topics: [self-sensing, availability, custody, quota, capability, agent-awareness]
doc_kind: spec
created: 2026-08-17
description: "家况可感知：custody/quota/plugin 等 canonical 状态送达猫的判断点——preflight 附带、关键 delta 推送、typed 家况快照"
description_source: human
description_author: fable-5
description_updated_at: 2026-08-18T02:45:00Z
---

# F300: Self-Sensing 首切片 — 家况可感知（Home-State Awareness）

> **Status**: spec | **Owner**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P1

- **operator signoff**: 2026-08-16/17 [thread-id]（`0001786845058052`「新建feat 这个可能要和吴浪提出的sense 结合」+ `0001786950943499` 两 feat 结构确认）
- **Reviewer**: 按 phase 风险路由；spec 阶段 M2 通道选型与 @codex-sol 对齐 F296 delta 语义
- **Architecture cell**: 待 spec 阶段定（消费 custody / route / limb 等既有 cell 的投影与送达面；Map delta 预判 update required——新增送达通道需登记）

## Why

operator experience（2026-08-16 `0001786845058052`）："其实这里他是期待你们在运行过程中可感知到家里整个系统的情况，如果你们想感知。**不是黑盒**。" 三个真实例子：① **取消感知**——You 按了取消并说"换一只猫"，但猫感知不到，还去 @ 一只早已被取消的猫；② **猫粮拓扑**——fable 没猫粮时本质是Ragdoll全家共享猫粮桶都没了，猫只能一只只试错归纳；③ **基建可感知**——说"要语音输入"时猫应立刻知道插件状态，"而不是当你调用之后发现这东西挂了"。

共同根因：**canonical 状态存在（或应存在），但从未到达猫的判断点**。不是猫不勤快，是事实没有送达路径。

## Current State / 现状基线

- 取消/审批等 custody 事件已有 canonical 账本（F233 Phase B，append-only + 16 kinds + 状态机，已按 Close Summary 移交本 feat），但**无猫侧消费面**——例①实测发生过（thread 内猫 @ 已取消的猫）。
- 配额拓扑（家族共享猫粮桶）无结构化查询面——例②实测：fable 断粮时靠逐只试错归纳出共享桶事实。
- F293 route snapshot 已组合 quota/provider health，但只在 route 判断点；`limb_list_available` 已列节点能力，readiness 深度不足以回答例③。
- F233 值班简报（同账本的日报消费形态）已 sunset：65 天 operator 零消费——证明"推送到日报"不是正确送达形态，判断点送达是本 feat 要验证的替代。

## What

### Phase A: Aha 纵切——取消例端到端

M2 关键 delta 推送（主路径）+ M1 动作点 preflight（兜底）在取消场景闭环：You 按取消 → custody 账本记录 → 等球猫下一轮 context 注入 delta（"你等的球已被用户取消"，含事件 ref 可 drill 回账本）；若猫仍尝试 @ 目标猫，preflight 直接附带"该猫 invocation 已被取消"。机制类比 freshness notice，对象从"未读消息"扩到"runtime 事实变化"。M2 通道选型（扩展 freshness notice vs 独立 runtime-delta channel）与 F296 delta 语义对齐后冻结。

### Phase B: M1 全量判断点 + M3 家况快照

M1 扩展到 quota/插件/能力判断点（@ 猫时附带 quota 拓扑事实；说到语音时先查 limb/plugin ready）；M3 `HomeStateSnapshot`——typed references 只引用 canonical 源（custody→F233 账本 / execution→F220 / route→F293 / runtime health→F153 / limb→registry），每项带采集时刻，无中心化复制存储。

## 三层栈定位（operator 2026-08-17 定调，`0001786971350592`）

> 展示层 F299（You 看猫）· **送达层 F300（本 feat，猫看家）** · 持久层 F298（承诺活得够久）——每层终态，不被谁推翻。

本 feat 是**送达层**：把持久层保证活着的事实送到猫的判断点。M2 可靠性以 F298 家族表为前提（#3 InvocationQueue 内存态=队列蒸发即送达承诺断裂；#1 callback auth 蒸发=唤醒即 401）——送达层不修持久层的坑，只声明依赖（F298 已挂双向 consumer 锚点，`d7f39e6b5`）。**custody 移交边界**（2026-08-17 跨 session 裁定）：移交的是 custody **可观测性**账本；持久性归 F298 #3——本 feat 消费账本、不揽持久化活。

## User Journey

### Primary Journey: 取消一只猫，全家都知道
- **Scope unit**: thread
- **Actor**: operator + 猫猫（双主角）
- **Entry**: You 在 Hub 按下某猫 invocation 的取消按钮
- **Flow**:
  1. You 按取消并对协作中的猫说"别喊Ragdoll了，换一只" → 系统写 custody 事件
  2. 等球的猫下一轮**自然知道**（context 注入 delta + 事件 ref），改口喊别的猫——不再 @ 已取消的猫
  3. （兜底）若猫仍 @ 目标猫，preflight 结果附带"已被取消"，猫当轮纠正
  4. You 侧：看到猫的行为正确（不复述取消也不误 @）——日常感知的是"猫变聪明"；取消反馈的 UI 呈现（"已送达等球猫"）在 M2 通道定型后补设计稿
- **Success evidence**: alpha 复现原 bug 行为（红）→ 上线后同场景消失（绿）；对照录屏
- **Non-goals**: 不做常驻家况仪表盘；不推送非关键事实（噪音税，见 OQ-4 注入门槛）

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | thread | 猫猫 | 说到"语音输入" → 先查 limb/plugin ready 再回答，不再调用后才发现挂了 | Phase B 实测记录 |
| S2 | thread | 猫猫 | @ Ragdoll前 preflight 附带 quota 拓扑（家族共享桶）→ 一次判断替代逐只试错 | Phase B 实测记录 |

## Acceptance Criteria

<!-- AC↔Why 同源：A=例①取消感知端到端 / B=例②③判断点可感知；家规=LL-099 只投影不拼接 -->

### Phase A（Aha 纵切：取消例）
- [ ] AC-A1: 用户取消动作产生的 custody 事件在等球猫下一轮 invocation context 中可见（延迟上限 spec 定），注入内容含事件 ref 可 drill 回账本
- [ ] AC-A2: @ 处于 cancelled 状态的目标猫时，路由结果附带 typed 状态 + 事实源引用；无状态可查时显式 `unknown` 不沉默
- [ ] AC-A3: Aha 红绿验收——alpha 先复现"猫 @ 已取消的猫"原 bug（红），Phase A 上线后同场景消失（绿），非作者录屏对照

### Phase B（判断点全量 + 家况快照）
- [ ] AC-B1: quota-exhausted / unreachable / plugin degraded 三类状态在 preflight 附带，含事实源引用
- [ ] AC-B2: `HomeStateSnapshot` 每项引用 canonical owner + 采集时刻，无中心化复制存储（contract test 守护）

## Dependencies

- **Evolved from**: F233（Phase B custody 可观测性账本按 Close Summary 移交本 feat 作 canonical 源）
- **Blocked by**: F298（#3 InvocationQueue 持久化 + #1 callback auth 回源——M2 生产可靠性硬前提；Phase A demo 可先行，生产验收依赖其落地）
- **Related**: F299（视野快照在其 Phase D 交汇：猫决策时看到的 snapshot 进 envelope，You 可确诊"供给 gap vs 猫的 bug"）、F296（M2 delta 语义需对齐其 context epoch 契约）、F293（route preflight 既有机制）、F153（runtime health 源）、F276（人物域 canonical 边界参照）

## Risk

| 风险 | 缓解 |
|------|------|
| M2 推送变成噪音税（猫被无关事实淹没） | OQ-4 注入门槛：只推关键 delta（取消/审批/依赖失效）；M3 是 pull-only |
| 送达层拼接推断冒充事实（重蹈 LL-099） | 家规写死：只投影 canonical 账本；快照每项必须指回 owner；review 检查项 |
| M2 通道与 F296 语义冲突（双 delta 体系） | spec 阶段先与 F296 owner（@codex-sol）对齐再冻结选型 |
| 队列/凭证蒸发导致送达承诺静默断裂 | Blocked by F298 #1/#3 显式声明；生产验收含重启存活场景 |
| 从 UI 可见性反推能力状态（大象谬误） | longform §五原则入 review 检查：capability runtime state 为准 |

## Tips Contribution（F244）

- 计划 1 条 tip（Phase A 落地时提交）：「取消了一只猫？等球的猫下一轮自己就知道，不用你复述」→ truth source: F300 delta 推送机制。

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 三机制（M1 preflight / M2 delta 推送 / M3 快照）对应operator三例子，Aha 选取消例 | 需求 canonical 表述直接映射 | 2026-08-17 |
| KD-2 | 家规第一条：sense 只做 canonical 账本的投影和送达，不做第二真相、不拼接推断 | LL-099 继承；F233 值班简报 sunset 证明消费形态错误而非账本错误 | 2026-08-17 |
| KD-3 | 不做 longform 完整闭环（能力构建+交互适配+Dynamic UI），只做家况可感知首切片 | 验证送达机制后再谈 grounded proposal；防超级系统 | 2026-08-17 |
| KD-4 | custody 边界：消费可观测性账本，持久性归 F298 #3 | 跨 session 裁定（`d7f39e6b5` 双向锚点） | 2026-08-17 |

## Review Gate

- spec 冻结前: M2 通道选型与 @codex-sol（F296 owner）对齐
- Phase A: 实现走 F128 执行 thread，标准跨个体 review + merge-gate；Aha 红绿验收非作者执行
