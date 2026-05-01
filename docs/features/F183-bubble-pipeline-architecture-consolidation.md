---
feature_ids: [F183]
related_features: [F081, F117, F123, F164, F176]
topics: [bubble, message-pipeline, identity-contract, websocket, idb-cache, reconcile, refactor, architecture, observability]
doc_kind: spec
created: 2026-04-30
---

# F183: Bubble Pipeline Architecture Consolidation — 消息气泡管线架构收敛

> **Status**: in-progress | **Owner**: Ragdoll/Ragdoll (Opus-47) 牵头 | **Priority**: P1
>
> Phase A 已 done（2026-04-30，team lead自治放行 ADR-033 v2）。Phase B0 已 merged（PR #1496，commit `a6be5970e`）。Phase B1.1 reducer core 已 merged（PR #1500，commit `2fbde77ec`）；Phase B1.2+ 继续收口热写入口（roadmap 串行）。

## Why

team lead 2026-04-30 原话：

> "我们家前端对于后段 cli 出来的输出流的气泡（这里是包括任何气泡）cli 也好 thinking 也好各种东西也好，为什么经常有 bug？太奇怪了！一个气泡为什么经常出 bug 呢？好像涉及到 前端？redis？chrome 缓存？经常遇到的就是气泡裂了！气泡不见了！F5 之后气泡不裂了！F5 之后气泡出来了！猫猫发完消息气泡才出来！"

> "我们这个得写一个 ard 或者什么架构设计文档？梳理一下这个架构设计 然后立项一个 feat 重构也好优化也好 好好的看看这整体？未来修改代码就有架构图可以看和参考，避免老出问题？现在定位了个大概出来 然后能如何优化呢？你组织大家讨论一下？不要当独裁猫猫 我发现你们加在一起视角可能最全。"

### 为什么 F081 (done) + F123 (done) 修过还在反复发作

1. **四个真相源在互相竞争**：Redis MessageStore（持久化 SoT）/ Redis DraftStore（5min TTL）/ IndexedDB（前端持久化）/ Zustand+Ledger（页面生命周期）—— 任意两个不一致就会出视觉 bug
2. **identity 多键且按 provider/分支补**：OUTER `parentInvocationId`（live broadcast）vs INNER `ownInvocationId`（formal persistence）—— 每加一个新 provider/分支都得重写一次 #573 contract（route-serial → route-parallel #1433 → Codex MCP `1ed5f5b46`）
3. **`messages` 写入口有 8+ 条**：active stream / background stream / callback / draft / queue / hydration / replace / 各 provider transform —— F081 audit 数过 104 个写入点；统一 MessageWriter 在 F123 KD-4 主动推迟，导致每加路径都漏 contract
4. **WebSocket fire-and-forget + 5min hard timeout**：in-process event bus 在长 invocation 下 backpressure（`dropped 32 events`），PR #1432 修了 timeout 分支自动 catch-up 但没修 backpressure 根因
5. **`mergeReplaceHydrationMessages()` 5 种匹配策略复杂度失控**：每加一种消息 origin（如 F176 的 messageRole）都得更新 merge 函数，漏一个 case = 新 bug

### 这次和 F081/F123 不一样在哪

- F081 修的是"已显示气泡的连续性"（监控视角）
- F123 修的是"identity contract 在已知路径上不裂气泡"（症状视角）—— 但 F123 名义 done 实际欠债 TD111-TD114（统一 identity contract、store invariant、placeholder 单调升级、duplicate 断言）
- **F183 修的是"架构层不再有四源竞争 / 写入口爆炸 / merge 启发式"**（结构视角）—— 把 TD111-TD114 收编 + IDB cache invalidation contract + websocket 序列号 + ack/gap 一起做

副愿景：**Spec 内嵌的 Architecture Map 成为未来开发者改动消息管线时的强制参考真相源**，让"加一个新 provider/路径"不再触发新一轮气泡 bug。

## What

> Phase 拆分骨架（最终 Phase 由 Phase A discussion 拍板，下方为讨论锚点）。

### Phase A: Architecture Discovery & Identity Contract（讨论收敛 + 架构图 + 真相源沉淀）

