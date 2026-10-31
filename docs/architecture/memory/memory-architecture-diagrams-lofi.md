---
title: "Memory Architecture Diagram Set｜记忆架构逐层低保真图集"
doc_kind: diagram
architecture_domain: memory
truth_mode: derived-view
canonical_for: memory-architecture-visual-blueprint
as_of: 2026-08-18
freshness_owner: memory-architecture
constructor_version: memory-architecture-lofi-v1
view_state: fresh
related_docs:
  - docs/architecture/memory/README.md
  - docs/architecture/memory-system-overview.md
  - docs/architecture/retrieval-pipeline-deep-dive.md
  - docs/architecture/memory-standing-reflex-contract.md
  - docs/architecture/memory-derived-view-contract.md
  - docs/architecture/memory-outcome-attribution-source-map.md
topics: [memory, architecture, diagram, low-fidelity, evidence, navigation, retrieval, write-side, standing-reflex, governance, presentation, outcome]
created: 2026-08-18
revised: 2026-08-18
status: active
author: "小太阳·Maine Coon/GPT-5.6 Sol"
description: "Clowder AI 记忆系统正式图集的低保真设计源：保存九张图的信息结构、权力边界、重画提示与失效条件。"
description_source: human
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-08-18T16:20:00Z
description_confirmed_by: codex-sol
description_updated_at: 2026-08-18T16:20:00Z
---

# Memory Architecture Diagram Set｜记忆架构逐层低保真图集

> **这不是又一份架构真相源。** 它是 [Memory Architecture Atlas](./README.md) 的视觉派生稿：
> 固定宽度图保存可维护的信息结构，正式 raster PNG 收录在
> [记忆架构逐层正式图集](./memory-architecture-diagrams.md)。ASCII 图必须在普通 Markdown renderer
> 中可读；若图与 canonical owner 冲突，以 Atlas 的 claim registry 指向为准。

## 出图合同

| 参数 | 本图集选择 |
|---|---|
| 受众 | 想学习 Agent 开发的工程师；同时服务家里内部架构对齐与 operator 录制 |
| 场景 | EP04 技术分享、架构导览、故障定位时的逐层讲解 |
| 内容取舍 | 不删权力边界；运行数字、phase、live/UAT 状态留在各真相源，不复制进图 |
| 视觉 | 16:9 横版；深蓝工程蓝图底、暖白线稿、琥珀金高亮；错误/失效用铁锈红，健康闭环用灰绿 |
| 语言 | 主图只用能直接说出口的中文；F 号和代码坐标放图下注释，不塞进画面 |
| 生成顺序 | P1-P9 低保真确认 → 逐页 imagegen → 正式图片链接回 Atlas 与 EP04（v1 已完成） |

