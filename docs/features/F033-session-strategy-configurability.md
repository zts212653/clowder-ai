---
feature_ids: [F033]
related_features: [F065, F211, F225]
topics: [session, strategy, configurability]
doc_kind: note
created: 2026-02-26
---

# F033: Session Chain 策略可配置化

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26
> **Completed**: 2026-03-04

## Why

- 2026-02-18 PR #29 事故反思 → 2026-02-21 operator扩展方向

## What

- **F033**: Session Chain 的阈值和策略（handoff/compress/hybrid）per-cat 可配置。Phase 1 完成（PR #71）：SessionStrategyConfig + shouldTakeAction() 三策略决策 + invoke-single-cat 策略驱动 + session-hooks 策略感知 + compressionCount 追踪 + atomic Lua CAS。Phase 2 完成：catFeaturesSchema 扩展 sessionStrategy + getConfigSessionStrategy() 接通 `.cat-cafe/cat-catalog.json` + seal-thresholds.ts 合并删除 + SessionChainPanel compressionCount 展示 + 71 tests。Phase 3 完成（PR #73）：Runtime UI + 实战调优。设计: 2026-02-21-f33-session-strategy-configurability.md（Maine Coon R3 放行）。
- **2026 follow-up（upstream issue #1329）**: Session State/Chain 变为始终可见的独立状态层；`handoff`、`compress`、`hybrid` 只保存operator的策略意图；managed invocation 依据当次可证明的 capability 单独投影 `active`、`degraded` 或 `unavailable`，不得静默改写策略。策略修改从下一次 invocation 起作用于当前 active session。

## User Journey

Scope unit 是一个 user × cat × thread 的当前 active session。

1. operator首次调用 member 时，即使 provider 从不发 `session_init`，Session Chain 也出现一个逻辑节点；后续 runtime ID 只绑定到该节点。
2. operator在 Hub 选择任一策略并保存。选择始终保留，界面另行显示本次执行能力及缺失原因，不隐藏选项、不替换策略。
3. 正在运行的 invocation 继续使用启动时快照；同一 active session 的下一次 invocation 读取新 revision，并把 config/source/revision/status 写入审计事件。
4. `handoff` 仅在本次 invocation 同时证明有效 input ceiling、carrier binding、权威 usage、session rotation 和 continuity bootstrap 时执行；证据不足时保持 handoff 意图并报告 unavailable，不 seal。
5. `hybrid` 只消费当前 policy revision 的原子 compression progress；未知 lifetime count 显示为 unknown，不等同于 observed zero。
6. 旧 `sessionChain:false` 仅在没有显式策略时读时迁移为 `compress`；新 API 不再写 legacy byte，保证回滚读取仍可用。

## Acceptance Criteria

- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC-A2: session state creation、lookup、persistence 与 UI visibility 不再受 legacy toggle 或策略控制。
- [x] AC-A3: policy intent 与 capability execution status 分离，所有 managed invocation 使用不可变 revision snapshot。
- [x] AC-A4: handoff 缺任一当次权威证据时不采取 lifecycle action；hybrid progress 与 nullable lifetime telemetry 分开。
- [x] AC-A5: legacy false 采用 explicit-policy-first 的 dual-read/single-write migration；策略从下一 invocation 起作用于当前 active session。

## Key Decisions

- Phase 1 完成**（PR #71）：`SessionStrategyConfig` + `shouldTakeAction()` 三策略决策 + `invoke-single-cat` 策略驱动 + `session-hooks` 策略感知 + `compressionCount` 追踪 + atomic Lua CAS
- Phase 2 完成**：`catFeaturesSchema` 扩展 sessionStrategy + `getConfigSessionStrategy()` 接通 .cat-cafe/cat-catalog.json + `seal-thresholds.ts` 合并删除 + `SessionChainPanel` compressionCount 展示 + 71 tests
- Phase 3 完成：Runtime UI + 实战调优（运营阶段，非代码交付物）
- #1329 follow-up 将 always-visible state、stored policy intent、capability execution status 分为三个契约层；能力不足只影响 status/action，不改写策略。
- 遗留项：TD094（压缩效率检测）、TD095（MEMORY.md auto-dump）

## Dependencies

- **Related**: F065、F211、F225
- F033

## Risk

| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
| capability 缺失时策略被静默改写 | policy snapshot 与 execution status 分字段持久化；测试锁定 no-rewrite |
| 未知 compression 历史误触 hybrid seal | lifetime count 使用 nullable telemetry；policy-local progress 按 revision 原子计数 |
