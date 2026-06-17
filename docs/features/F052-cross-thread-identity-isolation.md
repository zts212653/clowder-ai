---
feature_ids: [F052]
related_features: [F043, F193]
topics: [cross-thread, identity, a2a, context, ux]
doc_kind: feature-spec
created: 2026-03-02
---

# F052: 跨线程身份隔离与消息溯源

> **Status**: done | **Owner**: Ragdoll
> **Priority**: P1
> **依赖**: F043 Phase A（cross_post_message 已落地）
> **Evolved from**: F043（跨线程传输能力）
> **Completed**: 2026-03-04
> **PR**: #203（squash merged）

## 愿景

> **一句话**：跨线程消息应该像组间传话，不是身份混乱。

Cat Café 的每条 Thread 是一条独立工作流。多条 Thread 并行时，猫猫需要跨线程通知、传话、交接。F043 `cross_post_message` 解决了"传输"，但传过去的消息**没有来源标记**——收件方分不清是本线程的猫说的，还是别线程的猫传过来的。

### operator experience（2026-03-02 Thread `[thread-id]`）

> "我们没做跨线程的身份隔离！别线程的 codex 他顶着 codex 的名字"
> "我得知道是Maine Coon本地还是其他线程来的？"
> "我们自己的 context build 的时候...似乎没自动组装别的线程的 codex 的话？"
> "ux 安全 context 等等等，其实我们的机制都还没跟上这个 mcp"

### 期望体验

operator坐在 Thread B 的 UI 前：
1. 看到一条消息，**一眼能分辨**是 Thread B 本地的 codex 说的，还是 Thread A 的 codex 传话过来的
2. Thread B 的 codex 收到这条消息时，**知道它来自 Thread A**，不会误以为是自己之前说的
3. Thread A 的 codex 在消息里 `@codex`，**Thread B 的 codex 能被 A2A 触发**（当前被自引用过滤器误杀）
4. 不会自动拉 Thread A 的完整上下文——但跨线程消息**自带来源标记**，猫可以按需用 `get_thread_context(threadId=A)` 主动拉

## Why

### 根因：`catId` 是全局的，没有 Thread 作用域

| 维度 | 当前状态 | 缺口 | 风险 |
|------|---------|------|------|
| 消息来源标识 | `StoredMessage` 无 sourceThread | 无法区分本地/跨线程消息 | 🔴 高 |
| A2A 路由 | `parseA2AMentions` 全局 catId 自引用过滤 | 跨线程同名猫 @mention 被误杀 | 🔴 高 |
| Context 混淆 | 跨线程消息被当本地消息混入 | codex 分不清自己说的还是别线程传来的 | 🟡 中 |
| UX 展示 | 无视觉区分 | operator看不出消息来源 | 🟡 中 |
| 安全审计 | owner check 有 | 但无法追溯跨线程消息流向 | 🟡 中 |

### 复现证据（2026-03-02 实测）

1. Thread `mm806zbc51k8ma55` 的 codex 用 `cross_post_message` 向 Thread `mm8nkwlcwmwhmfgz` 发消息
2. 消息中写 `@codex` → 本线程 codex **未被触发**（被 `a2a-mentions.ts:52` 的 `if (id === currentCatId) continue` 杀掉）
3. 消息中写 `@sonnet` → sonnet **正常触发**并回复了 "收到-sonnet ✅"
4. 消息存储后，`StoredMessage` 里完全没有来源线程信息——跟本地消息一模一样

## What

### Phase A：消息溯源 + A2A 修复（最小闭环）

#### A1: StoredMessage 消息溯源

给 `StoredMessage.extra` 扩展 `crossPost` 字段：

```typescript
// 扩展现有 extra 类型
extra?: {
  rich?: RichMessageExtra;
  stream?: { invocationId: string };
  crossPost?: {                    // ← 新增
    sourceThreadId: string;        // 来源线程 ID
    sourceInvocationId?: string;   // 来源 invocation（可选，便于追溯）
  };
};
```

