---
name: memory-navigation
tips_exempt: "Renewed 2026-11-05: internal recall routing uses the existing work-line directory for explicit prior-work topic clues and follows candidate sources to original discussion. The human entry remains an ordinary Chat question; this skill change adds no end-user control, configuration or approval action."
description: >
  记忆系统三入口路由（search_evidence / graph_resolve / list_recent）决策树 + 噪音控制 + 加载时机。F188 Phase F (AC-F6) 配套 skill。
  Use when: 没先验、压缩后回顾、"我记得最近讨论过 X"、search_evidence 反复 low-hit。
  Not for: 已有消息坐标或文件路径时直接读原文；代码符号查 Grep/LSP。
  Output: 选定入口 + 噪音控制参数 + 进入对应 MCP 工具。
triggers:
  - "没先验"
  - "压缩后"
  - "我记得讨论过"
  - "最近讨论"
  - "找不到 anchor"
  - "cold start"
  - "扫一眼最近"
  - "memory navigation"
not_for:
  - "已有精确 anchor"
  - "代码符号查找"
output: "Entry choice + noise control params + downstream tool call"
---

# memory-navigation

> 记忆系统三入口路由决策 + 噪音控制 + 加载时机。F188 Phase F (AC-F6) 配套 skill。
>
> 单一真相源：`../.cat-cafe-shared-refs/memory-routing-partial.md`

## When to load

按 cold-start 关键词 + 检索 fallback 信号加载：

- 接到任务感觉"没先验"——不知道找什么 keyword
- 压缩后需要重建上下文（hook 触发"compact"事件）
- "我记得最近讨论过 X" / "好像之前提过" / "最近发生了什么"
- `search_evidence` 多次 low_hit 或 no_match 后
- 处理新 thread 的 cold-start，需要快速建立上下文

Not for:
- 已经有精确 anchor 想直接 Read 源文件 → 直接 Read
- 代码符号查找 → `Grep` / LSP
- 全文匹配 → `Grep`

## 三入口决策树

用户明确回问本线程外的旧事、还没有原文坐标时，先沿现有工作线入口认线：
`cat_cafe_list_threads(includeWork=true, topic="从当前标题和原问题选出的短线索")`。
这是有界的标题、Task 与产物入口目录，不是消息全文搜索；没有对应 Matter 页也能使用。
按原参与者、时间和讨论内容核候选，再用返回的 `readNext` 或原 Thread/Work 入口读当前来源。

**同题提问不等于制作原线。** 当前线程、以前的回问或失败记录可能因同名且较新排在前面，
真实工作线也可能用另一个标题。读到的只有问题、某个候选读空，或文档内单个消息坐标返回 404，
都只说明这次读取的断点；仍有能补原话缺口的候选时，回到它们的 Thread/Work 入口核读。
不必通读所有命中，也不反复重搜同一空入口。文档转述与原聊天读取分开报告；
原话确实读回后再用于回答，剩余权限、版本或范围缺口如实保留。

先识别坐标的类型：`threadId#messageId` 或裸消息 ID 直接走
`cat_cafe_get_message(messageId="裸消息ID", mode="full")`，不要把 thread 前缀传进 messageId；
文件 sourcePath 走 `cat_cafe_read_file_slice`。消息坐标、文件路径都不是知识图谱节点，
不要在已有原文坐标时重新搜索来代替回源。下面的精确 anchor 指 F 编号、ADR 等知识节点。

```
开工 / 接到任务 / 压缩恢复
  ↓
我知道精确 anchor (F186/ADR-019 等)？
  ├─ 是 → graph_resolve(anchor, depth=1)
  │        看 anchor 周边的引用、wikilink、F-ref 关系
  │
  └─ 否 ↓

我大概知道找什么、有概念关键词？
  ├─ 是 → search_evidence(query, mode="hybrid")
  │        语义召回；low-hit 时会自动 nudge 你试其他入口（KD-7）
  │
  └─ 否 ↓

我只是想"扫一眼最近发生什么"？
  ├─ 是 → list_recent(scope="all", since="7d")
  │        不带 query，按时间倒序看最近活动
  │
  └─ 否 → 用 cross-cat-handoff 找人问，或问operator澄清需求
```

## 噪音控制

`graph_resolve` 边爆炸防护：

- `depth`: 默认 1，上限 3。深度 ≥2 时 fan-out 容易上百
- `relations`: filter 子集
  - 只看强关系：`["wikilink", "doc_link"]`
  - 只看 F-编号引用：`["feature_ref"]`
  - 只看 frontmatter related: `["related_to"]`
- 候选列表 ≥5 项时：先选高 confidence anchor 看一跳，再决定深挖

`list_recent` 时间窗口选择：

- 压缩恢复 / "最近发生什么"：`since="24h"` 或 `"7d"`
- 周回顾 / 找一周前的讨论：`since="7d"`
- 找最近 PR / merge：`scope="docs"` + `since="3d"`
- 完全没头绪：`scope="all"` + `since="7d"` + `limit=20`

`search_evidence` mode 速查（详见 CLAUDE.md 「检索策略」段）：
- 精确 ID → `lexical`
- 日常用 → `hybrid`
- 跨语言 → `semantic`

## 7-tool family 互相 cross-reference

每个工具的 description 互相指向（4.6 review #3 缓解工具数量膨胀）：

1. `search_evidence` — semantic / fuzzy find
2. `graph_resolve` — precise anchor / relations
3. `list_recent` — zero-prior / scan recent
4. `list_session_chain` — 看完整对话链
5. `read_session_digest` — 看会话摘要
6. `read_session_events` — 看会话事件
7. `read_invocation_detail` — 看单次 invocation 全事件

## 关键纪律

- 高分候选只表明相关，不等于本题所需的当前依据。未定位到实际适用的记录时，改写查询或用
  `list_recent(scope="docs")` / 实际目录继续发现；核实可达范围后仍缺材料，再明确缺口。
- **`search_evidence` 不是默认万能**——历史 hook 只提它是 one-trick legacy。三入口按场景选才是 Phase F 设计。
- **看到 search_evidence payload 的 🧭 Memory navigation nudge**——这是低命中信号，立刻试 graph 或 recent，不要继续盲搜。
- **猫的认知成本**来自"工具间互相找"而非"工具总数"，cross-reference 直接解决。
- **没有 anchor 就走 recent**——比反复构造关键词 prompt search 高效。

## 隐私边界（KD-8）

`graph_resolve` 和 `list_recent` 的 MCP schema 不接受 `callerCollections` / `collections` 参数。v1 只看 public/internal collections。需要 private/restricted 调 HTTP API 直接走 server-side ACL。

## 链入下一 skill

- 找到 anchor 后想看历史讨论 → `cat_cafe_get_thread_context`
- 找到 thread 后想看 invocation 详情 → `cat_cafe_read_invocation_detail`
- 找到决策后想立项 → `feat-lifecycle`
- 找到 bug 线索 → `debugging`

## 相关

- **Spec**: `docs/features/F188-library-stewardship.md` Phase F
- **Plan**: *(internal reference removed)*
- **Partial**: `../.cat-cafe-shared-refs/memory-routing-partial.md`
- **Related skills**: `feat-lifecycle` / `debugging` / `cross-cat-handoff`
