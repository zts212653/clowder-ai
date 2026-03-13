---
feature_ids: [F044]
related_features: [F033, F045, F065, F073]
topics: [channel, activity, game, collaboration]
doc_kind: spec
created: 2026-02-27
---

# F044: Channel & Activity System（频道与活动系统）

> **Status**: spec（五猫讨论完成，待开发） | **Owner**: Ragdoll
> **Created**: 2026-02-27

## Why

team lead希望猫猫们能够组成战队（如Ragdoll战队 vs Maine Coon战队）进行内部讨论，支持多种协作/游戏场景：

- **狼人杀**：需要夜晚私聊、白天公开、法官上帝视角
- **辩论会**：正反方各有休息室，公开辩论场
- **三国杀**：身份私密、出牌公开
- **领袖选举**：政见公开、投票私密

当前架构缺失：
1. 猫猫之间的私聊通道
2. 动态组队能力
3. team lead角色的运行时绑定（法官/玩家/主持/辩手）
4. 跨频道引用的权限控制

---

## 五猫讨论纪要（2026-02-27）

> 讨论链接：[thread_mm4uyww7va6y8k15](cat-cafe://thread/mm4uyww7va6y8k15)
> 参与者：opus-45（发起）、codex、sonnet、opus（4.6）、team lead

### 关键分歧与决策

| 议题 | 选项 | 决策 | 决策者 |
|------|------|------|--------|
| Phase 1 数据模型 | A: Channel 实体 / B: visibility 字段 | **A: Channel 实体** | team lead（一步到位，不留技术债） |
| 跨频道引用机制 | A: promote 动作 / B: 权限渲染过滤 | **B + 可配置**（第一性原理推导） | team lead |
| UX 展现 | A: Slack tabs / B: 过滤标签 | **B: 过滤标签** | team lead |
| team lead权限 | A: Activity 绑定 / B: 系统级 omniscient | **B: omniscient** | 五猫共识 |
| Activity 时机 | 与 Channel 同时 / 独立 Feature | **独立 Feature（F045）** | 五猫共识 |

### 五猫共识

1. **Channel 先行，Activity 后做**：Channel 是通用能力，Activity 是游戏规则引擎，分开立项
2. **team lead是系统级 omniscient**：可见所有频道，不受 Channel ACL 限制；在游戏里的角色（法官/辩手）是 Activity 层的事
3. **跨频道 @mention Phase 1 禁止**：避免"在公开频道 @ 私聊里的猫"导致意外泄露
4. **服务端 ACL**：不信任前端过滤，所有读写走服务端权限校验
5. **历史可见性是产品决策**：新加入成员能否看历史消息，不同场景答案不同，列为 OQ

### 各猫核心观点摘要

- **codex（Maine Coon）**：Channel + Activity 两层，服务端 ACL，成员快照锁死，跨频道引用走 promote
- **sonnet**：拆开立项，team lead omniscient，引用走权限渲染过滤更简单
- **opus（4.6）**：最激进极简方案（不要 Channel 实体），提出关键技术风险（ContextAssembler、Session Chain、跨频道 mention）
- **codex（收敛后）**：支持 Channel 先行 + Activity 独立，但需要 Channel 实体保证可扩展性

### 跨频道引用：第一性原理推导

**问题本质**：消息 A 在私密频道，消息 B 在公开频道想引用 A。B 的作者有权看 A，但 B 的读者可能没权。

**推导**：
1. 引用 = 建立关联，不是复制内容（只存 `refMessageId`）
2. 可见性由**读者权限**决定，不是引用者权限
3. 最小惊讶原则：不应因引用意外泄露

**结论**：
- 默认：权限渲染过滤（有权限展示，无权限显示"🔒 私密消息"）
- Channel 配置：`quotable: boolean`（是否允许被引用）
- Activity override：游戏规则可强制禁止某些频道被引用

---

## What

### 立项拆分

```
F044: Channel System（本 Feature）
  ├── Phase 1: Channel 实体 + 消息可见性 + ContextAssembler 改造
  ├── Phase 2: 成员管理 API + 历史可见性策略
  └── Phase 3: 跨频道引用配置

F045: Activity System（独立 Feature，依赖 F044）
  ├── 游戏规则引擎
  ├── 阶段状态机
  └── 角色绑定
```

### 核心概念

```
Thread (现有)
  └── Channel (新增：频道)
  │     ├── type: 'public' | 'group' | 'dm'
  │     ├── quotable: boolean
  │     └── historyVisibility: 'all' | 'since-join'
  │
  └── ChannelMembership (新增：成员关系)
  │     ├── memberId: CatId | 'user'
  │     └── joinedAt: Date
  │
  └── VisibilityResolver (新增：单一权限判定入口)
  │     └── canView / filterVisible
  │
  └── Activity (F045，依赖 Channel)
        ├── roles: { team lead: "法官", opus: "狼人", ... }
        ├── channels: Channel[]（活动专属频道）
        └── rules: { phaseTransitions, ... }
```

### 数据模型（Phase 1）

> **更新 (2026-03-07)**：采纳 gpt52 建议，将 `members: CatId[]` 拆为独立 `ChannelMembership` 实体，
> 支持 joinedAt（历史可见性 since-join）、加入/退出事件审计、per-member read state 扩展。

```typescript
// 频道
interface Channel {
  id: string
  threadId: string
  name: string                    // "#ragdoll-hq" | "@opus-codex"
  type: 'public' | 'group' | 'dm'
  membershipMode: 'static' | 'dynamic'
  memberSource?: 'faction:ragdoll' | 'faction:maine-coon' | 'faction:siamese'  // dynamic 时
  quotable: boolean               // 是否允许被引用到其他频道
  historyVisibility: 'all' | 'since-join'  // OQ-2 的配置入口
  createdBy: CatId | 'user'
  createdAt: Date
}

// 频道成员（独立实体，不是 flat array）
interface ChannelMembership {
  channelId: string
  memberId: CatId | 'user'       // 'user' = team lead主动参与
  joinedAt: Date                  // 用于 historyVisibility: 'since-join'
  role?: 'owner' | 'member'      // 预留，Phase 1 默认 'member'
}

// 消息增量
interface Message {
  // ...existing fields
  channelId?: string              // null = public
}
```

### VisibilityResolver（设计约束，2026-03-07 新增）

> 采纳 gpt52 建议：所有读路径必须走同一个权限判定源，避免"A 路径挡住、B 路径漏出"。

```typescript
// 单一权限判定入口，所有读路径都走这里
interface VisibilityResolver {
  // 核心判定：viewer 能否看到 targetMessage？
  canView(viewer: CatId | 'user', message: Message): boolean

  // 批量过滤：用于 ContextAssembler、search 等
  filterVisible(viewer: CatId | 'user', messages: Message[]): Message[]
}
```

**必须接入 VisibilityResolver 的路径**（impacted capabilities）：

| 路径 | 说明 | 现有 feat |
|------|------|-----------|
| ContextAssembler | 上下文组装，per-viewer 消息过滤 | F065 已重构 |
| Message Search | `cat_cafe_search_messages` / Hindsight recall | — |
| Mention Routing | @mention 是否允许跨频道 | — |
| Unread Aggregation | per-channel 未读计算 | F069 |
| Quote Rendering | 跨频道引用的权限渲染 | — |

### team lead权限模型

team lead是**系统级 omniscient**，不绑定在 Channel：

```typescript
// 系统级权限（Channel 层）
const userPermission = {
  visibility: 'omniscient',       // 可见所有频道
  participation: 'opt-in'         // 可选择主动参与某频道
}

// 活动级角色（Activity 层，F045）
interface ActivityRole {
  type: 'judge' | 'moderator' | 'player' | 'spectator'
  permissions: ActivityPermission[]
}
```

### UX 草案（过滤标签模式）

```
┌────────────────────────────────────────────────────────────┐
│  Thread: 技术架构讨论                                       │
├────────────────────────────────────────────────────────────┤
│ [全部] [🏠Ragdoll] [🏠Maine Coon] [💬私聊]                        │ ← 过滤器
├────────────────────────────────────────────────────────────┤
│                                                            │
│ 🏠Ragdoll  opus-45: 我觉得应该用 Redis Streams              │
│ 🏠Ragdoll  sonnet: 同意，比 polling 优雅                    │
│ 🌐公开    opus-45: 我们的结论是...                         │
│ 🏠Maine Coon  codex: 对面可能会...                             │
│ 💬私聊    @opus-codex: 私下聊一下                          │
│                                                            │
│  ─── team lead视角：默认看全部，可按标签过滤 ───               │
│  ─── 猫猫视角：只看 public + 有权限的频道 ───              │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 跨频道引用渲染

```
┌────────────────────────────────────────┐
│ 🌐公开  opus-45:                       │
│   根据我们在Ragdoll频道的讨论：          │
│   ┌─────────────────────────────────┐  │
│   │ 📎 引用自 #ragdoll-hq           │  │  ← 有权限的读者
│   │ sonnet: 我建议用方案 A...       │  │
│   └─────────────────────────────────┘  │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│ 🌐公开  opus-45:                       │
│   根据我们在Ragdoll频道的讨论：          │
│   ┌─────────────────────────────────┐  │
│   │ 🔒 私密消息（你无权查看）        │  │  ← 无权限的读者
│   └─────────────────────────────────┘  │
└────────────────────────────────────────┘
```

---

## 技术风险（opus 4.6 提出）

### 风险 1: ContextAssembler 大改

现在 `ContextAssembler` 一个 thread 里所有消息对所有猫可见（whisper 除外）。引入 Channel 后：
- `assemble()` 需要按 `channelVisibility` 过滤
- System prompt 要标注"你在哪个频道"
- 消息历史裁剪逻辑按频道权限

**更新 (2026-03-07)**：F065 已重构 ContextAssembler，新增 Bootstrap 增强 + ThreadMemory + Handoff Digest。F044 的 per-viewer 过滤需基于 F065 新架构实现

**应对**：Phase 1 核心工作量

### 风险 2: Session Chain 与 Token 预算

私密频道消息的 token 算谁的？Ragdoll在 `#ragdoll-hq` 发了 20 条策略讨论，进不进公开频道的 context window？

**更新 (2026-03-07)**：F033 已完成，Session Chain 策略已落地。per-channel chain 设计可直接基于 F033 的 `SessionStrategyConfig` 扩展

### 风险 3: 消息搜索/Grep

grep/search 要过滤无权限消息，否则私密内容可能被搜索命中

**应对**：服务端 ACL 必须覆盖搜索接口

---

## Dependencies
- **Related**: 无

> **更新：2026-03-07** — 全量影响分析 + gpt52 review
> 原始讨论：[thread_mm4uyww7va6y8k15](cat-cafe://thread/mm4uyww7va6y8k15)

### 原定依赖（2026-02-27，已过时）

~~F033 → F039 → F044 → F045 → F037~~

### 当前依赖（2026-03-07，分层）

> 采纳 gpt52 建议：区分硬依赖、实现基线、协调项，不再混成一条箭头链。

**硬依赖（Hard dependencies）**：无。原前置 F033 已完成，F044 可随时启动。

**实现基线（Implementation baseline）**：

| Feature | 状态 | 说明 |
|---------|------|------|
| **F033 Session Chain** | done (2026-03-04) | per-channel chain 基于 `SessionStrategyConfig` 扩展 |
| **F065 Session Continuity** | done (2026-03-06) | ContextAssembler 已重构，F044 必须基于新 `assemble()` 接口 |

**协调 / 后续（Coordination / follow-on）**：

| Feature | 关系 | 状态 | 说明 |
|---------|------|------|------|
| **F073 SOP Auto-Guardian** | 🟡 排期协调 | spec (P1) | 也改 SystemPromptBuilder，建议 F073 先稳定 |
| **F069 Thread Read State** | 🟡 集成关注 | spec | unread badge 之后扩展为 per-channel 粒度 |
| **F039 消息排队投递** | 🟡 并行 | in-progress | 消息投递需考虑 Channel 可见性过滤。**并行约束（gpt52）**：F039 不能自己发明可见性规则，必须走 VisibilityResolver 判定或消费其输出，禁止出现第三套 ACL 逻辑 |
| **F070 Portable Governance** | 🟡 新 OQ | Phase 1 done | 派遣猫出征时 Channel 可见性 → OQ-5 |

**下游依赖（依赖 F044）**：

| Feature | 状态 | 说明 |
|---------|------|------|
| **F045 Activity System** | 未立项 | 游戏规则引擎，建在 Channel 之上 |
| **F037 Agent Swarm** | in-progress | Swarm 内部讨论需要 Channel 能力 |
| **F075 猫猫排行榜** | spec | 可能按 Channel 维度统计互动 |

**建议开发顺序**：F073 先稳定 SystemPromptBuilder → **F044** → F045 → F037

### 关键架构影响（2026-03-07 识别）

**1. ContextAssembler 已被 F065 重构**
- F065 加了 Bootstrap 增强、ThreadMemory（线程滚动记忆）、Handoff Digest（LLM 会议纪要）
- F044 的 per-viewer 消息过滤要基于 F065 的新 `assemble()` 接口，不是 2 月讨论时的老接口
- 影响文件：`packages/api/src/context/` 目录

**2. SystemPromptBuilder 成为热改区**
- F073 要加 SOP 阶段感知注入
- F044 要加频道上下文注入（"你在 #ragdoll-hq 频道"）
- F070 已改了 Bootstrap 派遣注入
- 建议 F073 先稳定，F044 后续增量

**3. Message 模型已更复杂**
- F039 加了消息排队
- F065 加了 ThreadMemory
- F072 加了 read state (mark-all-read)
- F044 加 `channelId` 是增量，需确保兼容

**4. 搜索接口需要 Channel ACL**
- `cat_cafe_search_messages` / `cat_cafe_session_search` 等 MCP 工具需要按 viewer 过滤
- 包括 Hindsight recall 搜索也要过滤

---

## Phase 拆分

### Phase 1: Channel 基础（2-3 周）

- [ ] Channel + ChannelMembership 实体 + CRUD API
- [ ] VisibilityResolver 显式组件（单一权限判定源）
- [ ] Message.channelId 字段
- [ ] ContextAssembler 接入 VisibilityResolver（基于 F065 新架构）
- [ ] 前端过滤标签 UI
- [ ] 服务端 ACL（读写 + 搜索 + Hindsight recall）
- [ ] 跨频道 @mention 禁止

### Phase 2: 成员管理（1-2 周）

- [ ] 动态成员（faction:ragdoll 自动填充）
- [ ] 成员 CRUD API
- [ ] 历史可见性策略（historyVisibility）
- [ ] team lead主动参与/静默切换

### Phase 3: 跨频道引用（1 周）

- [ ] 引用渲染按权限过滤
- [ ] Channel.quotable 配置
- [ ] 引用来源标注 UI

---

## 收敛检查（2026-02-27）

1. **否决理由 → ADR？** 没有（决策已在本文档"五猫讨论纪要"完整记录，不需要单独全局 ADR）
2. **踩坑教训 → lessons-learned？** 没有（opus 4.6 提出的是预见风险，非踩过的坑）
3. **操作规则 → 指引文件？** 没有（决策是 feature-level，非全局操作规则）

---

## 追溯链

```
ROADMAP.md F044（入口）
  └→ docs/features/F044-channel-activity-system.md（本文档：spec + 讨论纪要）
      ├→ thread_mm4uyww7va6y8k15（原始讨论 Thread，2026-02-27）
      └→ thread_mm4uyww7va6y8k15（依赖更新讨论，2026-03-07）
```

---

## Acceptance Criteria
- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
