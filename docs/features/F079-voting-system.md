---
feature_ids: [F079]
related_features: [F061]
topics: [collaboration, play-mode, rich-block, at-cat, connector]
doc_kind: spec
created: 2026-03-07
status: done
---

# F079 Voting System (v2 — UX 重写)

> **Status**: done | **Owner**: Ragdoll

## Why

多猫协作时经常需要投票决策（如"谁最绿茶"、狼人杀投票等），目前只能人工统计。需要系统化的投票机制 + 自动汇总 + rich block 展示。

## What

### Phase 1 回顾 (PR #287, 已合入)

后端基础设施已就绪：
- `VotingStateV1` 类型 + ThreadStore/RedisThreadStore 持久化
- 4 个 API 端点：`POST /vote/start`, `POST /vote`, `GET /vote`, `DELETE /vote`
- 匿名模式: cast/get/close 都正确 strip voter identity
- Deadline enforcement: 超时后 410 拒绝投票
- WebSocket 广播: `vote_started`, `vote_cast`, `vote_closed`
- Rich block tally 生成

**Phase 1 问题**：前端 UX 极差（CLI 单行解析、没有通知猫猫、手动 cast/end）。

### Phase 2 Spec (本次重写)

### 核心交互流程

```
用户输入 /vote
    ↓
VoteConfigModal 弹窗打开
  ├── 投票问题（textarea，必填）
  ├── 选项列表（动态增删，≥2 个，可拖拽排序）
  ├── CatSelector（复用现有组件，选哪些猫参与投票）
  │   └── 含 AT 猫（antigravity, antig-opus）
  ├── 匿名/实名 toggle（默认实名）
  └── 超时时间 select（30s / 1min / 2min / 5min，默认 2min）
    ↓
用户点「发起投票」
    ↓
POST /api/threads/:threadId/vote/start
  body: { question, options, anonymous, timeoutSec, voters: CatId[] }
    ↓
系统自动 @ 每只被选中的猫，发投票通知消息：
  "🗳️ 投票请求：{question}\n选项：{options.join(' | ')}\n请回复 [VOTE:你的选项]"
    ↓
猫猫回复消息中包含 [VOTE:选项]
    ↓
路由层 regex 拦截：/\[VOTE:(.+?)\]/
  → 调用 POST /vote 记录投票
  → 广播 vote_cast（匿名时只广播 voteCount）
    ↓
全员投完 OR 超时
    ↓
系统自动 close：
  → DELETE /vote（内部调用，非用户触发）
  → 生成 rich block card 插入 thread
  → 广播 vote_closed + richBlock
```

### 前端组件

#### VoteConfigModal（新建）

复用 `DirectoryPickerModal` + `SteerQueuedEntryModal` 的 modal 模式：
- `fixed inset-0, bg-black/30, z-50`
- Esc / backdrop click 关闭
- 键盘友好

```
┌────────────────────────────────┐
│  🗳️ 发起投票                  │
│                                │
│  问题                          │
│  ┌──────────────────────────┐  │
│  │ 谁是最会撒娇的猫猫？      │  │
│  └──────────────────────────┘  │
│                                │
│  选项                          │
│  ┌──────────────────────────┐  │
│  │ opus-4.6          [×]    │  │
│  │ sonnet            [×]    │  │
│  │ codex             [×]    │  │
│  │ + 添加选项               │  │
│  └──────────────────────────┘  │
│                                │
│  参与投票的猫猫                 │
│  [CatSelector 复用]            │
│  ● opus  ● sonnet  ● codex    │
│  ● gemini  ● antigravity      │
│  ● antig-opus                  │
│                                │
│  ○ 实名  ○ 匿名    超时: 2min │
│                                │
│  [取消]          [发起投票 🗳️] │
└────────────────────────────────┘
```

#### VoteResultCard（rich block 渲染）

复用现有 `RichCardBlock` 组件，`kind: 'card'`：
- 标题：📊 投票结果: {question}
- Fields：每个选项一行，含票数 + 百分比 + 进度条
- bodyMarkdown：实名模式列投票人，匿名模式只显示总票数
- tone: `info`

#### 投票进行中指示器

Thread 有活跃投票时，在 ChatInput 区域上方显示：
- 紧凑条: "🗳️ 投票进行中: {question} · 已投 3/5 · 剩余 1:23"
- 点击展开查看当前状态
- operator可点「结束投票」手动关闭

