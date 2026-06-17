---
cell_id: ball-custody
title: Ball Custody Engine
summary: 球权事件流（append-only canonical）、BallCustodyProjection 投影/7 态状态机、blocked/dead/void/parked/zombie 形态结构化判定、best-effort 唤醒（ProbeScheduler/WakeSender，Phase B 后续 Task）。值班简报横切读 projection 替代启发式扫描。
canonical_features: [F233]
code_anchors:
  - packages/shared/src/types/ball-custody.ts
  - packages/api/src/domains/ball-custody/BallCustodyEventLog.ts
  - packages/api/src/domains/ball-custody/BallCustodyProjector.ts
  - packages/api/src/domains/ball-custody/ball-custody-state-machine.ts
  - packages/api/src/domains/ball-custody/BallCustodyProjectionStore.ts
  - packages/api/src/domains/ball-custody/ball-custody-keys.ts
  - packages/api/src/domains/ball-custody/BallCustodyIngest.ts
  - packages/api/src/domains/ball-custody/ball-custody-events.ts
doc_anchors:
  - docs/features/F233-ball-custody-observability.md
  - feature-specs/2026-06-14-f233-phase-b-ball-custody-event-stream.md
static_scan_hints: [BallCustodyEvent, BallCustodyProjection, BallCustodyEventLog, BallCustodyIngest, ball-custody-events, buildHandedEvent, ball-custody-state-machine, ball-custody-projector, ballcustody:events, ballcustody:projection, blockedSinceAt, ProbeScheduler, WakeSender]
cited_by:
  - {feature: F233-Phase-B, date: 2026-06-15, delta: new cell (B1 event-log + projector + state-machine 骨架)}
  - {feature: F233-Phase-B, date: 2026-06-15, delta: B2 PR1 — ingest 层 (BallCustodyIngest append+apply guard) + 路由事件接线 (ball.handed / ball.void_pass)}
---

# Ball Custody Engine

## Canonical Owner

F233 owns the ball-custody event-sourcing infrastructure: append-only Event Log as the single internal-canonical truth for ball custody（谁该对一个责任单元行动）, BallCustodyProjection as a rebuildable projection, and the 7-state ball lifecycle (active/blocked/parked/dead/void/zombie/resolved，加 `new` 初始态) enforced by a pure-function state machine. 值班简报（F233 Phase A）横切读 projection，替代「每次扫 5 源 + 启发式推断」。

## Use This When

- 新增球权事件类型（@ 路由投递 / hold_ball 设释 / invocation 终态 / task 状态转移 / probe 判定）。
- 改球权状态转移规则或形态判定（死球 / 搁置 / 虚空 / 睡美人 / 僵尸）。
- 值班简报 / feat 轨迹消费球权 projection。
- 接入 ProbeScheduler / WakeSender（Phase B 后续 Task：blocked task 探针 + best-effort 唤醒）。

## Extend By

- 向 shared type append 新 `BallEventKind` + 在 state-machine 显式转移表（STATIC_TABLE / DYNAMIC_TABLE）加规则；**INV-10 穷举测试同步**（全 event × state 无未定义）。
- projection 字段 effect 作为纯函数加在 `BallCustodyProjector` 的 `applyFieldEffects`。
- subjectKey 从现有痕迹派生（`ball:thread:{id}` / `ball:task:{id}`），**不引入球 ID 新原语**（KD-1）。
- 接事件源（B2）：写 `buildXxxEvent` 纯函数（`ball-custody-events.ts`，§F sourceEventId + KD-1 subjectKey + classification）→ 在现有系统动作旁路点 **fire-and-forget** 调 `BallCustodyIngest.record`（append + `appended:true` guard → `projector.apply`，照 `community-auto-tracking` 先例，rebuild 安全）。失败仅 log、不阻塞主流程；ingest 注入 `RouteStrategyDeps.ballCustody`（optional, fail-open）。

## Do NOT Unify With

- 不为球权状态加第二个 canonical store。`BallCustodyEventLog` 是唯一真相源；`BallCustodyProjectionStore` 是可重建投影（rebuild=replay，INV-2 无漂移）。
- **唤醒投递（外部副作用）绝不放 projector** —— projector 零外部副作用（rebuild 安全）；投递在 ProbeScheduler 实时 tick 路径（best-effort + per-episode cooldown，plan §E），照 `community-auto-tracking` 的「副作用不放 projector」原则。
- 不做 exactly-once 唤醒事务（KD-4 只读观测优先、不做 workflow engine；spec 只要求真实投递 + 重复可容忍可收紧）。
- 不引入球 ID 新原语（KD-1）；轨迹从现有痕迹推导。

## Static Scan Hints

Watch for new `BallCustodyEvent`, `BallCustodyProjection`, `ballcustody:events:`, `ballcustody:projection:`, `blockedSinceAt`, `ProbeScheduler`, `WakeSender`, or `ball-custody` projector / state-machine code.
