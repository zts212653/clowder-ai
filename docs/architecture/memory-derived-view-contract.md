---
doc_kind: architecture
description: "Wave 1 Memory Derived View Contract v1：冻结 cache/summary/card/index/拉式物化 view 的 lineage、revision、valid-time、ACL intersection、构造版本、fresh/suspect/invalidated 状态、失效传播与 fail-closed 回源合同；明确 ephemeral-first 与 popularity 不提升 truth。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-15T13:04:00Z
feature_ids: []
related_features: [F148, F200, F221, F231, F263, F276, F287]
related_docs:
  - docs/architecture/memory-derived-view-census.md
  - docs/architecture/memory-outcome-attribution-source-map.md
  - docs/architecture/memory-standing-reflex-contract.md
  - feature-specs/2026-08-15-memory-system-research-first-roadmap.md
  - feature-discussions/2026-08-10-memory-write-trigger-rethink.md
topics: [memory, derived-view, cache, lineage, invalidation, valid-time, acl]
created: 2026-08-15
status: frozen-v1
---

# Memory Derived View Contract v1

> **冻结对象**：从 canonical source 派生、会被当作现成认知消费的 cache / summary / card /
> index / materialized view。view 可以更快，不能因此获得更高 authority。

## 1. 基本判词

```text
canonical source(s)
  → constructor + dependency predicate
  → derived view (fresh | suspect | invalidated)
  → read / revalidate / rebuild / omit
```

Derived view 不是第二真相源。无法说明“来自哪里、按哪个版本构造、何时失效、失效后怎么办”的
物件，不得作为 fresh truth 进入 prompt。

## 2. `DerivedViewEnvelopeV1`

| 组 | 必填字段 | 语义 |
|---|---|---|
| identity | `viewId`, `viewType`, `ownerCell` | 稳定 identity；owner 管构造与失效，不拥有 source truth |
| lineage | `sourceRefs[]`, `sourceRevisions[]`, `dependencyPredicate` | 能 drill 回原文；revision 与 ref 一一对应 |
| time | `constructedAt`, `asOf`, `validTime` | constructedAt 是生成时间；asOf 是证据截止；validTime 是内容声称覆盖的现实区间 |
| scope | `ownerScope`, `aclIntersection`, `privacyClass` | view 可见域不得宽于全部 source 的交集 |
| constructor | `constructorId`, `constructorVersion`, `modelRef?` | 规则/模型升级可重建；modelRef 不是 source authority |
| lifecycle | `state`, `stateReason`, `invalidators[]`, `lastValidatedAt` | state 固定 `fresh/suspect/invalidated` |
| fallback | `onMiss`, `onSuspect`, `onInvalidated` | 只能 rebuild / source pointer / omit；禁止静默使用旧正文 |

`sourceRevision` 优先使用 canonical store revision；文件型 source 可复用 F276/F287 memory-cue 的
`sha256` 内容指纹。时间戳不能替代内容 revision。

## 3. 状态语义

| State | 允许读取 | 必须动作 |
|---|---|---|
| `fresh` | 可读，但仍携带 asOf/source refs | 命中依赖谓词或 revision 变化时转 suspect/invalidated |
| `suspect` | 不把正文当 fresh truth；最多呈现 bounded pointer/“需重建” | 回源 revalidate 或 rebuild；失败则 omit |
| `invalidated` | 禁止读取派生正文 | 删除/隔离旧 payload，回 canonical source；若 source 已 forget 则零回显 |

“先用旧 view，错了再找原文”不合法：旧 view 会先污染同一推理 loop，使后续 correction 变成带锚
确认偏差。fail-closed 的代价是偶尔变慢，而不是偶尔把旧快照包装成事实。

## 4. 失效传播矩阵

| Source delta | 默认 view transition | 说明 |
|---|---|---|
| append | 依赖“截至现在/最近/完整集合”的 facet → `suspect`；不依赖新增范围的 facet 保持 fresh | 由 dependency predicate 决定，不能一刀全删 |
| supersede / replace | 引用旧 revision 的 facet → `invalidated` | replacement 不自动证明新结论与旧结论等价 |
| correct | 直接或传递依赖被纠正 claim 的 facet → `invalidated` | correction owner 仍在 canonical lane |
| forget / redact | 所有能恢复被删除 payload 的 facet → `invalidated` 并清除正文 | “不检索”不等于删除；view 不能成为遗忘旁路 |
| ACL/privacy 收窄 | intersection 重新计算；越权 view → `invalidated` | 权限只可 fail closed，不以 cache hit 为理由放宽 |
| constructor/model upgrade | 旧构造版本 → `suspect`，是否批量重建由 consumer/成本决定 | 模型变更不改 source truth |
| valid-time 到期 | `suspect` | 允许重验后续期，不允许默认续期 |

