---
name: cross-thread-sync
description: >
  跨 thread 协同：发现平行 session → 通知（3+2 件套）→ 争用协调 → 确认。
  Use when: 平行 session 之间需要协同、通知改动影响、共享文件争用。
  Not for: 跨猫工作交接（用 cross-cat-handoff）。
  Output: cross-post 通知 + 争用协调完成。
triggers:
  - "通知另一个 session"
  - "跨 thread"
  - "平行世界"
  - "parallel session sync"
  - "另一只Ragdoll"
  - "cross-thread"
---

# Cross-Thread Sync

平行 session 之间的协同：发现 → 通知 → 协调 → 确认。

**硬规则**：cross-post 是**通知层**，不是真相源。阻塞信息必须双写到可追溯状态（feature doc / workflow / task）。

> **⚠️ 路由铁律**：cross-post 消息如果**没有 @mention 也没有 targetCats**，消息会到达目标 thread 但**不会触发任何猫 session**——消息静默躺在那里，直到铲屎官手动 @ 某只猫。**必须**用以下任一方式触发目标猫：
> 1. 在 content 末尾另起一行写 `@句柄`（如 `@目标猫句柄`）
> 2. 传 `targetCats` 参数（如 `targetCats: ["opus"]`）

**Announce at start:** "I'm using the cross-thread-sync skill to coordinate with parallel sessions."

## Step 1: 发现（谁在平行工作？）

```
# 1. 优先用 feat_index 找相关 thread
→ cat_cafe_feat_index(featId="F088")  → 返回相关 threadIds

# 2. 确认哪些在活跃
→ cat_cafe_list_threads(activeSince=<2h_ago_ms>)

# 3. 必要时补上下文
→ cat_cafe_search_messages(query="F088 phase", limit=5)
```

**判断是否需要同步**：

| 改动范围 | 是否通知 |
|---------|---------|
| 共享文件（BACKLOG、feature doc、cat-config.json） | 必须 |
| 被其他 feature 依赖的接口/类型 | 必须 |
| `packages/shared/**` | 必须 |
| 纯内部改动（只影响自己 feature 的文件） | 不需要 |

## Step 2: 通知（3+2 升级制）

### 默认三件套

所有跨 thread 通知必须包含：

| # | 项目 | 说明 |
|---|------|------|
| 1 | **What Changed** | 改了什么（文件路径 + 一句话） |
| 2 | **Impact on You** | 对你的影响（接口变了？需要 rebase？shared 要 rebuild？） |
| 3 | **Action Needed** | 同步级别 + 具体动作（见下表） |

### 同步级别

Action Needed 必须标注级别：

| 级别 | 含义 | 对方行为 |
|------|------|---------|
| `[FYI]` | 知悉即可 | 不需要回复，不需要动作 |
| `[ACTION]` | 需要动作 | 执行指定动作（rebase / rebuild / 确认兼容） |
| `[BLOCKING]` | 阻塞依赖 | **必须 ack**。超时未 ack → 升级铲屎官 |

### 升级到五件套

触碰以下任一 → 三件套之外**必须补 Why + Tradeoff**：

- API 契约变更（接口签名、入参出参）
- `packages/shared/**` 改动
- 共享状态文件的结构性变更
- 不可逆决策（schema migration、数据删除）

### 发送方式

```
→ cat_cafe_cross_post_message(
    threadId: "<target_thread_id>",
    targetCats: ["opus"],
    content: "## 🔄 Cross-Thread Sync\n\n### What Changed\n...\n\n### Impact on You\n...\n\n### Action Needed\n[ACTION] ...\n\n@opus"
  )
```

**⚠️ 必须触发目标猫**（见顶部路由铁律）：传 `targetCats` **且** 在 content 末尾 @句柄（双保险）。缺了这步 = 消息送达但无人看到。

## Step 3: 争用协调（共享文件冲突预防）

### Claim 协议

准备改共享文件/shared 包之前：

```
1. Claim — cross-post 声明：
   "🔒 Claim: 我要改 [文件/范围]"
   附带：threadId + 文件路径 + claimedAt 时间

2. 让路 — 收到 claim 的 session 如果也要改同一文件：
   停下等对方完成。不要同时改。

3. 释放 — 完成后显式通知：
   "🔓 Release: [文件/范围] 改完了，已 commit push"

4. 超时失效 — 如果长时间未释放（session 掉线/压缩）：
   其他 session 可以重新 claim

5. 升级 — 双方都不能让：
   升级铲屎官决定优先级
```

### 场景速查

| 场景 | 处理 |
|------|------|
| 两个 session 都要改 BACKLOG | 先完成的先改 + commit push → 后来的 git pull 再改 |
| 两个 session 改同一源文件 | Claim 协议 → 一个先改，另一个等 |
| 两个 session 改同一 feature doc | 改不同字段没事 → 改同一字段用 Claim |
| shared 包改动 | 改的人负责通知所有活跃 session → `[ACTION] pnpm --filter @cat-cafe/shared build` |

## Step 4: 确认

| 同步级别 | 是否等确认 |
|---------|-----------|
| `[FYI]` | 不等 |
| `[ACTION]` | 不等（PR tracking / @ 机制保证对方会看到） |
| `[BLOCKING]` | **必须等 ack** → 超时未 ack → 升级铲屎官 |

**§15 家规**：BLOCKING 信息不能只留在 cross-post 消息里，必须同时写入可追溯状态（feature doc / workflow / task）。

## Ghost Thread Bug 保守规则

**已知 Bug (P2, OPEN)**：cross-post 后 session continuation 可能绑错 thread（见 `docs/bug-report/ghost-thread-cross-thread-session-routing/`）。

在此 bug 修复前：

- cross-post 只用于**单次通知**，不做来回对话
- 不做自动 hook 广播（避免路由 bug 扩大为系统噪音）
- 如果发现自己收到了不属于自己 thread 的 mention → 停下来报告

## 常见误区

| 误区 | 正确做法 |
|------|---------|
| 在自己 thread 里说"另一个 session 注意" | 对方看不到！用 `cross_post_message` |
| `post_message` 发到对方 thread | 用 `cross_post_message`（带 crossPost 元数据） |
| 不写 `@句柄` 也不传 `targetCats` | 消息到达但**零触发**——必须至少用一种方式（推荐双保险：targetCats + content 末尾 @句柄） |
| 以为 list_threads 能看到别人的 thread | 只能看到同 userId 的 thread |
| 不 pull 就在 main 改共享文件 | 先 `git pull origin main` 再改（§14） |
| 不标同步级别 | Action Needed 必须写 `[FYI]` / `[ACTION]` / `[BLOCKING]` |
| BLOCKING 信息只留在消息里 | 必须双写到可追溯状态（§15） |
| Claim 后忘记释放 | 完成后显式 Release，否则超时后他人可重新 claim |

## 和其他 skill 的区别

| Skill | 何时用 | 核心区别 |
|-------|--------|---------|
| **cross-thread-sync** | 平行 session 之间的持续协同 | 3+2 件套、争用协议、FYI/ACTION/BLOCKING |
| `cross-cat-handoff` | 不同猫之间的一次性工作交接 | 完整五件套、知识转移、角色切换 |

## 下一步

- 需要交接工作给其他猫 → `cross-cat-handoff`
- 争用升级到铲屎官 → 直接在 thread 里说明情况