## P1｜全局星图：一栋楼，两个方向，三条横切

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  我们的记忆系统                                                              │
│  左边回答“怎样留下来”                    右边回答“怎样在此刻想起来”          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                         ┌──────────────────────┐                              │
│                         │ ⑥ 治理层             │                              │
│                         │ 批准 · 纠正 · 遗忘    │                              │
│                         │ ACL · 失效传播        │                              │
│                         └──────────┬───────────┘                              │
│                                    │                                          │
│  新经历 ──▶ ⑤ 主动性层 ──▶ ④ 写入层 ──▶ Canonical Truth                     │
│                │                │              │                              │
│                │                │              ▼                              │
│                │                │       派生视图 / 索引 / 卡片                │
│                │                │              │                              │
│                └────────────── recall opportunity                            │
│                                               │                               │
│  原文 / 原件 ──▶ ① 证据层 ──▶ ② 导航层 ──▶ ③ 读取层 ──▶ 当前猫               │
│                                               │             │                 │
│                                               └── 回源 ◀─────┘                 │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  横切 A · 呈现/连续性：现在该送 cold 全包、hot delta，还是 omitted？          │
│  横切 B · 结果证据：presented ≠ inspected ≠ used ≠ helped                     │
│  横切 C · 主体边界：猫拿到线索后形成自己的 seed / intent / action             │
└──────────────────────────────────────────────────────────────────────────────┘
```

**这张图要讲清楚**：六层是口播顺序，不是六个 service；呈现与结果横穿整栋楼，不能硬塞成第七、
第八层。左侧“留下来”和右侧“想起来”共享证据与治理，但不是一条自动直写、自动相信的流水线。

**正式图视觉指引**：保留“大厦剖面”隐喻；P1 只画职责和流向，不出现数据库表名、状态数字或
feature ID。沿用现有 EP04 琥珀主图
的深蓝蓝图语言，但把两条循环和三条横切画清。

## P2｜① 证据层：先保证能回到“当时到底发生了什么”

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  输入：真实发生过的东西                                                      │
├───────────────────────┬───────────────────────┬──────────────────────────────┤
│ Thread / Message      │ Docs / Feature / ADR  │ Task / Event / External Art. │
│ 谁说的 · 何时说的      │ 哪个版本 · 谁拥有      │ 哪次运行 · 哪个原始结果       │
└───────────┬───────────┴───────────┬───────────┴──────────────┬───────────────┘
            │                       │                          │
            └───────────────────────┼──────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Evidence substrate                                                         │
│                                                                              │
│  source coordinate ─ owner/scope/ACL ─ revision ─ original payload location │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  只输出：可验证的 passage / source ref / drill handle                        │
│  不输出：系统替猫总结好的“最终真相”                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

**边界**：证据层不是一个万能数据库；原文可留在各自 owner。记忆系统优先保存坐标、revision 与
权限，让后续索引、卡片和摘要都能回源。纠正或遗忘发生时，证据 owner 才有权改变 canonical state。

**权威入口**：[Memory System Overview](../memory-system-overview.md) 的 Evidence Substrate 与
[ADR-020](../../decisions/020-f102-memory-system-architecture.md)。

## P3｜② 导航层：决定“从哪扇门进去”，不替猫读完

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  我现在知道什么？                                                            │
├──────────────────────┬──────────────────────┬────────────────────────────────┤
│ 有精确名字 / anchor   │ 有一句模糊问题        │ 什么都不知道，只想扫最近       │
│ graph_resolve         │ search_evidence      │ list_recent                    │
└───────────┬──────────┴───────────┬──────────┴───────────────┬────────────────┘
            │                      │                          │
            ▼                      ▼                          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  可重建导航资产                                                              │
│  Entity / Alias registry · FTS / Vector index · Graph · Fingerprint · Catalog│
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  输出：候选地址 + 为什么命中 + 下一刀 drill 建议                             │
│  不输出：哪条候选一定正确、猫应该采用哪条结论                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

**导航和读取的区别**：导航层回答“走哪条路、先看哪里”；读取层才真正执行召回、融合、排序、下钻与
回源。索引坏了可以重建，不能因此改写下面的 canonical truth。

**权威入口**：[Memory Architecture Atlas](./README.md) 的三入口路由、
[Memory Cue Source Map](../memory-cue-source-map.md)。

## P4｜③ 读取层：检索是水管，猫的搜索策略决定往哪浇水

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  Query + scope + mode + depth + intent                                       │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Recall                                                                       │
│  alias/entity resolve · BM25 · progressive relaxation · lexical backfill     │
│  vector NN · coverage / raw-passage / federated branches                     │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Fusion + Rerank                                                              │
│  RRF · CJK weight · authority · consumption · recency · immunity · MMR       │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Candidate envelope                                                          │
│  passage + source ref + entity match + authority + drill-down suggestion     │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  猫继续多刀搜索 / 读原文 / 比较反例 / 形成自己的回答                         │
└──────────────────────────────────────────────────────────────────────────────┘
```

**你问的文件放在哪**：
[Retrieval Pipeline Deep Dive](../retrieval-pipeline-deep-dive.md) **主要属于读取层**。它的前几步消费
导航层的 alias/index，最后又把 source ref 与 drill 建议交还给猫；所以它跨了导航—读取接缝，但 ownership
是 pull recall 的真实执行管线，不是“导航层的另一张索引图”。

