---
feature_ids: [F220]
related_features: [F216, F175, F153, F118, F215]
topics: [a2a, observability, liveness, invocation, queue, interrupt, recovery, ux]
doc_kind: spec
created: 2026-06-02
---

# F220: A2A 协作的可观测 · 可靠 · 可恢复

> **Status**: spec | **Owner**: Ragdoll (Opus-4.8，已接 own + 驱动) | **Priority**: P1 | **Source**: internal
>
> **Thread legend**：`[thread-id]` = 驱动/owner thread（Layer 1 现场调查 + 落地，Ragdoll Opus-4.8）｜`[thread-id]` = 立项 thread（平行 opus-48：立项 + 设计沉淀 + 交接，已收工）。

Architecture cell: `dispatch` + `bubble-pipeline` + `action-plane`
Map delta: none（复用现有 dispatch queue、frontend message/liveness chrome、force-reset action 边界，不改 ownership map）
Why（一句话）: A2A 触发与卡死恢复都落在既有 invocation/queue/tracker 生命周期里，本 feat 补它的"可见性+可恢复性"，不新造 store/queue。

## Why

operator要"**信得过的猫间协作**"。但今天 A2A（猫@猫）协作在三个维度同时漏，叠在一起让人**分不清猫到底在跑还是卡死**：

1. **看不见**：human→猫发消息，"启动中/排队中"占位**秒显示**；但猫→猫传球，前端**长时间一片空白**，没有任何"X 收到了/启动中/排队中"。用户传球出去后是一片静默。
2. **会真卡**：那条 invocation 可能真 hang（队列/session），补一刀还停"排队中"不进 running。
3. **卡了没法自救**：真卡死时正常的停止/中断点不动，用户没有逃生口。

**最要命的是 1+2 叠加**：因为缺可见性（1），前端把"猫在正常思考还没出字"和"猫卡死了"画成**同一个静默画面**——用户根本无法区分。这是operator 2026-06-02 在 `[thread-id]` 截图反映的体感来源。

> 价值锚：让用户**看得见**猫间协作在进行（不是黑盒静默）、**信得过**它不会无声卡死、**卡了能自救**。

## Current State / 现状基线（带证据，不美化）

组件层面**很多已经修好且在 main 上**——真问题更深，是"数据没产生"和"卡了没出口"：

- ✅ `ThinkingIndicator.tsx` 已 `useThreadLiveness` thread-scoped（main），有完整 `spawning → "{name} 启动中"` 渲染（~L84-120）。
- ✅ `#2050`（已 merge）：排队中显示等待原因（A2A queue-visibility）。
- ✅ `#2053`（已 merge 2026-06-02）：steer 立即中断 race-safe tombstone 修复（"卡住怎么点都中断不了"的 sound 部分）。
- ✅ `POST /api/threads/:id/force-reset` 端点**已存在**（2026-05-29 bug-report 加的）：cancelAll + 清 slot/record + 广播 done，user-scoped。
- 🔧 **Layer 1 缺口（Phase 1 implementation in `feat/f220-a2a-liveness-signal`）**：组件能渲染 spawning，但现代 InvocationQueue 路径缺少与 direct `/api/messages` 对等的 `spawn_started`。QueueProcessor 开始 processing 后只发 `queue_updated`，`intent_mode` 又按 #768 延迟到 CLI 第一条事件；CLI 冷启动/首事件延迟期间，主聊天 chrome 拿不到"目标猫正在启动"信号。修复：`QueueProcessor.executeEntry` 在 `startAll` + running record 后、`intent_mode` 前广播既有 `spawn_started`。
- ⚠️ **Layer 2**：has()=false 占用 slot 的真 hang（dead-Redis create 等病态）；#2053 已证 steer 无法 sound force-recover，只能靠 75min sweep / force-reset。
- ⚠️ **Layer 3**：force-reset 端点有，**前端无 UI 入口**——用户卡死时没有可点的逃生口。

## What

三个 Phase，对应三个维度：

### Phase 1 — 可观测：A2A 启动中/排队占位可见（Layer 1）
补上"A2A 触发后用户看得见猫在路上"。Phase 1 第一刀定位为 InvocationQueue 执行路径缺 `spawn_started`；复用 F118 D2 既有事件，不新造前端协议。
> 起点：驱动 thread `[thread-id]` 的 Layer 1 调查（已到根因层）。
> **现场校准（实测截图时间线）**：传球那刻Maine Coon大概率**空闲**（46/我 18:34 结束、Maine Coon 18:32 早结束），故候选 (a)"目标猫忙→排队不 spawn"**可能不成立**；live 取证**优先验 (b) `invocation_created` 事件丢/延迟、(c) `targetCats` 未更新成单目标 `[Maine Coon]`**。
> **实现校准（2026-06-02 Maine Coon review）**：runtime preflight 显示截图环境不在当前 main（runtime HEAD `65530c6a6`；target `2f433838b` 不在 history），截图不能单独证明 main 状态。main 代码对照显示 direct path 有 `spawn_started`，QueueProcessor path 没有；测试钉死后修 QueueProcessor。