### 后端改动

#### 1. start 接口增加 voters 字段

```typescript
// POST /vote/start body 新增
voters?: CatId[];  // 参与投票的猫猫列表
```

发起后系统自动给每只 voter 发一条投票请求消息（走现有 message append + agent routing）。

#### 2. 路由层 [VOTE:xxx] 拦截

在 `AgentRouter` 或 message processing pipeline 中，对猫猫回复做 regex 匹配：

```typescript
const VOTE_PATTERN = /\[VOTE:(.+?)\]/;
const match = content.match(VOTE_PATTERN);
if (match && threadHasActiveVote(threadId)) {
  await castVote(threadId, catId, match[1].trim());
}
```

拦截后：
- 原消息正常显示（猫猫可能还说了别的话）
- 投票计入 votingState
- 检查是否全员投完 → 自动 close

#### 3. 超时自动关闭

`vote/start` 时注册一个 `setTimeout`：

```typescript
const timer = setTimeout(async () => {
  const state = await threadStore.getVotingState(threadId);
  if (state?.status === 'active') {
    await closeVote(threadId);
  }
}, timeoutSec * 1000);
```

存储 timer ref 在内存 Map 中（`voteTimers: Map<string, NodeJS.Timeout>`），close 时 clearTimeout。

#### 4. AT 猫支持

AT 猫（antigravity, antig-opus）通过 CDP bridge 通信，回复文本一样经过 message pipeline → `[VOTE:xxx]` regex 同样生效。无需特殊处理，但需要：
- CatSelector 中正确显示 AT 猫（已有）
- 投票通知消息能路由到 AT 猫（复用现有 @ mention routing）

## Acceptance Criteria

- [x] AC-A1: 后端 API 4 端点 + ThreadStore 持久化（Phase 1 已完成）
- [x] AC-A2: 匿名模式 strip identity（Phase 1 已完成）
- [x] AC-A3: Deadline enforcement（Phase 1 已完成）
- [x] AC-A4: `/vote` 命令打开 VoteConfigModal 弹窗
- [x] AC-A5: 弹窗含：问题、选项增删、CatSelector、匿名 toggle、超时 select
- [x] AC-A6: 发起后系统自动 @ 每只被选中的猫发投票通知
- [x] AC-A7: 路由层 regex 拦截 `[VOTE:xxx]` 自动计票
- [x] AC-A8: 全员投完自动 close + 生成 rich block card
- [x] AC-A9: 超时自动 close + 生成 rich block card
- [x] AC-A10: 投票进行中指示器（ChatInput 上方）
- [x] AC-A11: AT 猫（antigravity, antig-opus）能参与投票
- [x] AC-A12: VoteResultCard 正确渲染投票结果（含进度条）

## Gap 3: 投票结果 Connector 气泡（独立系统通知样式）

### Why

当前投票结果是 rich block card 嵌在 `userId: 'system'` 的消息里，渲染为普通 system message。
operator要求投票结果像 **GitHub Review 通知**那样，有独立的 connector 气泡：
- 左对齐、独立配色主题（区别于猫猫消息和系统消息）
- 自带图标 + 标签头（如 🗳️ + "投票结果"）
- 结构化字段展示

参考：GitHub Review 通知走 `source: { connector: 'github-review', label: 'GitHub Review', icon: '🔔' }` 路径，
前端 `ConnectorBubble.tsx` 根据 connector 类型匹配主题。

### Scope

**后端**：
- vote close 时，message 从 `{ userId: 'system', extra: { rich } }` 改为 `{ userId: 'system', catId: null, source: { connector: 'vote-result', label: '投票结果', icon: '🗳️' } }`
- 结果数据放 `contentBlocks` 或保留 `extra.rich`（取决于 ConnectorBubble 渲染路径）

**前端**：
- `ConnectorBubble.tsx` 增加 `vote-result` connector 主题（配色待定，建议紫金色系区分 github-review 的蓝灰）
- `ChatMessage.tsx` 的 connector 分支已自动覆盖（只要 `source` 存在就走 ConnectorBubble）

### Acceptance Criteria