Facet 级依赖优先于整张 view 级失效：例如人物综合页的“身份”与“最近互动”可以分别依赖不同
source/predicate，避免一条新互动使整张卡永久短命。

## 5. 是否持久化

默认 **ephemeral-first**。满足下列全部条件才值得持久化：

1. 有明确 consumer 与重复读取需求；
2. 重建成本或时延足以影响该 consumer；
3. source revision / dependency predicate 可被稳定观察；
4. correction/forget/ACL 能级联到 view；
5. 有删除或重建 owner。

不满足时，每轮重建的短命 view 是健康终态。F148 briefing、F287 catalog 与机械索引证明“活得短”
可以天然免疫过期；持久化不是成熟度勋章。

## 6. 手工 view

MEMORY.md、primer、taste 手册、docs `Current State` 等手工物件若承载派生认知，必须二选一：

- 迁入可重建的自动管道；或
- 明写 `asOf/validTime + sourceRefs + owner`，且消费面把过期状态投影为 suspect。

仅靠“写作者记得更新”不构成 invalidation。文档引用 F255“幽灵”和 F276“dormant”的历史腐烂已
证明人肉时态卫生会失败。

## 7. 读取算法

```text
1. resolve owner scope + ACL intersection
2. compare source revisions / valid-time / constructor version
3. fresh      → return body + asOf + drill refs
4. suspect    → rebuild if bounded; otherwise pointer/omit
5. invalidated→ never return old body; source rebuild or zero result
6. record hit/miss/suspect/invalidated/rebuild/omit outcome
```

自动重建失败不把旧 payload 降级成 fallback。`stale-while-revalidate` 只适用于不参与 truth/judgment 的
低风险展示；一旦 view 进入模型判断 context，必须按上表 fail closed。

## 8. Telemetry 与 mechanism selection

运行健康只记录 cache hit/miss、revalidation latency、rebuild error、invalidated read prevented、ACL
suppression 与 source drill。popularity/CTR 可用于分配审计预算，不提升 view 或 source 的真值等级。

只有存在明确的 keep/tune/sunset consumer 时，才用 eval 比较：

- view 是否比直接回源更快且不降低纠正率；
- suspect/invalidated 是否在 owner 期望前被拦住；
- view 是否减少 token/latency 而未提高污染成本。

不存在 consumer 时不为了合同完整度建立 eval；确定性的 lineage/ACL/forget 传播用 schema、guard、
fixture 和重建测试守。

## 9. 现存 view 迁移顺序

| 顺序 | 对象 | 理由 |
|---|---|---|
| 0 | memory-cue | 已有 source refs + sha256 + drill，是合同 fixture，不重建一套 |
| 1 | 首根 contract trial 的人物 cue/view | 能同时打 correct/forget/stale/absence 负例 |
| 2 | per-cat primer / profile projection | canonical root 已修，仍需 revision/valid-time 与消费证据 |
| 3 | taste vignette/index projection | canonical write/read 已闭，先补 speaker provenance 与消费健康 |
| 4 | MEMORY.md / docs Current State | 高频手工 view；需 asOf/valid-time hygiene 或自动生成 |

自动 FTS/vector/digest 不因“合同存在”就逐项迁移；它们只有在缺 lineage、ACL 或失效传播时才进入
工作清单。

## 10. Contract Trial Ready gate

首根纵切必须证明：

- positive hit 带 source revision/asOf/drill；
- source append 能只使相关 facet suspect；
- correct/forget/ACL revoke 使旧 payload invalidated 且不可回显；
- stale/miss 回源重建或 omit；
- outcome 只报告实际可观测层级，不把 view 高频命中写成“它是真的/有用”。

---
*Frozen v1 · 小太阳·Maine Coon/gpt-5.6-sol · 2026-08-15*
