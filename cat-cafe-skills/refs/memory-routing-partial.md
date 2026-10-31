# 记忆系统三入口路由 (F188 Phase F)

> **Single source of truth for memory navigation routing.** Cross-referenced
> from CLAUDE.md / AGENTS.md / GEMINI.md / OPENCODE.md memory sections.
>
> Owner: F188 (Library Stewardship Phase F) | Created: 2026-05-10

## 入口决策表

先按来源类型回原文：已知 `threadId#messageId` / 消息 ID 用 `cat_cafe_get_message`（messageId 只传 # 后的裸 ID，mode=full）；已知文件 sourcePath 用 `cat_cafe_read_file_slice`。它们不是 graph 节点，不用重新搜索替代精确读取。

尚需发现候选或查知识图关系时，按场景选入口（F188 KD-9 单 PR 策略）：

| 场景 | 入口 | 何时用 |
|------|------|--------|
| **精确 anchor / 看关系** | `cat_cafe_graph_resolve(query, depth?, relations?)` | 已知 `F186` / `ADR-019` 等 anchor 看周边引用；或模糊词→候选列表 |
| **零先验 / 扫一眼最近** | `cat_cafe_list_recent(scope, since, limit?)` | 不知道找什么、"我记得最近讨论过 X" / 压缩后回顾 |
| **语义 / 模糊找** | `cat_cafe_search_evidence(query, mode?, scope?)` | 有概念/关键词需要语义召回；跨语言搜索 |

⚠️ Session hook 已更新为三入口提示（F200）。**按场景选入口**——精确 anchor 走 graph 比 search 命中率高得多；零先验扫一眼用 recent 比反复盲搜 query 高效。

## Clowder AI 7-tool memory family（cross-reference）

每个工具的 MCP description 都互相 cross-reference 这 7 个：

1. `search_evidence` — semantic / fuzzy find（lexical/semantic/hybrid）
2. `graph_resolve` — precise anchor / relations（沿边走）
3. `list_recent` — zero-prior / scan recent
4. `list_session_chain` — 看完整对话链
5. `read_session_digest` — 看会话摘要
6. `read_session_events` — 看会话事件
7. `read_invocation_detail` — 看单次 invocation 全事件

猫的认知成本主要来自"工具间互相找"而非"工具总数"——cross-reference 是缓解膨胀的解药（4.6 review #3 收敛）。

## 自动 nudge（KD-7）

`search_evidence` 在以下情况会在 return payload 末尾自动提示换入口：

- **no_match**: results.length === 0
- **low_hit**: 无 high/mid confidence doc anchor 命中

Nudge 文本指向 `cat_cafe_graph_resolve` 和 `cat_cafe_list_recent`。

**FM-5 measurement**: nudge truly fails iff 猫 ignores AND falls back to Bash grep（4.6 review #4 confound 排除）。

## 隐私边界（KD-8）

`graph_resolve` 和 `list_recent` 的 MCP schema **不接受** `callerCollections` / `collections` / `dimension` 参数。所有 collection 可见性由服务端从 agent identity 派生，client cannot self-grant private collection visibility.

v1 限制：只看 public/internal collections。Private/restricted 需要未来 server-side identity wiring。

## 排序行为（F200 — consumption-weighted ranking 已上线）

`search_evidence` 结果现在融合消费信号排序（`F200_CONSUMPTION_RERANK=on`）：

- 被猫猫实际消费（recall→Read/action）的文档排名提升；长期无人读的文档逐渐下沉
- Constitutional 文档（ADR/lesson/canon）永远不降权——consumption 低不代表不重要
- 新文档 14 天 grace period + Bayesian 先验，不会因缺数据被埋
- 近似重复结果 MMR 去重，前排更多样
- `graph_resolve` 边权重也融合消费频次（常走的路径权重更高）

不需要改变搜索方式——排序自动生效，结果更贴近实际使用价值。

## 项目经验留存后能被发现

沿原文档与合法 Git writer 留存时，把当前适用结论、主体/项目和条件放在首个正文段落，再附原消息/实测来源与经过。
已有正式领域入口时，更新它或从它关联新记录；不要把新经验留成原入口到不了的孤立文档。
现有 Markdown scanner 的摘要取首段；若首段只有测试计数或登记过程，摘要检索看不到后文的可复用结论。
写后核原文与索引版本；更正时在原记录更新当前结论，不复制一份竞争真相或为未来题目堆检索词。

## 参考

- Spec: `docs/features/F188-library-stewardship.md` Phase F
- Implementation plan: *(internal reference removed)*
- Related: F102 (memory system), F148 (navigation), F167 (A2A eval), F186 (library architecture)