**实现点**：`callbacks.ts` 的 `post-message` handler，当 `effectiveThreadId !== record.threadId` 时，存消息附上 `crossPost` 元数据。

**设计决策**：用 `extra.crossPost` 而非新增顶层字段。理由：
- `extra` 本就是扩展槽（已有 `rich` 和 `stream`）
- 不改 `StoredMessage` 核心接口，向后兼容
- 没有 `crossPost` 的消息就是本地消息，不需要迁移

#### A2: A2A 路由跨线程豁免

修改 `parseA2AMentions` 签名，`currentCatId` 变为 optional：

```typescript
// 现在
export function parseA2AMentions(text: string, currentCatId: CatId): CatId[]

// 改后
export function parseA2AMentions(text: string, currentCatId?: CatId): CatId[]
```

在 `callbacks.ts` 的 `post-message` handler 中：
- 同线程：`parseA2AMentions(content, senderCatId)` — 保持自引用过滤
- 跨线程（`effectiveThreadId !== record.threadId`）：`parseA2AMentions(content)` — 不传 senderCatId，不过滤同名猫

**安全兜底**：无限循环已有 `a2aCount < maxDepth` 限制（`route-serial.ts` 和 `WorklistRegistry`），不需要自引用过滤来防跨线程回弹。

#### A3: UserAgent 去重标记

`cross_post_message` 的 A2A 触发可能导致目标线程收到重复通知（push notification + A2A invocation）。在 A2A enqueue 时标记 `sourceType: 'crossPost'`，让 push dedup 识别。

### Phase B：Context 标注 + UX 展示

#### B1: Context 标注

`assembleIncrementalContext` 格式化消息时，检查 `msg.extra?.crossPost`：

```
// 本地消息（不变）
[msgId] [14:30 Maine Coon] 内容...

// 跨线程消息（新增来源标注）
[msgId] [14:30 Maine Coon ← from thread:mm806zbc] 内容...
```

猫猫看到 `← from thread:xxx` 就知道这条不是本线程产生的。不自动注入来源线程的上下文——猫可以按需调用 `get_thread_context(threadId=xxx)` 主动拉。

#### B2: UX 展示

前端 `MessageBubble` 组件检查 `message.extra?.crossPost`：
- 有 → 显示"转发自 Thread X"标签（轻量视觉提示，不是弹窗）
- 无 → 不变

### 不做的事（明确排除）

| 提议 | 决定 | 理由 |
|------|------|------|
| Thread-scoped catId（如 `codex@threadA`） | ❌ 不做 | 侵入面太大，触及 routing/registry/store 全链路 |
| 自动注入跨线程上下文 | ❌ 不做 | 噪音太大，破坏线程隔离边界 |
| 跨线程消息自动 translate/摘要 | ❌ 不做 | 过度设计，当前文本直传即可 |
| 跨线程消息加密/签名 | ❌ 不做 | 同一 userId 下的线程互信，owner check 足够 |

## Acceptance Criteria

### Phase A
- [x] AC-A1: `cross_post_message` 存储的消息包含 `extra.crossPost.sourceThreadId`
- [x] AC-A2: 跨线程 codex → `@codex` 能触发目标线程的 codex A2A
- [x] AC-A3: 同线程 codex → `@codex` 仍然不触发（自引用过滤保持）
- [x] AC-A4: A2A 深度限制 (`maxDepth`) 仍然有效，防止跨线程无限回弹
- [x] AC-A5: 跨线程 push 通知不重复（covered by architecture: WebSocket broadcast 只执行一次，worklist 按 catId 去重，无独立 push 服务）

