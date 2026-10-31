---
feature_ids: [F045]
related_features: []
topics: [ndjson, observability, transform, thinking, plan, telemetry, ux]
doc_kind: spec
created: 2026-02-27
---

# F045: NDJSON 可观测性 — CLI 事件流全量解析 + 多猫透明化

> **Status**: done (Phase 1+2 合并交付, PR #88) | **Owner**: Ragdoll
> **Created**: 2026-02-27
> **Priority**: P1

---

## Why

| 猫 | 当前处理 | 丢弃的宝藏 |
|----|----------|-----------|
| **Claude** | `text_delta`, `assistant`(text/tool_use), `system/init`, `result` | thinking_delta, input_json_delta, message_delta.usage, compact_boundary, rate_limit_event, result error subtypes, structured_output, hook_*, task_* |
| **Codex** | `agent_message`, `command_execution`, `file_change`, `thread.started` | reasoning, todo_list, mcp_tool_call, web_search, item-level error |
| **Gemini** | `message/assistant`, `tool_use`, `init`, `result/error` | （暂不在本 Feature 范围，Gemini CLI 事件较少） |

**operator痛点**：
1. 猫猫在想什么？前端看不到 thinking
2. 猫猫的计划进度？只能从自然语言硬抽，很脆弱
3. 出错了为什么？只显示笼统的 "error"，不知道是超 turn、超预算还是运行时异常
4. 多猫并行时，不知道每只猫做到哪了
5. token 消耗只在调用结束后才能看到，没有实时感知

## What

端到端的 CLI 事件流可观测性升级：**parser 补全 → 数据分层存储 → 前端可视化 → 多猫互操作**。

## 核心架构设计

### 数据三层模型

```
┌─────────────────────────────────────────────┐
│  用户可见层（Message）                        │
│  text / tool_use / tool_result / error       │
│  → 渲染为聊天气泡，存 MessageStore            │
│  → 不改！保持现有 AgentMessageType            │
├─────────────────────────────────────────────┤
│  可观测层（Observation）                      │
│  thinking / plan / tool_detail / web_search  │
│  → 可折叠/展开的附属面板                      │
│  → 存 InvocationRecord.observations          │
├─────────────────────────────────────────────┤
│  遥测层（Telemetry）                         │
│  token_usage / cost / rate_limit / compact   │
│  → 不渲染为消息，走独立 HUD/dashboard 通道    │
│  → 存 InvocationRecord.usage（已有）+ 扩展    │
└─────────────────────────────────────────────┘
```

**核心原则**：不碰现有 MessageStore schema，可观测层是纯增量。

### operator UX 决策（2026-02-27 采访）

| 问题 | 决策 | 理由 |
|------|------|------|
| Thinking 展示 | 方案 A：消息气泡内嵌折叠，默认折叠 | 直观，不干扰阅读 |
| Thinking 跨猫 | **暂不转发/查阅**（遗留到未来） | CLI 输出已经很多，再加 thinking 上下文爆炸 |
| Plan 位置 | 右侧看板（`RightStatusPanel`，已有） | 全局性，方便未来扩展 |
| Plan 持久化 | **必须修复**：当前刷新/页面重载后进度丢失 | operator痛点：刷新后右上角只显示"等待调用..."（V1 覆盖浏览器刷新；服务重启恢复为 follow-up） |
| Token/Cost | 保持原状（已有），不在 F045 范围 | F24 已实现 |
| 优先级排序 | **Plan > Thinking > Error subtype** | operator日常最想知道"猫做到哪了" |

### 现有 Plan 系统（F26 遗产）

当前已有一套 Plan 展示链路（仅 Claude）：
```
Claude TodoWrite tool_use → extractTaskProgress() → system_info WS → RightStatusPanel
```

**现有问题**：
1. **刷新丢失**：`chatStore` 纯内存，无 persist — 浏览器刷新后 taskProgress 清零（服务重启同理，但 V1 仅解决浏览器刷新场景）
2. **仅 Claude**：只检测 `TodoWrite` / `write_todos` 工具名；Codex 的 `todo_list` 事件完全没接
3. **无历史**：调用结束后 taskProgress 清空，无法回看

### 多猫互操作设计（精简版）

| 数据类型 | 本 Feature 范围 | 跨猫行为 |
|----------|----------------|---------|
| **thinking** | ✅ 解析 + 前端折叠 | ❌ 暂不跨猫（遗留） |
| **plan** | ✅ 解析 + 持久化 + 右侧看板 | ✅ 全局可见（TaskStore） |
| **error subtype** | ✅ 解析 + 错误条 | ✅ 全局可见 |
| **token/cost** | ❌ 已有，不做 | — |
| **tool_detail** | ❌ Phase 2（遗留） | — |

## Phase 拆分

### Phase 1: Parser 补全 + Plan 持久化（MVP）

**优先级最高：Plan 完整链路**
- [x] **Codex `todo_list` 解析**：`codex-event-transform.ts` 新增 `todo_list` started/updated/completed → `system_info` task_progress 事件（复用现有 Claude TodoWrite 链路）
- [x] **Plan 持久化修复**：`TaskProgressCache`（module-level Map）+ `GET /api/threads/:id/task-progress` + 前端 mount 时自动恢复。**V1 范围：浏览器刷新，非服务重启**
- [x] **Codex `reasoning` 解析**：`item.completed(reasoning)` → thinking system_info

**Claude parser 补全**：
- [x] `thinking_delta` → 累积 thinking 文本，content_block_stop 时产出 thinking 消息
- [x] `result` error subtypes → 区分 5 种（含 `error_max_structured_output_retries`）
- [x] `system/compact_boundary` → 压缩边界事件 + pre_tokens
- [x] `rate_limit_event` → 限流状态 + resetsAt/utilization

**Codex parser 补全**：
- [x] `mcp_tool_call` (started/completed) → tool_use / tool_result
- [x] `web_search` → system_info（query 计数，不落盘原文）
- [x] `item.completed(error)` → system_info warning（非致命，如 output truncated）

**数据模型（实际偏离 spec）**：
- ~~`InvocationRecord.errorSubtype?`~~ → 改用 error message 的 `content` 字段 JSON `{ errorSubtype }` 传递
- ~~`InvocationRecord.thinkingContent?`~~ → 改用 `system_info` message `{ type: 'thinking', text }` 实时传递，不落盘

### Phase 2: 前端可视化（与 Phase 1 合并交付）

- [x] **ThinkingBlock**：独立 `<details>` 折叠块（💭 思考过程），默认折叠 — ⚠️ **见 Gap #1**
- [x] **ErrorBanner**：5 种 error subtype 中文标签
- [x] **Plan 持久化 UI**：浏览器刷新/页面重载后右侧看板恢复上次 taskProgress

### 遗留（Future，不在本 Feature 范围）

- ~~**跨猫 thinking 查阅**~~：operator决策——"当真的需要的时候再设计，不然过度设计"
- ~~**ToolPanel**~~（MCP 工具详情折叠区）：等 Codex mcp_tool_call 实测验证后再考虑
- ~~**TokenHUD**~~：已有（F24 实现），不重做
- ~~**CatTaskOverview 跨猫总览**~~：Plan 持久化做好后自然可扩展

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

- [x] Codex `todo_list` 事件 → 右侧看板 Plan Checklist（与 Claude TodoWrite 同 UI）
- [x] Plan 持久化：浏览器刷新/页面重载后右侧看板恢复上次进度（V1 范围，服务重启恢复为 follow-up）
- [x] Claude parser 处理 `thinking_delta`（默认折叠）— ⚠️ 独立 system message，非嵌入气泡（见 Gap #1）
- [x] Codex parser 处理 `reasoning`（等同 thinking，同折叠 UI）
- [x] Claude parser 区分 5 种 error subtype（含 `error_max_structured_output_retries`）
- [x] Claude `compact_boundary` / `rate_limit_event` 解析（system_info）
- [x] Codex `mcp_tool_call` / `web_search` / `item.error` 解析
- [x] 所有新增解析均有对应单元测试（33+ fixture-based）
- [x] 现有 tests 不 regress（538 web + API 全过）

## Key Decisions

| 决策 | 选择 | 放弃的方案 | 理由 |
|------|------|-----------|------|
| 数据分层 | 三层（Message/Observation/Telemetry） | 扩展 AgentMessageType | 不碰现有 schema，纯增量，前端向后兼容 |
| thinking 展示 | 消息气泡内嵌折叠（方案 A） | 侧边栏 / 调试开关 | operator选择：直观 |
| thinking 跨猫 | **暂不做**（遗留） | 存+按需查阅 | operator："不然过度设计" |
| plan 位置 | 右侧看板（复用 RightStatusPanel） | 消息流内嵌 | 已有基础设施，全局性 |
| plan 互操作 | 全局可见 + TaskStore 同步 | 仅本猫可见 | 多猫协调基础 |
| web_search query | 默认只计数，不落盘 | 完整记录 | 隐私安全（Maine Coon建议） |
| token/cost | **不做**，保持原状 | 重做 HUD | 已有（F24），不重复 |
| AgentMessageType | 不新增 type | 新增 thinking/plan_update/telemetry | 保持接口稳定 |

## Risk / Blast Radius

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| CLI 升级改变事件格式 | 中 | fixture-based 测试 + 版本锁定提示 |
| thinking 持久化的隐私边界 | 低 | thinking 不含用户输入，主要是模型推理 |
| 第三方来源（takopi.dev）事件类型未验证 | 中 | Phase 1 开始前实测抓包确认 |
| InvocationRecord 膨胀 | 低 | observations 可设 TTL / 只保留最近 N 条 |
| 前端渲染性能（thinking 很长） | 低 | 虚拟化滚动 + 默认折叠 |

## Dependencies
- **Related**: 无

| Feature | 关系 | 说明 |
|---------|------|------|
| **F039 消息排队投递** | 🟢 无阻塞 | 并行，互不影响 |
| **F041 能力看板** | 🟢 无阻塞 | F041 管 MCP 配置，F045 管事件解析 |
| **F044 Channel System** | 🟢 F044 受益于 F045 | 更好的可观测性帮助调试 F044 |
| **前置研究** | ✅ 已完成 | GPT Pro 报告 + 原宝藏地图 |

**建议开发顺序**：F039A 合入 → F041 合入 → **F045** → F044

## Review Gate

| 轮次 | Reviewer | 结果 | 日期 |
|------|----------|------|------|
| 本地 R1 | Maine Coon/Codex | P0(auth)+P1(persistence)+P2(ghost) → 修复 | 2026-02-27 |
| 本地 R2 | Maine Coon/Codex | 通过，建议"重启项目"→"浏览器刷新/页面重载" | 2026-02-27 |
| 云端 R1 | Codex (GitHub) | 1P1 (targetCats 未恢复) → 修复 | 2026-02-28 |
| 云端 R2 | Codex (GitHub) | 1P2 (HTTP race 覆盖 WS 状态) → 修复 | 2026-02-28 |
| 云端 R3 | Codex (GitHub) | 2P2 (cache 泄漏 + 空 progress 恢复) → 修复 | 2026-02-28 |
| 云端 R4 | Codex (GitHub) | 2P2 (background thinking + error label) → 修复 | 2026-02-28 |
| 云端 R5 | Codex (GitHub) | 0 P1/P2，通过 | 2026-02-28 |

## 愿景守护 — Gap 分析（2026-02-28 三猫联合评审）

### Gap #1: Thinking 气泡归属 ✅ 已修复 (PR #91)

**spec 写的**："消息气泡内嵌折叠区域（方案 A）" — 暗示 thinking 嵌在 assistant 的消息气泡内部。

**修复**：PR #91 将 thinking 嵌入 assistant 气泡内部，不再作为独立 system message 渲染。

### Gap #1a: 🧠 Thinking 与 💭 心里话 并存显示 ✅ operator已拍板 (2026-02-28)

**问题**：当消息同时有 🧠 Thinking（extended reasoning）和 💭 心里话（CLI stream output）时，如何显示？

**operator决策**：
- **两块并存，都保持折叠** — 🧠 Thinking 和 💭 心里话 是不同概念，各自独立折叠
- **动态显示**：debug 模式默认展开（便于阅读）；play 模式保持折叠；且 thinkingMode 可随时切换，已渲染消息即时响应 ✅（PR #100）
- **当前实现**：ChatMessage.tsx 两块并存；默认折叠/展开由 thread-level `thinkingMode` 控制 ✅

**相关 PR**：
  - PR #94: 区分 🧠 Thinking label vs 💭 心里话 label
  - PR #95: thinking 持久化（F5 刷新后恢复 🧠 内容）
  - PR #97: hardDelete 清除 thinking 字段（安全 P1 hotfix + 回归测试）
  - PR #100: thinkingMode 动态控制 🧠/💭 折叠/展开（debug=展开，play=折叠）

### Gap #2: thinkingMode 默认值可能导致跨猫泄露 ✅ 已验证无泄露 (2026-02-28)

**发现者**：Maine Coon/GPT-52

**问题（历史担忧）**：`RedisThreadStore` 的 `thinkingMode` 默认是 `debug`。我们担心 debug 模式下 🧠 Thinking 可能被传递给其他猫作为上下文，违背operator“🧠 Thinking 永不跨猫”的约束。

**结论（已验证）**：🧠 Thinking 不会进入跨猫 prompt，上述担忧不成立：
- **prompt 组装**只使用 `StoredMessage.content`（不读取 `thinking` 字段），因此即便 thinking 持久化到 MessageStore，也不会注入到其他猫上下文
- `thinkingMode` 目前仅影响 **💭 心里话（CLI stream output）** 的跨猫可见性策略，以及前端折叠/展开默认行为（PR #100），不影响 🧠 Thinking 的跨猫隔离

**处置**：本 gap 关闭；如未来引入“把 thinking 注入 prompt”的能力，必须重新走operator拍板 + 安全评审。

### Gap #3: 截图证据缺失 ✅ 已补齐 (2026-02-28)

**Anti-Drift Protocol 要求**：前端 UI/UX 功能必须产出 ≤3 张截图 + "需求→截图"映射表。

**现状**：F045 有前端 UI 变更（ThinkingBlock、ErrorBanner、Plan 恢复），但未产出截图证据即合入。

**处置**：已在 runtime 上补截图验证，并补“需求→截图”映射表：

| 需求 | 证据截图 |
|------|----------|
| 💭 心里话折叠默认态（play 模式） | `docs/features/assets/F045/01-play-collapsed.png` |
| 💭 心里话展开态（可读性） | `docs/features/assets/F045/02-expanded-manual.png` |
| F5 刷新后仍能看到消息内容（历史加载）+ 右侧状态栏显示 thinkingMode | `docs/features/assets/F045/03-after-refresh.png` |

补充：15s 录屏（slideshow）`docs/features/assets/F045/04-demo-15s.mp4`

### Gap #4: Plan/Checklist 持久化到 Redis + 继续按钮 ✅ 进行中（2026-02-28）

**operator痛点**：CLI 进程被杀/异常退出时，计划（todo/checklist）仍有价值，需要可恢复展示，并提供“已中断（上次进度）+ 一键继续（新 invocation）”。

**处置（实现中）**：
- 将 task progress 从 module-level cache 升级为 **Redis-backed snapshots**（按 `(threadId, catId)` 存储，带 TTL）
- 快照包含：`tasks[]`、`status(running/completed/interrupted)`、`updatedAt`、`lastInvocationId?`、`interruptReason?`
- 右侧看板在 `interrupted` 时展示 `继续` 按钮（带确认弹窗），点击后发送一条**可见**的 `🔁` 消息（包含上次 checklist，上下文清晰可审计），触发新的 invocation（不尝试恢复死进程）

> 注：本段落会在相关 PR 合入后更新为 ✅ 已完成，并补 Timeline 记录。

## Test Evidence

- API tests: 2613 pass (含 33+ F045 fixture-based tests)
- Web tests: 538+ pass（后续补丁 PR 累积新增用例）
- Build: clean
- 截图证据：已补（见 Gap #3）

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