- [x] 投票结果消息携带 `source: { connector: 'vote-result', label: '投票结果', icon: '🗳️' }`
- [x] 前端渲染为 ConnectorBubble 样式（左对齐、独立图标 + 标签、主题配色）
- [x] 结果内容（选项、票数、百分比、进度条）在 connector 气泡内正确展示
- [x] 匿名模式下不泄露投票人身份
- [x] 实名模式下正确列出每个选项的投票人

### 讨论来源

Thread `[thread-id]` (2026-03-08 07:25) — operator看到手动发的投票汇总消息后提出

## Gap 4: 猫猫发起投票（MCP 工具）

### Why

当前只有operator通过 UI `/vote` 命令发起投票。猫猫在协作讨论中需要集体决策时（如"这个 API 用 REST 还是 GraphQL？"），无法自主发起投票，必须请operator操作。

### Scope

新增 MCP 工具 `cat_cafe_start_vote`，让猫猫通过 MCP 调用发起投票，复用现有 vote API：

```typescript
// MCP tool: cat_cafe_start_vote
{
  question: string;       // 投票问题
  options: string[];      // ≥2 个选项
  voters: CatId[];        // 参与投票的猫猫
  anonymous?: boolean;    // 默认 false
  timeoutSec?: number;    // 默认 120
}
```

**后端**：
- 新增 MCP tool handler，调用现有 `POST /vote/start` 逻辑
- `createdBy` 设为发起的 catId（不是 'system'）
- 投票通知消息复用现有 `buildVoteNotification` + routing

**提示词**：
- Skills 中告知猫猫有 `cat_cafe_start_vote` 工具
- 使用场景：多猫讨论需要投票决策时

### Acceptance Criteria

- [ ] MCP 工具 `cat_cafe_start_vote` 可被猫猫调用
- [ ] 复用现有 vote API（不重复实现）
- [ ] 发起者为 catId，不是 'system'
- [ ] 投票通知正确路由到 voters
- [ ] Skills/提示词更新，猫猫知道有这个工具

### 讨论来源

Thread `[thread-id]` (2026-03-08 18:13) — operator提出猫猫也该能发起投票

## Key Decisions

1. 用 `/vote` 命令触发（不用自然语言，避免误触发）
2. 汇总由系统完成（不是某只猫负责）
3. 默认实名，匿名是可选项
4. 复用 CatSelector 组件选择投票参与者
5. `[VOTE:xxx]` regex 拦截（不需要猫猫学新命令，自然嵌入回复）
6. 超时用 setTimeout（内存 Map 存 timer ref，足够可靠）

## Dependencies

- **Related**: rich block 系统（已有）
- **Related**: 路由层消息处理 pipeline（已有）
- **Related**: CatSelector 组件（已有）
- **Evolved from**: AT 猫 routing（F061 已完成 Phase 1）

## Risk

- 低风险：功能独立，不影响核心流程
- AT 猫 CDP bridge 延迟 ~3s，投票通知和响应都经过 pipeline，无特殊风险

## Known Bugs (2026-03-08)

### Bug 1: 投票结果卡片重复显示

**现象**：投票结束后，结果卡片出现了两次——一次是系统发的"投票结果" connector 气泡，一次是最后投票的猫（Siamese）的回复里又嵌了一份相同的结果卡片。

**预期**：结果卡片只应由系统发一次。最后一只猫的回复应该只包含 `[VOTE:xxx]` 和猫自己说的话，不应重复嵌入结果。

**可能根因**：最后一票触发 auto-close 时，close 逻辑生成了 rich block 并广播，但同时最后投票的猫的回复也被注入了结果卡片（可能是 vote close 回调 + 猫回复 pipeline 各生成了一份）。

### Bug 2: 投票结果需要 F5 刷新才显示

**现象**：投票结束后，结果卡片不是实时出现的，需要刷新页面才能看到。

**预期**：投票结束后结果应通过 WebSocket 实时推送到前端并立即渲染。

**可能根因**：
- `vote_closed` WS 事件已广播，但前端没有监听该事件来插入结果消息
- 或者结果消息走了 `message_append` 事件但前端没正确处理 connector 类型的消息实时插入
- 需要检查 `vote_closed` → 前端 WS listener → message list 更新的完整链路

**复现**：2026-03-08 21:05 投票"我们开源仓叫什么好呢？"，Siamese最后投票后触发。

## Review Gate

- 跨猫 review：@codex
