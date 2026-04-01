---
feature_ids: [F043]
related_features: [F041, F052]
debt_ids: []
topics: [mcp, architecture, agent-collaboration]
doc_kind: feature-spec
created: 2026-02-27
---

# F043: MCP 归一化 — Server 拆分 + 协作工具补全

> **Status**: done | **Owner**: Ragdoll
> **Priority**: P1
> **依赖**: F041（能力看板 + 配置编排，现已就位）
> **Completed**: 2026-03-04
> **Evolved to**: F052（跨线程身份隔离 — cross_post_message 的身份/上下文/路由配套）

## 与 F041 的关系

- **F041**：team lead视角 — 能力看板 UI + 配置编排器 + 全局/每猫开关
- **F043**：猫的视角 — MCP server 本身怎么拆分、新增哪些协作工具
- F041 提供配置编排基础设施，F043 在此基础上重组 MCP server 架构

## Why

### 现状问题

1. **1 个 MCP server 挂 27 个 tools 平铺**：所有 tool schema 注入系统提示，prompt 臃肿，猫选工具认知负担大
2. **协作工具缺口**：猫不能按 catId 过滤消息、不知道有哪些 thread、不能跨 thread 通知、没有 feat→thread 索引
3. **file tools 冗余**：宿主 CLI 自带文件操作，MCP 再包一层无意义

### 猫的实际痛点（Ragdoll 4.5 + 4.6 共同反馈）

- **近视眼**：只能看到当前 thread，不知道其他 thread 的决策
- **接力棒丢了**：feat 接力时找不到前序 feat 的讨论在哪个 thread
- **肉眼找猫**：想看"Maine Coon说了什么"只能 `get_thread_context(limit=100)` 然后肉眼翻
- **隔墙喊话**：在 thread-A 做完了阻塞 thread-B 的工作，没有直接通知方式

## What

### 一、Server 拆分（1→3）

```
现状:
  cat-cafe-mcp (1 server, 27 tools 平铺)

目标:
  ① cat-cafe-collab  (协作核心, ~14 tools)  ← 三猫必装
  ② cat-cafe-memory   (记忆与回溯, ~9 tools) ← 按需
  ③ cat-cafe-signals  (信号猎手, 5 tools)    ← 按需
```

#### ① cat-cafe-collab（协作核心）

现有：post_message, get_thread_context, get_pending_mentions, ack_mentions, update_task, create_rich_block, get_rich_block_rules, request_permission, check_permission

新增：
- `search_messages` — catId/keyword 过滤 **[P0]**
- `list_threads` — thread 发现 **[P1]**
- `cross_post_message` — 跨 thread 发消息 **[P2 ✅]**
- `list_tasks` — 全局任务视图 **[P2 ✅]**

#### ② cat-cafe-memory（记忆与回溯）

现有：search_evidence, reflect, retain_memory, list_session_chain, read_session_events, read_session_digest, read_invocation_detail, session_search

新增：
- `feat_index` — feat→thread 映射 **[P1]**

#### ③ cat-cafe-signals（信号猎手）

现有：signal_list_inbox, signal_get_article, signal_search, signal_mark_read, signal_summarize

**注意**：Signals 是猫猫日报功能（F21++），三猫共用，不是某只猫专属。

#### file tools

删除 read_file, write_file, list_files。宿主 CLI 自带。

### 二、新增工具详细设计

#### P0: search_messages

扩展 `get_thread_context`，新增可选参数：

```typescript
// 新增参数
catId?: CatId | 'user'   // 按猫过滤（'user' = team lead消息）
keyword?: string          // 内容包含关键词
```

**场景**：
- "看 Sonnet 在这个 thread 说了什么" → `catId=sonnet`
- "搜之前关于 Redis 的讨论" → `keyword=Redis`
- "看team lead的原始需求" → `catId=user`

**实现**：在现有分页循环里加 `canViewMessage` 之后的额外过滤条件。

#### P1: list_threads

```typescript
interface ListThreadsInput {
  limit?: number;        // 默认 20
  activeSince?: number;  // 时间戳，只返回此时间后活跃的
}

interface ThreadSummary {
  threadId: string;
  title?: string;
  lastActiveAt: number;
  messageCount: number | null;  // Phase A: null（后续 countByThread 增强）
  participants: CatId[];  // 参与过的猫
}
```

**场景**："有哪些 thread？F039 的讨论在哪？"

#### P1: feat_index

```typescript
interface FeatIndexInput {
  limit?: number;        // 默认 20，最大 100
  featId?: string;       // 精确匹配 featId（case-insensitive）
  query?: string;        // 模糊匹配 featId + name + status
}

interface FeatEntry {
  featId: string;
  name: string;
  threadIds: string[];   // best-effort enrich（可为空；threadStore/backlogStore 异常时降级）
  status: string;
  keyDecisions?: string[];
}
```

**数据源**：`docs/features/*.md` frontmatter 为主，`docs/ROADMAP.md` 为补充；冲突时以 feature 文档为准。

#### P2: cross_post_message

独立的 `cat_cafe_cross_post_message` 工具，必须指定目标 `threadId`：

```typescript
threadId: string   // 必填，目标 thread ID
content: string    // 消息内容
```

> **#316 变更**：`post_message` 不再接受 `threadId` 参数（防止 session 上下文泄漏导致跨 thread 误投）。
> 跨 thread 投递必须使用 `cross_post_message`。

#### P2: list_tasks