## P5｜④ 写入层：不是一个入口，是七种不同的长期责任

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  Observation / proposal / first-person reflection                            │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼  route to exactly one lane
┌────────────┬────────────┬────────────┬────────────┬────────────┬──────────────┐
│ Entity     │ Taste      │ Profile    │ Event      │ Person     │ Knowledge    │
│ 名字/别名  │ 品味判断    │ 关系画像    │ 时间事实    │ 人物档案    │ 可复用知识    │
├────────────┴────────────┴────────────┴────────────┴────────────┴──────────────┤
│ Diary：猫自己的第一人称反思；允许带“未清洗”标签，不冒充 owner truth          │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  每条车道分别回答三问                                                         │
│  ① 何时触发？  ② 谁/什么校验？  ③ 谁消费，能否回到真实任务？                  │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Lane-owned canonical truth                                                  │
│  不建一个中央可写 registry，不共享一套审批语义                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

**边界**：`propose` 不是批准，写入成功也不等于未来会被读取；每条 lane 的 trigger、validation、consumer
必须分别闭环。Knowledge 没有明确 consumer 时，零触发不是“没问题”，也不能为了填格子强造 detector。

**权威入口**：[Write Lane Census](../memory-write-lane-census.md)；当前单 lane 状态回对应 feature spec。

## P6｜⑤ 主动性层：系统负责敲门，猫负责判断

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  机械事实发生                                                                │
│  subject_seen · judgment_surface_entered · typed lifecycle event · ...       │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Standing Reflex / closed catalog                                            │
│  校验 consumer · scope · source · dedupe · expiry · budget · eligible surface│
└───────────────────────┬───────────────────────────────────┬──────────────────┘
                        │                                   │
                        ▼                                   ▼
┌───────────────────────────────────┐   ┌──────────────────────────────────────┐
│ WriteOpportunity                  │   │ RecallOpportunity                    │
│ “现在值得判断要不要写吗？”         │   │ “现在值得浮现哪张地图/线索吗？”       │
├───────────────────────────────────┤   ├──────────────────────────────────────┤
│ 猫：propose / defer / abstain     │   │ 系统：零 cue 也合法                   │
│ proposal 仍进入 lane 自己的治理   │   │ 猫：drill / applied / dismissed       │
└───────────────────────────────────┘   └──────────────────────────────────────┘
```

**权力边界**：detector 只能报告“发生了什么”，不能判重要；F296 只能决定 admitted envelope 在当前
context 怎样呈现，不能替猫给 disposition；RecallOpportunity 与 WriteOpportunity 共享若干不变量，
但不合并 catalog，也不通向同一个终点。

**权威入口**：[Standing Reflex Contract](../memory-standing-reflex-contract.md)、
[F287 Cue Plane](../../features/F287-memory-cue-plane.md)。

## P7｜⑥ 治理层：谁拥有真相，谁才有权纠正和遗忘

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  Candidate / proposal                                                        │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Lane-owned policy                                                           │
│  approve / reject / not-now · provenance check · owner/scope/ACL             │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Canonical truth + revision                                                  │
└──────────────────┬────────────────┬─────────────────┬────────────────────────┘
                   │                │                 │
                   ▼                ▼                 ▼
              correct          forget/redact     ACL narrowed
                   │                │                 │
                   └────────────────┼─────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Invalidation fan-out                                                        │
│  index · summary · card · cue · prompt projection → suspect / invalidated    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**治理不等于“所有东西都让人逐条审批”**：不同 lane 可以有不同验证与批准方式；共同底线是候选不能
静默升权、纠正/遗忘/ACL 必须由 canonical owner 发出，并让派生读面 fail closed。

**权威入口**：lane feature specs、[Derived View Contract](../memory-derived-view-contract.md)、
[Memory ownership cell](../ownership/cells/memory.md)。

## P8｜横切 A：呈现与连续性——送到 prompt 之前，先证明这是哪个 context

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  Admitted envelope（directive / state / pointer / opportunity）              │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Provider-start handshake                                                    │
│  provider carrier × invocation origin × route topology                       │
│  fresh / replaced / unknown ──▶ cold      resumed + exact binding ──▶ hot    │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Context epoch + presentation mapper                                         │
│  cold：可信全包 / pointer    hot：只送 delta    unsupported：诚实 omit/cold   │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Prompt assembly → provider substantive output                              │
│  之后才写 content-free delivered / omitted receipt                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

**边界**：message freshness cursor 不能证明 provider continuity；token drop 也不能冒充 compaction。
F296 不复制 memory payload，只持当前 epoch 的呈现坐标与 content-free receipt。

**权威入口**：[F296 Context Presentation](../../features/F296-continuity-aware-context-injection.md)。

## P9｜横切 B：真相、派生视图与结果证据——快可以，夺权不可以

```text
┌───────────────────────┐
│ Canonical source      │
│ owner · revision · ACL│
└───────────┬───────────┘
            │ construct
            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Derived view envelope                                                        │