### Phase 2 — 可靠：invocation 卡死根因（Layer 2）
定位"补一刀仍停排队不进 running"的真 hang（队列没消费 / session hang / 锁）。可能与 #2053 收敛的"slot/tracker/entry 生命周期解耦"相关。Maine Coon roadmap：是否统一 cancel/preempt 状态机、slot 升级带 invocation-identity ownership。
> **Scope 闸门（KD-3）🔴**：Phase 2 **先出根因报告（5 件套）+ 复现，不直接动手大改**。若根因需架构级重构（统一 cancel/preempt 状态机 + slot ownership 模型）→ 出报告 + Decision Packet 交 **operator 拍板是否拆独立 feat**，不在 F220 内硬扛。防 Phase 2 无底洞拖垮 Phase 1+3 的已交付价值。

### Phase 3 — 可恢复：force-reset 逃生口 UI（Layer 3）
把已有的 `force-reset` 端点接到一个**情境化、带确认弹窗**的 UI 入口。**设计稿见下方 §设计稿（operator 2026-06-02 已审过概念 + 确认要弹窗确认）**。

## Acceptance Criteria

> 每条 AC 指得回 Why；非作者可复核（命令/截图/复现）。

**Phase 1（可观测）✅ code done @ main #2064（54aabde54）；runtime 截图验收 → operator quickpath**
- [x] AC-1.1: A2A 传球后目标猫"启动中"占位及时出现。→ QueueProcessor mark running 后 broadcast `spawn_started`（与 direct path 对齐）。复核（录屏占位秒级出现）→ operator quickpath runtime 验。
- [x] AC-1.2: 根因有 live 证据。→ Maine Coon runtime preflight + main 代码对照定位 callback/queue 路径缺 `spawn_started`（截图环境不在当前 main、改用代码对照）。
- [x] AC-1.3: human 路径占位不回归。→ 只改 QueueProcessor 队列路径，未动 direct/route-serial；全 web 测试无回归。

**Phase 2（可靠）**
- [ ] AC-2.1: "补一刀仍停排队不进 running"的 hang 有根因报告（5 件套）+ 复现。
- [ ] AC-2.2: 修复 or（若属 #2053 同源的 unsound 边界）明确归类 + 兜底说明。

**Phase 3（可恢复）✅ code+test done @ main 4e80ec889（PR #2065 squash）；runtime 截图验收 → operator quickpath**
- [x] AC-3.1: 卡死/有活跃调用时 thread 出现情境化 force-reset 入口（非常驻）。→ `ThreadExecutionBar` 内 `ForceResetEntry`，有猫在跑才显示，`suspected_stall`/`alive_but_silent` 时上浮升级（`data-escalated`）。测试 4 绿。
- [x] AC-3.2: 点击弹**确认弹窗**（做什么/保留什么/何时用），确认才执行。→ `ForceResetDialog`（取消默认 focus / 强制重置危险红）。测试 4 绿。
- [x] AC-3.3: 确认 → force-reset → thread 解放；消息/历史**不丢**（LL-048 只清运行态）。→ `apiFetch POST force-reset` + toast「已重置」。复核（截图前后 + 消息条数不变）→ operator quickpath runtime 验。
- [~] AC-3.4: force-reset 对 **record-present hung 能清**（后端 `force-reset-thread.test` / `cancel-orphan-record.test` 已证）+ 前端调端点 done。**truly-orphaned slot（record 没了 + processingSlot 泄漏）清不掉 → 归 Phase 2**（Layer 2 根因）；orphaned 的 UI 诚实反馈随 Phase 2 攻坚处理（doc Phase 2 段已标 scope 闸门）。

## Dependencies
- force-reset 端点（`queue.ts`，已存在）。
- #2053 steer 修复（已 merge）——本 feat 是其完整产品故事的延续。
- Phase 间无硬依赖，可独立推进；建议序：可观测(1) → 可恢复(3) → 可靠(2)（1/3 直接缓解体感，2 是根因攻坚）。

## Risk
- Phase 1 改前端 liveness 写入时机，可能影响 human 路径占位——回归测守住。
- Phase 2 是 invocation lifecycle 雷区（F216 同域），改动需 race-safe + 跨族 review。
- Phase 3 force-reset 是强动作——确认弹窗 + user-scoped + **只清运行态（LL-048：绝不碰消息/历史/记忆等持久化数据）** 是安全前提。