```typescript
interface ListTasksInput {
  threadId?: string;     // 过滤特定 thread
  catId?: CatId;         // 过滤特定猫
  status?: TaskStatus;   // 过滤状态
}
```

## 验收标准

- [x] 27 tools 拆分到 3 个独立 MCP server
- [x] file tools 已移除，无功能回退
- [x] F041 配置编排器能正确管理 3 个 server 的加载/卸载
- [x] P0 search_messages 可用 + 测试
- [x] P1 list_threads + feat_index 可用 + 测试
- [x] P2 cross_post_message + list_tasks 可用 + 测试
- [x] 现有工具回归测试全部通过（server split / tool registration / capability probe 相关）
- [x] prompt 长度显著下降（按需加载 vs 全量注入，见下方量化表）

### Prompt 瘦身量化证据（拆分前后）

**口径**：以“每次会话暴露给模型的 MCP tool schema 数”作为 prompt footprint 代理指标（工具面越大，系统注入越重）。  
**取数来源**：`packages/mcp-server/test/tool-registration.test.js`（`EXPECTED_*_TOOLS` 常量，当前回归真相源）。

| 指标 | 拆分前（全量注入） | 拆分后（按需加载） | 变化 |
|------|-------------------|-------------------|------|
| 每次默认暴露的工具数（协作主链路） | 30（legacy `cat-cafe-mcp` 全量） | 15（仅 `cat-cafe-collab`） | **-50%** |
| 可选工具面（memory + signals） | 0（不可拆分，始终全量） | 15（`10 + 5`，按需启用） | 按需化（从“总是注入”变为“可关闭”） |
| file tools 暴露数 | 3（`read_file/write_file/list_files`） | 0 | **-100%** |

> 注：F043 立项时是 27 tools 口径；后续 Phase B 新增 P2 工具后，全量面口径为 30。量化表采用“当前代码口径”用于收尾验收。

## 实施建议

| Phase | 做什么 | 前置 |
|-------|--------|------|
| A | 新增 P0 工具（search_messages）| 无，可立即做 |
| B | Server 拆分（1→3 packages） | F041 配置编排就位 |
| C | 新增 P1 工具（list_threads, feat_index） | Phase B |
| D | 新增 P2 工具（cross_post_message, list_tasks） | Phase C |
| E | 删除 file tools + prompt 瘦身验证 | Phase B |

**注意**：Phase A 不依赖 F041，可以先做。

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
## Dependencies
- **Related**: 无

| Feature | 关系 | 说明 |
|---------|------|------|
| **F041** | 🔗 前置（server 拆分） | 配置编排器就位后才能 1→3 拆分 |
| **F042** | 🔗 毕业来源 | Thread metadata stage tracking 从 F042 Wave 3 毕业到此 |
| **F046** | 🟢 互补 | F043 提供基建，F046 在上面做愿景守护 |
| **F049** | 🔗 下游 | Mission Hub 需要 F043 的 `list_threads`/`feat_index` |

## 知识工程栈定位

F043 是知识工程栈的 **Layer 2（协作基建）**：

```
Layer 4: Mission Hub (F049) — 任务编排
Layer 3: Anti-Drift (F046) — 愿景守护
Layer 2: MCP Unification (F043) ← 本 Feature
Layer 1: Prompt/Skills (F042) — 知识编码 (Done)
Layer 0: Knowledge Engineering Research (Done)
```

### 从 F042 毕业的项目

| 项目 | 原 F042 位置 | 说明 |
|------|-------------|------|
| Thread metadata + stage tracking | Wave 3 | 线程上下文持久化，SystemPromptBuilder 每回合注入当前 stage |

### 实施优先级调整（2026-03-02 路线图收敛决策）

- **Phase A 先做**：P0 `search_messages` + P1 `list_threads`/`feat_index`（不依赖 F041）
- **Server 拆分执行**：F041 配置编排器就位后推进 Phase B
- **Thread metadata stage** 纳入 Phase A 或 Phase C

## 讨论来源

2026-02-27 team lead + Ragdoll (Opus 4.6) + Ragdoll (Opus 4.5)，F037 Agent Swarm 后续讨论。

核心问题由team lead提出："agent 之间的协作，在 thread 之内和跨 thread 会用到什么功能？现在的搜 codebase 够吗？猫猫咖啡如何进化给你们更多可能性？"

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
## 愿景守护签收表

| 猫猫 | 读了哪些文档 | 三问结论 | 签收 |
|------|-------------|---------|------|
| Ragdoll (Opus 4.6) | F043 spec, VISION.md, tool-registration.test.js, callback-tools.test.js | ① team lead不想当人肉路由器 ② 7/7 AC 通过，愿景对齐 4/5 ③ 猫能自主搜消息/发现 thread/跨 thread 通知/查 feat 映射 | ✅ |
| Maine Coon (GPT-5.2) | F043 spec, VISION.md, tool-registration.test.js (50/50), capability-orchestrator.test.js (51/51) | ① team lead不想当路由器+猫要自主找上下文 ② 交付物直接贡献愿景 #1/#2/#3/#5 ③ 查证据/找入口/发接力棒/管任务四条链路可用 | ✅ |

### GPT-5.2 Open Questions 立场（记录）

1. `feat_index.threadIds` best-effort 降级为空数组：**够用**（发现入口，非强一致索引）
2. `list_threads.messageCount` Phase A 为 null：**可接受**（契约已明确，后续增强单独跟踪）
3. Layer 2 对 Layer 3/4 基建充分性：**充分**（thread 发现/feat 映射/跨 thread 通知/全局任务视图均已就位）