- 把四猫诊断（46 / 47 / Maine Coon / Siamese）收敛到一份 architecture map asset（`docs/features/assets/F183/architecture-map.{md,svg}`）
- 拍板 bubble identity 真相源契约：稳定身份 = `(catId, invocationId, bubbleKind)`；OUTER 优先于 INNER，per-cat INNER 仅做生命周期 key 不做前端 identity
- 列清所有"`messages` 写入口"清单（继承 F081 audit 104 写入点 + 新增 provider 后的增量）
- 拍板 sunset 路径：F123 TD111-TD114 接收范围 + IDB cache invalidation contract + websocket 序列号 contract
- 产出 ADR-033（或在本 spec 内嵌 architecture map，由 Phase A discussion 拍板）

### Phase B0: Replay Harness + Store Invariant Gate（先立防线，不改热路径）

- `BubbleEvent` 14 类 TypeScript 枚举 + `BubbleKind` 5 类枚举落地为 shared contract
- dev/test 模式 store invariant 硬断言（duplicate stable identity / phase 逆行 / canonical key split）
- runtime diagnostics 最低契约落地：13 字段 violation log + bubble timeline dump 入口
- Replay harness 框架接住 F123 既有 fixture 套件，预留 BubbleEvent payload schema 扩展位
- 不修任何已有写入口，避免在没有 Single Writer 之前改热路径

### Phase B1: Single Writer / Reconcile Reducer（统一写路径）

- 所有 stream/callback/draft/queue/hydration 入口收敛到单个 `MessageWriter` / reconcile reducer
- `mergeReplaceHydrationMessages()` 5 种匹配策略简化到 ≤ 2 种（按 stable identity 直接 dedup + monotonic upgrade）
- F123 TD111（identity contract）+ TD113（placeholder 单调升级）落地

### Phase C: WebSocket Sequence Number + Ack/Gap Contract（消除 fire-and-forget）

- 所有实时 message event 携带 monotonic seq（thread-scoped or global）
- 客户端维护 `lastSeq`，发现 gap 立即 `requestStreamCatchUp`（不等 5min DONE_TIMEOUT）
- in-process event bus backpressure 根因定位（grep 不到 `dropped X events` 字面源 → 追到底）+ 加 buffer / 限速 / 丢弃策略

### Phase D: IDB Cache Invalidation Contract（消除 cache 放大器）

- 写入 schema 升级 hook：identity contract 变更时清理过时 entries
- IDB 降级为离线 fallback：在线时不参与渲染路径 merge，只在网络断开时使用
- F164 IDB 缓存层补 invalidation hook

### Phase E: Closure + Alpha Soak（防御层补齐 + 闭环 F123 TD）

- dev/runtime 加硬断言："同一 catId + invocationId + bubbleKind 不能进两条 assistant bubble" → 直接报警（B0 已立最小 gate，E 做 full closure）
- F123 TD112（store invariant）+ TD114（duplicate 断言）落地
- replay harness 每条 PR 跑一次完整 fixture 套件

## Acceptance Criteria

> 立项时仅列骨架，Phase A 讨论收敛后细化。

### Phase A（Discovery & Contract）✅ DONE 2026-04-30

- [x] AC-A1: 四猫诊断已收敛到一份 architecture map（assets/F183/architecture-map.{cn,en}.png + .svg by Maine Coon）
- [x] AC-A2: bubble identity 真相源契约（OUTER vs INNER 仲裁规则）已写入 ADR-033 Section 2
- [~] AC-A3: fixture schema 已落地到 `docs/features/assets/F183/fixture-schema.md`；`messages` 写入口完整清单仍保留 F081 audit 的 104 项作为 B1 baseline
- [x] AC-A4: F123 TD111-TD114 全部纳入 F183（KD-A4 拍板，TECH-DEBT.md 已废弃）
- [x] AC-A5: ADR-033 v2 经team lead 2026-04-30 自治放行（"按照家里的要求 好像没有我需要一条条看的，你们自己决策就行"）

### Phase B0（Replay Harness + Invariant Gate）✅ DONE 2026-04-30

