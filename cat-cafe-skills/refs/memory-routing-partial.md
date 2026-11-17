# 记忆查找与读取（F188 Phase F → F332 找归一）

> **Single source of truth for memory finding.** Cross-referenced from CLAUDE.md / AGENTS.md / GEMINI.md /
> OPENCODE.md memory sections. Contracts: [find entry](../../docs/architecture/memory/find-entry.md),
> [read entry](../../docs/architecture/memory/read-entry.md).

## 一个找入口，一个读入口

已知坐标直接读，不再搜：结果、目录、提示给的完整 `readRef`，或已知的 `threadId#messageId` / 文件路径，交给
`cat_cafe_read_memory({ref})`（消息用 `{kind:"message",messageId:"# 后的裸 ID"}`，文件用 `{kind:"file",path,startLine:1}`）。

要找候选时只用 `cat_cafe_search_evidence`，不必先选工具或模式：

- **交原句或编号**：同一线索并行交给本身份能查的组——文档（docs）、原消息（messages）、图谱（graph：精确编号如
  `F186`/`ADR-019` 返回它的关系子图，其他文字返回候选编号）、事情页（matters：整句字面匹配标题/说明）。
- **没有线索**：不带 query，看最近记录（recent：`since` 默认 7d，`scope`/`kinds` 取交集，`scope=trajectories` 看任务轨迹）
  与事情目录。最近记录按时间排，不是相关度。
- 每组各报状态（ok / no_results / not_covered / deferred / failed / timeout）。`next.arguments` 原样传回只重开那一组。

## 覆盖与来源判断（留下的有用部分）

- **收窄条件**（scope、dimension、threadId、dateFrom/dateTo/since、kinds）每组都守，守不住的组标 `not_covered`，不会悄悄放宽。
  `not_covered` 和 `no_results` 不是一回事：前者是这组没查，后者才是查了没有。
- 任何一组 0 命中、或 `sourceProjection` 落后，都不证明"不存在"；只说明已查范围未发现。
- 排名（rank/matchRank）只是位置；语义"最相似"不等于确认相关。用于结论的材料要读原文，并核主体、项目、条件与版本。
- "哪些/所有/历史上"这类覆盖题，一次查询不是全集：按 `memory-search-best-practices` 分开查 docs 与 threads、扩措辞，再报覆盖边界。
- 找不到精确编号时，先交原句；交编号能同时拿到它的图谱关系（`graphDepth` 1–3、`graphRelations` 只影响图谱组）。

## 自动提示（KD-7）

docs 组 0 命中或相关度未知时，文档块末尾会带 🧭 提示：改写或放宽线索、交精确编号看图谱关系、不带 query 看最近。
其他组的结果已在同一次响应里，先读各组状态，再决定是否换线索。

## 隐私边界（KD-8）

图谱组与最近组的可见性由服务端从身份派生，只看 public/internal collections；客户端不能给自己开私有集合。
显式给 `dimension` 时这两组报 `not_covered`，不会把原范围放宽。文档组沿原 dimension/collections 规则。

## 排序行为（F200 — consumption-weighted ranking 已上线）

文档结果融合消费信号排序（`F200_CONSUMPTION_RERANK=on`）：

- 被猫猫实际消费（recall→Read/action）的文档排名提升；长期无人读的文档逐渐下沉
- Constitutional 文档（ADR/lesson/canon）永远不降权——consumption 低不代表不重要
- 新文档 14 天 grace period + Bayesian 先验，不会因缺数据被埋
- 近似重复结果 MMR 去重，前排更多样；图谱边权重也融合消费频次

不需要改变搜索方式——排序自动生效。

## 项目经验留存后能被发现

沿原文档与合法 Git writer 留存时，把当前适用结论、主体/项目和条件放在首个正文段落，再附原消息/实测来源与经过。
已有正式领域入口时，更新它或从它关联新记录；不要把新经验留成原入口到不了的孤立文档。
现有 Markdown scanner 的摘要取首段；若首段只有测试计数或登记过程，摘要检索看不到后文的可复用结论。
写后核原文与索引版本；更正时在原记录更新当前结论，不复制一份竞争真相或为未来题目堆检索词。

## 会话下钻（不属于找入口）

本人会话：`list_session_chain` → `read_session_digest` / `read_session_events` / `read_invocation_detail`。

## 参考

- Plan: *(internal reference removed)*（F332 找归一，F1/F2）
- Spec: `docs/features/F188-library-stewardship.md` Phase F（原三入口设计，已由 F332 F2 归一）
- Related: F102 (memory system), F186 (library architecture), F200 (recall eval)
