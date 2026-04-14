---
feature_ids: [F155]
related_features: [F087, F110]
topics: [guidance, onboarding, ux, interactive]
doc_kind: spec
created: 2026-04-09
community_issue: "clowder-ai#409"
community_pr: "clowder-ai#398"
---

# F155: Scene-Based Guidance Engine — 场景式交互引导

> **Status**: needs-discussion | **Source**: Community (mindfn) | **Priority**: TBD

## Why

用户使用复杂功能（如添加成员、配置 Provider）时缺乏上下文引导。F087/F110 的训练营解决了"首次入门"，但用户在日常操作中遇到具体功能时仍然需要分步交互引导。

社区贡献者 mindfn 在 clowder-ai#409 提出并实现了完整的 Phase A 方案。

## What

### Phase A（clowder-ai#398 已实现）

1. **YAML 驱动的引导流程定义** — `guides/flows/*.yaml` + `guides/registry.yaml`
2. **引导状态机** — `offered → awaiting_choice → active → completed/cancelled`（前向 DAG）
3. **前端 Overlay** — mask + spotlight + HUD（tips + progress dots + exit button）
4. **Auto-advance 引擎** — 4 种推进模式：`click` / `visible` / `input` / `confirm`
5. **后端回调路由** — guide-action routes + completion ack + one-shot consumption
6. **路由集成** — `guideOfferOwner` / `guideCompletionOwner` 注入 parallel/serial routing
7. **SystemPromptBuilder 注入** — 引导上下文写入猫猫系统提示
8. **MCP 回调工具** — 让猫猫触发引导
9. **Esc Guard** — 引导期间阻止误关 Hub
10. **Guide Authoring Skill** — 编写新引导流程的 SOP

### Phase A 收尾（merge 后立即处理）

- [x] 移除 `retreatStep` 死代码（与 KD-9 forward-only 矛盾）
- [x] 添加 `schemaVersion` 到 YAML flow 格式 + loader 启动校验（缺省按隐式 v1 兼容过渡）
- [x] 无障碍：focus trap with target passthrough, focus restore, throttled aria-live, prefers-reduced-motion degradation
- [x] 遥测埋点：`cat_cafe.guide.transitions` OTel counter at lifecycle layer (offer/start/preview/cancel/complete/control)
- [x] 明确文档化 state authority 层级（见下方 State Authority 章节）

### Phase B（架构重构 + 产品扩展）

**架构重构**（来自 Design Review 2026-04-10）

- [ ] **路由解耦**：将 guide candidate resolution、offered/completed injection、completionAcked write-back 从 `route-serial`/`route-parallel` 提取到 `GuideRoutingInterceptor`，路由核心保持 guide-agnostic
- [ ] **SystemPromptBuilder 解耦**：108 行 guide 注入提取为 `GuidePromptSection` builder，由主 builder compose
- [ ] **CustomEvent 迁移**：移除 `window.addEventListener('guide:start')` 桥接层，改用 Socket.io（server→client）+ Zustand actions（client-side）
- [ ] **GuideSession 领域对象**：从 thread-scoped `guideState` 迁移到独立 `GuideSession` store `{ threadId, userId, guideId, sessionId, state }`
- [ ] **文件拆分**：`callback-guide-routes.ts` 状态机迁移到 domain service；`GuideOverlay.tsx` 继续向 `guide-overlay-parts.tsx` 分解
- [ ] **关键词触发策略层**：confidence threshold + 用户 dismiss-rate tracking + explicit action triggers（slash command / button），防止 hijack 正常对话

**产品扩展**

- [ ] 更多平台内场景（Provider 配置、Hub 设置等）
- [ ] Guide Catalog UI
- [ ] 进度持久化

## State Authority

Guide state flows through three layers with a strict authority hierarchy:

```
Redis guideState (authority) → Socket.io events (sync) → Zustand session (projection)
```

### Layer 1: Redis `guideState` — Single Source of Truth

- Stored on `thread.guideState` as `GuideStateV1` (B-4 will migrate to independent `GuideSession`)
- All state transitions validated server-side (forward-only DAG)
- One active guide per thread — `guideId` mismatch rejects new offers

### Layer 2: Socket.io — Sync Channel

- Events: `guide_start`, `guide_control`, `guide_complete`
- User-scoped (`emitToUser`), not thread-broadcast — critical for shared default thread
- Frontend rehydrates on socket reconnect or thread switch

### Layer 3: Zustand `guideStore` — Projection Only

- `GuideSession` in Zustand is a **read projection**, never authoritative
- Frontend optimistically shows UI (overlay, HUD) but completion requires server confirmation
- Three-state completion: `saving → persisted → failed` with server reconciliation
- If Zustand and Redis diverge, Redis wins — frontend recovers on next socket event

### Default Thread Special Case

The default thread (`threadId: 'default'`) is shared by all users. This creates unique constraints:

1. **Self-heal blocked**: `isSharedDefaultThread()` prevents `start`/`preview` endpoints from manufacturing guide state when `!gs` — any authenticated user could occupy the single guide slot
2. **User-scoped events**: Socket events use `emitToUser`, not `emitToThread` — prevents guide UI leaking to other users
3. **Access guard**: `canAccessGuideState()` checks `gs.userId === requestUserId` — one user's guide doesn't block or interfere with another's
4. **Foreign reoffer suppression**: Routing layer skips guide injection for cats that didn't originally offer the guide on this thread

## Key Decisions（社区侧）

| ID | Decision |
|----|----------|
| KD-9 | v2 auto-advance: 用户操作即推进，无 next/prev/skip 按钮 |
| KD-13 | Phase B 聚焦平台内引导，外部平台配置改独立页签 |
| KD-14 | 引导期间禁用 Esc 退出，仅保留 HUD 退出按钮 |
| KD-15 | Observe substrate 拆分为独立 feature，不入 F155 Phase B |
| KD-16 | Guide session 是 ephemeral 的：`IGuideSessionStore` 提供扩展点，`InMemoryGuideSessionStore` 为默认实现。重启清空所有 session，不承诺 cross-restart resume / 多实例一致性 / dismiss 计数持久化。如需 reconnect-resume，实现 `PersistentGuideSessionStore`，routing/lifecycle/prompt 层无需改动 |

## Acceptance Criteria

TBD — 待 intake 讨论后确定。

## Risk

- **HIGH**: 深度修改 routing core（route-parallel/serial/invoke-single-cat/SystemPromptBuilder）
- 社区方案 Q4 UNKNOWN — 缺长期 owner

## Intake 评估（待完成）

### 主人翁五问初判

| Q | 问题 | 判定 |
|---|------|------|
| Q1 | 方向与愿景一致？ | PASS — 提升复杂功能可用性 |
| Q2 | 与现有 Feature 冲突/重叠？ | 不冲突 — F087/F110 是入门训练营，F155 是操作级上下文引导 |
| Q3 | 技术栈 fit？ | PASS — TS/React/MCP/Socket 全栈 |
| Q4 | 维护能力？ | **UNKNOWN / NEEDS-OWNER** — 72 commits 证明社区持续迭代，但不等于我们有长期 owner + 支持能力 |
| Q5 | 技术负债？ | **HIGH** — 深度修改 routing core（route-parallel/serial/invoke-single-cat/SystemPromptBuilder），非隔离模块 |

### Blockers（merge 前必须解决）

1. **Accepted issue 未过门禁** — clowder-ai#409 只有 `feature:F150`，缺 `triaged` 标签，不满足 inbound merge gate。且 `feature:F150` label 描述指向的是另一个 feature（tool-usage-stats），upstream 编号真相源已漂移
2. **冲突标记残留** — PR 中 `docs/ROADMAP.md` 带着 `<<<<<<< HEAD` 冲突标记，即使 CI 绿也不是干净的 merge-ready 状态

### Intake Shape

这个 PR **不是** `safe-cherry-pick`，而是 `absorbed + manual-port` 混合型：

- 如果我们接，接的大概率是**产品能力定义 + 部分实现**，不是整包吞掉 routing core 的耦合改动
- `route-serial.ts`（+158）、`route-parallel.ts`（+158）、`invoke-single-cat.ts`、`SystemPromptBuilder.ts`（+108）这四个文件的改动需要逐行评审，可能需要重构为更松耦合的注入方式
- 前端 overlay + guide store + YAML catalog 相对独立，吸纳成本较低
- 结论：**吸纳的是 feature 定义，不是批准整包实现**

### Security / Concurrency Risk

PR 后半段（04-09 的 20+ commits）连续修了以下问题，说明 `guideState` 与 routing core 的交叉面很敏感：

- default-thread owner check（`enforce per-user owner checks`）
- foreign non-terminal reoffer suppression（`suppress foreign default-thread reoffers`）
- stale local `guide:start` gate（`gate stale local guide starts`）
- guide state scoping by user（`scope shared guide state by user`）
- completion ack timing（`defer completionAcked write until owner cat receives injection`）

后续 intake 必须按**高风险改动**看待，需要完整的安全 review。

### 待讨论

- [ ] 路由层改动是否接受？是否需要重构为更松耦合的注入方式？
- [ ] 社区自建的 `guide-authoring` / `guide-interaction` skill 依赖的 guide tool surface 需要和我们 capability matrix 对表，否则 skill 文档吸进来是悬空的
- [ ] `guides/` 顶层目录是否符合我们的目录结构？
- [ ] 谁是家里的长期 owner？（Q4 needs-owner）

## Upstream Links

- Issue: [clowder-ai#409](https://github.com/zts212653/clowder-ai/issues/409)
- PR: [clowder-ai#398](https://github.com/zts212653/clowder-ai/pull/398)