- [x] AC-B0-1: `BubbleEvent` 14 类 TypeScript 枚举 + `BubbleKind` 5 类枚举落地到 `packages/shared/src/types/bubble-pipeline.ts`
- [x] AC-B0-2: dev/test 模式 store invariant gate 覆盖 duplicate stable identity / phase regression / canonical key split
- [x] AC-B0-3: 13 字段 `BubbleInvariantViolation` 结构化诊断输出 + `dumpBubbleTimeline` filter 接入
- [x] AC-B0-4: Replay harness 框架落地，支持 reducer 注入、thread-scoped replay、deterministic timestamp、empty-event initial state
- [x] AC-B0-5: PR #1496 通过 `pnpm gate`、云端 Codex review、Opus-47 delta review 后 squash merge（commit `a6be5970e`）

### Phase B1（Single Writer）

- [~] AC-B1: `MessageWriter` / reconcile reducer 落地，所有写入口收敛（B1.1 已落 reducer core；B1.2+ 继续 active stream / background stream / callback / draft / hydration / replace 入口收口）
- [x] AC-B1.1: BubbleReducer core 落地（PR #1500，merge commit `2fbde77ec`），覆盖 stable-key lookup、local placeholder 单调升级、ambiguous upgrade quarantine、deterministic local fallback id、callback_final backend id adoption
- [ ] AC-B2: `mergeReplaceHydrationMessages()` 简化到 ≤ 2 种匹配策略
- [ ] AC-B3: F123 TD111 + TD113 收编完成
- [x] AC-B4: Review `recoveryAction` 默认值是否需要 reducer 覆盖（B0 P2 follow-up 已落地：late `stream_chunk` after `callback_final` 走 `catch-up`；其他 phase regression 走 `quarantine` + violation）

### Phase C（Sequence + Gap）

- [ ] AC-C1: 实时 event 携带 monotonic seq，客户端 gap detection 落地
- [ ] AC-C2: in-process event bus backpressure 根因定位 + 修复
- [ ] AC-C3: `dropped N events` 字面源追溯完成

### Phase D（IDB Contract）

- [ ] AC-D1: IDB schema 升级 hook 落地，identity contract 变更触发清理
- [ ] AC-D2: IDB 降级为离线 fallback（在线时不参与 merge）

### Phase E（Invariant）

- [ ] AC-E1: dev/runtime store invariant 断言落地
- [ ] AC-E2: F123 TD112 + TD114 收编完成
- [ ] AC-E3: replay harness 完整覆盖 F081/F123 历史 fixture + F183 新增 fixture

### 端到端

- [ ] AC-Z1: team lead 2026-04-30 报告的 5 类症状（裂 / 不见 / F5 才正常 / F5 才出来 / 发完才出来）在 alpha 通道实测全部消失
- [ ] AC-Z2: 一个新加 provider / 新加分支不需要再单独写 #573 contract（架构层默认对齐）
- [ ] AC-Z3: Architecture Map 进入 onboarding 路径，未来改动消息管线必须先读

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "气泡裂了" | AC-B1, AC-B2, AC-E1, AC-Z1 | replay test + alpha | [ ] |
| R2 | "气泡不见了" | AC-C1, AC-C2, AC-Z1 | replay test + alpha | [ ] |
| R3 | "F5 之后气泡不裂了" | AC-D1, AC-D2, AC-Z1 | manual + alpha | [ ] |
| R4 | "F5 之后气泡出来了" | AC-C1, AC-Z1 | replay + alpha | [ ] |
| R5 | "猫猫发完消息气泡才出来" | AC-C1, AC-C2, AC-Z1 | replay + alpha | [ ] |
| R6 | "写一个 ADR 或架构设计文档" | AC-A1, AC-A2, AC-A5 | doc review | [ ] |
| R7 | "未来修改代码就有架构图可以看和参考" | AC-Z3 | onboarding 检查 | [ ] |
| R8 | "组织大家讨论一下，不要当独裁猫猫" | AC-A1（多猫收敛） | discussion 落盘 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（Phase A 收敛后补）

## Dependencies

- **Evolved from**: F081（bubble continuity & observability）、F123（bubble runtime correctness）—— F123 KD-4 主动推迟的"统一 MessageWriter"在本 feature 落地
- **Blocked by**: 无硬阻塞；F180（Agent CLI Hook Health）in-progress 不影响本 feature
- **Related**:
  - F117（Message Delivery Lifecycle —— delivery 真相源、queue 模式 dedup）
  - F164（IDB cache 层 —— Phase D 需要其 schema invalidation hook 的合作）
  - F176（reverted —— messageRole 字段加在 merge 复杂度上是 F183 要修复的反模式之一）
  - F045（NDJSON observability —— event 流可观测性是 Phase C backpressure 定位的基础）

