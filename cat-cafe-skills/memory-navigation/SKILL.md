---
name: memory-navigation
description: >
  记忆系统三入口路由（search_evidence / graph_resolve / list_recent）决策树 + 噪音控制 + 加载时机。F188 Phase F (AC-F6) 配套 skill。
  Use when: 没先验、压缩后回顾、"我记得最近讨论过 X"、search_evidence 反复 low-hit。
  Not for: 已有精确 anchor 直接 Read；代码符号查 Grep/LSP。
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
> 单一真相源：`cat-cafe-skills/refs/memory-routing-partial.md`

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
  └─ 否 → 用 cross-cat-handoff 找人问，或问铲屎官澄清需求
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
- **Partial**: `cat-cafe-skills/refs/memory-routing-partial.md`
- **Related skills**: `feat-lifecycle` / `debugging` / `cross-cat-handoff`