### Phase B
- [x] AC-B1: `assembleIncrementalContext` 对跨线程消息加来源标注
- [x] AC-B2: 前端消息气泡对跨线程消息显示来源 thread 标签

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "我得知道是Maine Coon本地还是其他线程来的" | AC-A1, AC-B1, AC-B2 | test + UI badge | [x] |
| R2 | "别线程 codex at 我们的 codex 他无法 a2a" | AC-A2, AC-A3 | test（跨线程 @codex 触发 + 同线程不触发） | [x] |
| R3 | "但是调用 sonnet 是可以的"（不能回归） | AC-A2 | test（跨线程 @sonnet 仍正常） | [x] |
| R4 | "ux 安全 context 等等等机制都还没跟上" | AC-A1, AC-B1 | test（context 标注 + 溯源字段） | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（AC-B2 需截图）

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 用 `extra.crossPost` 而非新增顶层字段 | 向后兼容，不改核心接口，不需要数据迁移 | 2026-03-02 |
| KD-2 | 跨线程豁免自引用过滤，而非改 catId 模型 | 最小改动（2-3 行核心），不侵入 routing/registry | 2026-03-02 |
| KD-3 | 不自动注入跨线程上下文 | 保持线程隔离边界，猫按需主动拉 | 2026-03-02 |
| KD-4 | `parseA2AMentions` 的 `currentCatId` 变 optional | 跨线程不传 = 不过滤；同线程照传 = 保持自引用防护 | 2026-03-02 |

## Dependencies

- **Evolved from**: F043（`cross_post_message` 传输能力，PR #174 已合入）
- **Related**: F046 Phase D（@ routing 卫生，但 F052 不依赖它）
- **Related**: F050（A2A 外部 Agent 接入，F052 的身份模型影响 F050 的跨 agent 消息）
- **Evolves into**: F056（设计语言猫猫化 — 跨线程气泡作为打样）、F057（Thread 可发现性 — badge 增强）

## Risk

| 风险 | 缓解 |
|------|------|
| `extra.crossPost` 导致 StoredMessage 体积增长 | 只加两个字符串字段，忽略不计 |
| 跨线程 A2A 无限回弹 | `a2aCount < maxDepth` 已有兜底 + 可加跨线程专用 depth 限制 |
| Phase B context 标注改变猫的行为 | 只加前缀标注，不改消息内容本身 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon codex 或 gpt52）
- Phase B: 前端部分额外需要Siamese视觉 review

## Cross-Cat Audit

| 猫猫 | 读了哪些文档 | 三问结论 | 签收 |
|------|-------------|---------|------|
| Ragdoll (Opus) | F052 spec, F043 spec, operator experience thread | ① 核心问题=跨线程消息无来源标记+A2A误杀 ② 交付物解决了 ③ operator在UI看到蓝色badge+codex被正确A2A触发 | [x] 签收 |
| Maine Coon (Codex) | F052 spec, 代码diff(16 files), 测试覆盖 | R1: 2P1(WS路径遗漏) → R2: 1P1(后台线程遗漏) → R3: 0P1/P2 放行 | [x] 放行 |

## Known Bugs

### Bug: 同猫跨线程消息被"自己消息"过滤吞掉 (2026-03-06)

**发现场景**: F063 冷启动守护线程的 Opus 用 `cross_post_message` 向 F063 主线程发送愿景守护综合结论。目标线程的 Opus 在"对话历史增量"里看不到这条消息。

**根因**: `route-helpers.ts:257-261` 的 `assembleIncrementalContext()` 在构建历史增量时，使用 `m.catId === catId` 过滤"自己发的消息"。跨线程消息虽然正确存入目标线程（带 `extra.crossPost` 元数据），但因为发送方和接收方 catId 相同（都是 `opus`），被当成"自己刚说过的话"过滤掉。

**影响范围**:
- 同猫跨线程消息：**看不到**（catId 相同 → 被过滤）
- 异猫跨线程消息：**正常**（catId 不同 → 不被过滤）
- 这解释了为什么跨线程通讯"有时正常、有时失灵"

**独立验证**: Ragdoll(Opus 4.6) 定位 + Maine Coon(GPT-5.4) 独立复核确认

**修复方向**: 对 `extra.crossPost` 消息豁免 self-filter：
```typescript
if (!m.extra?.crossPost && m.catId !== null && m.catId === catId) return false;
```

**回归测试**: `same cat + crossPost => should appear in 对话历史增量`

**状态**: 待修复