## Risk

| 风险 | 缓解 |
|------|------|
| Phase A 讨论发散，三周不收敛 | Discussion 限定 5 个待决问题 + 设拍板时间盒（team lead 1 周内拍板）|
| 重构热路径影响现有聊天体验 | 沿用 F123 fixture-first 节奏，先建 replay harness 再分层替换入口 |
| Single Writer 收口造成 regression | Phase B 上线前必须满足 F123 全套 replay 测试 + alpha 双周验证 |
| backpressure 根因定位失败 | Phase C 拆 sub-phase，先做客户端 gap detection（即使后端没修，体感也已大幅缓解）|
| Architecture Map 沉淀后无人维护 | onboarding 路径强制读 + 改动消息管线 PR 模板新增"是否需要更新 Architecture Map" checkbox |
| F183 scope 失控变成"消息系统全重写" | scope 显式排除：不重做 Provider 协议、不动 A2A handoff 语义、不改 thread/draft 模型；只动"identity contract + writer + reconcile + cache"四层 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 立项 F183 而非 reopen F123 | F123 KD-4 主动推迟统一 MessageWriter，本 scope 是架构级重构，需要独立 owner 与 phase 节奏 | 2026-04-30 |
| KD-2 | Phase A 必须以"四猫独立诊断收敛"为产出 | team experience"不要当独裁猫猫，加在一起视角可能最全" + F176 误诊教训"双猫并行 5/5 收敛 ≠ 正确" | 2026-04-30 |
| KD-3 | scope 显式排除 Provider 协议 / A2A 语义 / thread 模型 | 防止"消息系统全重写"风险，本 feature 只动 identity contract / writer / reconcile / cache 四层 | 2026-04-30 |
| KD-4 | 视觉载体：Maine Coon GPT-5.5 主笔图片生成（手绘风格中英双版）；Siamese Pencil 修复后补细节稿 | Siamese Pencil 插件 CLI 环境连不上；Maine Coon的图片生成是已验证的视觉路径（家里记忆系统图 / 整体架构图都是Maine Coon做的）；不阻塞 Phase A 时间盒 | 2026-04-30 |
| KD-5 | Phase 顺序合并：A → B0 (invariant gate 前置) → B1 (Single Writer) → C (seq) → D (IDB) → E (closure) | Maine Coon + 46 提议合并：B0 立 harness/invariant 框架 + B1/C/D 各 Phase AC 落具体断言，不留窗口期 | 2026-04-30 |
| KD-6 | IDB 形态：provisional cache + 5 metadata 字段（identityContractVersion / cacheSchemaVersion / savedAt / containsLocalOnly / containsDuplicateStableIdentity） | Maine Coon版本：在线不参与 merge 仲裁，保留冷启动画缓存（减少白屏）+ 离线 fallback 能力。比"完全降级"更稳健 | 2026-04-30 |
| KD-7 | TD111-TD114 全部纳入 F183；`docs/TECH-DEBT.md` 已废弃不维护 | team experience"docs/TECH-DEBT.md 这个很久没更新了 建议废弃不要考虑这个"。TD112 partial 实现的事实直接在 ADR-033 + spec 里说清楚 | 2026-04-30 |
| KD-8 | F184（F176 撤销后真 bug）不并入 F183；roadmap 强制串行（F183 Phase A done → F184 启动，禁止并发） | team experience"这个和你们这个会耦合吧... 别并发去修"。耦合点：F183 改 message 数据结构 / reducer / cache contract；F184 改 ChatMessage mount 逻辑——并发会引入新不一致 | 2026-04-30 |

## Review Gate

- Phase A: discussion 收敛报告 + architecture map asset + identity contract 拍板（team lead + 至少 1 只跨 family 猫签字放行）
- Phase B0-E: 每个 Phase merge 前必须满足 relevant replay/invariant tests + `pnpm gate`；涉及 UI/体验的 Phase 还需 alpha 验证
- 全 feature close: 愿景守护猫（非作者非 reviewer 的猫）输出"5 类症状全部消失"的对照表