│ sourceRefs · sourceRevisions · asOf · validTime · ACL intersection           │
│ constructorVersion · invalidators · fresh / suspect / invalidated             │
└───────────┬───────────────────────────────────────────────────────┬──────────┘
            │ fresh                                                  │ change
            ▼                                                        ▼
      recall / cue / card                                  rebuild / pointer / omit
            │
            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  结果证据阶梯                                                                │
│  L0 presented ─▶ L1 inspected ─▶ L2 used ─▶ L3 outcome ─▶ L4 contribution    │
│     可观测          代理可观测       未有 typed      结果可见/归因粗     不可观测 │
└──────────────────────────────────────────────────────────────────────────────┘
```

**边界**：fresh view 可以直接用，但必须带来源；suspect/invalidated 不能先把旧正文污染推理再补救，
只能 bounded rebuild、给 source pointer 或 omit。展示频率可以告诉我们“更该抽验谁”，不能证明谁更真。

**权威入口**：[Derived View Contract](../memory-derived-view-contract.md)、
[Outcome & Attribution Source Map](../memory-outcome-attribution-source-map.md)。

## P1-P9 是否回答了原问题？

| 原问题 | 图中答案 |
|---|---|
| “读取本质是检索吗？” | P4：读取包含检索管线，但终点是猫回源、比较、形成回答，不是 Top-K 自动喂结论。 |
| “导航层是什么？” | P3：选择入口、索引与下一刀；它交付地址，不拥有内容。 |
| “Retrieval Deep Dive 在哪一层？” | P4 为主，消费 P3 的索引，并在输出端连接 P2 的 source coordinate。 |
| “每一层里面有什么？” | P2-P7 逐层列出输入、职责、输出、权力边界和首个权威入口。 |
| “六层为什么没写呈现/结果？” | P8-P9：它们是横切面，贯穿多层，不应硬塞成楼层。 |

## 正式精图生成指引

**统一视觉**：16:9、1920×1080；深蓝工程蓝图底，暖白线稿，琥珀金只高亮当前讲解路径；
铁锈红表示 invalidated/越权/错误，灰绿表示经验证闭环。保持建筑制图、剖面、尺寸线和坐标网格语言，
但避免装饰压过信息。

**排版纪律**：

- 每张图只有一个中心问题；标题能直接念给听众。
- 主画面不放 F 号、commit、状态数字或大段英文类型名。
- 关键边界必须写在画面里：`索引不拥有内容`、`detector 不判断重要`、`presented ≠ used`。
- 所有正文使用本低保真稿，不让 imagegen 自行补概念或改权力方向。
- 正式图输出到 `docs/architecture/memory/assets/`，命名 `memory-architecture-p{N}-*.png`。

| 页 | 正式图主题 | 主要视觉形态 |
|---|---|---|
| P1 | 全局星图 | 大厦剖面 + 左写右读双循环 + 三条横切 |
| P2 | 证据层 | 多来源汇入可回源地基 |
| P3 | 导航层 | 三扇入口门 + 可重建路标网络 |
| P4 | 读取层 | 四阶段检索水管 + 猫多刀下钻 |
| P5 | 写入层 | 七车道分流站，分别标三问 |
| P6 | 主动性层 | 敲门器分出 Write/Recall 两种 opportunity |
| P7 | 治理层 | canonical owner 发出纠正/遗忘/ACL 的失效波纹 |
| P8 | 呈现与连续性 | handshake → epoch → mapper → delivered receipt |
| P9 | 真相/视图/结果 | source→view 状态机 + 五级证据天花板 |

## 本图集的失效条件

本图集是 Atlas 的派生 view。Atlas 的观察面、claim owner、六层映射、检索阶段、七车道、Standing
Reflex disposition、F296 continuity contract 或 outcome ceiling 任一发生变化，本图集至少进入 `suspect`，
不得继续生成或展示“正式当前架构图”。

---

*Low-fidelity diagram set v1 · as-of 2026-08-18 · 小太阳·Maine Coon/GPT-5.6 Sol*