## Key Decisions
- KD-1（2026-06-02 operator）：F220 reframe 成"A2A 协作可观测·可靠·可恢复"theme-feat，三层一起解决，不只 force-reset 逃生口。
- KD-2（2026-06-02 operator）：feat 由**干净 thread 的平行 opus-48 完整 own + 驱动**（带该 thread 的Maine Coon落地）；本 thread 负责立项 + 沉淀设计 + 跨线程交接。
- KD-3（2026-06-02 Ragdoll，接 own 时定）：**Phase 2 设 scope 闸门**——先出根因报告，需架构级重构则 operator 拍板拆独立 feat，不在 F220 内硬扛（见 Phase 2 段）。接手 5 点调整（Phase 2 闸门 / force-reset 守 LL-048 / force-reset vs orphaned slot 实测 / Phase 1 取证优先级校准 / thread legend）经立项方平行 opus-48 确认（thread `[thread-id]`）。
- KD-4（2026-06-02 Maine Coon）：Phase 1 不用新前端协议、不滥用 `a2a_handoff`。`a2a_handoff` 会迁移 active slot，适合 serial handoff；callback/queue path 应补 F118 D2 既有 `spawn_started`，表达"启动中"且保留 #768 的 `intent_mode` 延迟语义。

## 设计稿（Phase 3 — force-reset 逃生口 UI，operator 2026-06-02 已审概念）

**它 reset 什么**：reset 这个 thread 的**执行状态**——取消你在这个 thread 里所有在跑的猫调用 + 清掉卡住的"正在回复中"/"队列繁忙"状态 → thread 重新能用。**不删消息/历史/thread，不碰别人的调用，不碰记忆数据**。只擦"谁在跑"的临时态。

**触发 & 位置**：挂「当前调用/执行中」面板，只在有猫在跑时存在。
- 默认：面板里除正常「停止」外，一行**低调次级入口** `⚠ 卡住了？强制重置`（灰、不抢眼）。
- 升级（疑似卡死：调用异常久 / 点过停止没生效）→ 这行**变亮上浮**。

**确认弹窗（核心，operator点名要）** — 点击不立即执行，先弹窗：
- 标题：`强制重置这个对话？`
- 正文三段：🛑 会做什么（取消本对话所有在运行的猫 + 清"正在回复中"）/ ✅ 会保留什么（消息历史全保留，只清运行态）/ 💡 何时用（猫卡死、点停止也没反应时的最后手段）
- 按钮：`取消`（默认 focus）/ `强制重置`（危险色 red）

**弹窗 ASCII 草图**：
```
┌─────────────────────────────────────────┐
│  强制重置这个对话？                    ✕ │
├─────────────────────────────────────────┤
│  🛑 会取消这个对话里所有正在运行的猫，    │
│     清掉卡住的"正在回复中"状态。          │
│  ✅ 消息和历史全部保留——只清运行状态。    │
│  💡 仅在猫卡死、点「停止」也没反应时用。   │
├─────────────────────────────────────────┤
│              [ 取消 ]   [ 强制重置 ]🔴   │
└─────────────────────────────────────────┘
```

**流程**：有猫在跑 → 显示低调入口 →（卡死时升级显眼）→ 点击 → 确认弹窗 → 取消(什么都不动) / 确认(调 `POST /force-reset` → 清运行态 → toast「已重置，对话已解放」→ 面板恢复空闲)。

> 实现前走 Design Gate「在地设计检查」+「现场可感知性自检」（本 feat 属 observability/recovery 类，必填 in_context_observability 字段）。前端像素稿可用 Pencil 渲染再过operator。

### 高保真像素稿（2026-06-02 operator Design Gate 通过 → 实现真相源，勿走样）

- **渲染稿**：[`assets/F220/force-reset-mock.html`](assets/F220/force-reset-mock.html)（浏览器打开看三态实样）。
- **实现锚点**（Phase 3 实现对照这条，避免"写歪"）：
  - **tokens**：用真实 cat-cafe tokens——`--semantic-critical`（危险红）/ `--semantic-warning`（升级警告）/ `--cafe-surface` / `--border`，**不要 hardcode 颜色**。
  - **两态对比**：① 默认入口 = `dashed-top` 分隔线 + 灰 + 小字（藏面板底、不抢眼）；② 升级态（疑似卡死：异常久 / 停止失效）= `--semantic-critical-surface` 底 + 上浮居中 + 警告色填充。
  - **弹窗**：标题「强制重置这个对话？」+ 三行（ban / check / info 三个 lucide icon → 会做什么 / 会保留什么 / 何时用）+ 按钮 `取消`(默认 focus) / `强制重置`(危险红填充)。
  - **icon**：全 lucide 线性 SVG，**不用 emoji**（`🐾` paw 例外——品牌元素，同 `ThinkingIndicator`）。
