---
doc_kind: architecture
description: "W0-D 派生视图 census v0.2：11 类现存 view 的 lineage 与 invalidation 矩阵；Wave 1 深读纠正 per-cat primer 与 Taste 的 current-main 结构链，并把过度概括的‘自动全健康/手工全带病’收窄为可重建性与失效合同才是健康分水岭。"
description_source: human
description_author: fable-5
description_updated_at: 2026-08-15T13:04:00Z
feature_ids: []
related_features: [F148, F276, F287, F200, F231, F296]
related_docs:
  - docs/architecture/memory-derived-view-contract.md
  - feature-specs/2026-08-15-memory-system-research-first-roadmap.md
  - docs/architecture/memory-write-lane-census.md
  - docs/architecture/memory-outcome-attribution-source-map.md
  - feature-discussions/2026-08-10-memory-write-trigger-rethink.md
topics: [memory, derived-view, lineage, invalidation, census, cache]
created: 2026-08-15
status: v0.2
---

# Memory Derived View Census（W0-D）

> **范围**：一切"从原始证据派生、被当作现成认知消费"的物件——cache / summary /
> card / index / view / 手册 / 文档现状节。逐个问两问：**lineage**（能回源吗）、
> **invalidation**（会过期吗、谁刷新、过期可见吗）。对照契约 = rethink §4.3 六字段
> （sourceRefs / revisions / valid-time / ACL / constructor version / stale state）。

## 1. 现存 view 盘点矩阵（11 类）

| View | 生产方式 | Lineage（回源） | Invalidation（失效） | Verdict |
|---|---|---|---|---|
| thread/session digest（summary_segments/state） | 自动 | 带 anchor | 增量重建 | ✅ 健康 |
| embedding / FTS 索引（4.4GB 主体） | 自动 | 完全（机械派生） | 全量可重建（entity_mentions 每次重建即先例） | ✅ 健康耗材 |
| anchor_recall_metrics / CTR 基线 | 自动聚合 | recall_events | 重算 | ✅ 健康耗材 |
| message_recall_index_snapshots | 自动 | 有 | 重建 + suppressions 表 | ✅ 健康 |
| F148 briefing / threadMemory | 自动 | 部分带 anchor | 每轮重建（短命 view，天然免疫过期） | ✅ 健康 |
| F287 RecallOpportunityCatalog | 生成 | 是 | token 预算约束（300/420） | ✅ 健康 |
| **memory-cue 卡（F276）** | 拉式（实体命中） | 带 drill 指针 | **sha256 内容指纹——全家唯一** | ✅ **模板级**：最接近六字段契约的 view（有指纹，缺 valid-time） |
| **MEMORY.md 索引** | **手工**（猫维护） | 链接 feedback 文件 | **人肉**——时态卫生纪律是唯一防线 | 🔴 全家最大的无契约 view；引用腐烂高危区 |
| **per-cat primer / 画像** | 手工/半自动 | canonical data root + persona scope + logical URI/authenticated read 已闭；内容级 source refs 弱 | compiler 每次可重读，但缺 source revision / valid-time / stale state | 🟡 结构链已修；trigger/organic consumption 与内容失效仍病 |
| **taste vignette/index passage** | 审批物化 + 自动索引 | proposal source refs + canonical-main vignette/index + sha256 passage revision | 文件变更可重建索引；speaker provenance 与显式 stale/ACL state 仍缺 | 🟡 write/read 结构链已闭；治理与消费健康未闭 |
| **docs "现状/Current State" 节** | 手工 | 引用 | **无 valid-time**——本项目稿件自证腐烂 n=2（F255"幽灵"/F276"dormant"过时快照） | 🟡 需 valid-time 书写纪律（as-of 日期已在部分文档实践） |

## 2. 核心发现

1. **生产方式只是风险预测器，真正分水岭是可重建性 + 失效合同**：自动生成通常更容易
   重建，手工维护通常更容易腐烂，但二者都不能凭生产方式自动判健康。primer 与 taste 的
   current-main 结构链已经修复，却仍缺 revision/valid-time/organic consumption；自动 view 若缺
   ACL、依赖谓词或 stale state 也同样会污染。**推论**：Wave 1 合同适用于所有会进入判断
   context 的 persisted view；手工 view 优先迁移，自动 view 只在缺 lineage/失效传播时入账。
2. **memory-cue 的 sha256 指纹是全家唯一的内容寻址先例**——谓词失效（rethink
   §4.3 三层设计）需要的地基已存在于一个 view，Wave 1 合同可以从"推广 cue 的
   指纹机制"起步而非发明新机制。
3. **§4.3 六字段目前没有任何 view 完整实现**；最接近的是 memory-cue（sourceRefs
   ✅ 指纹 ✅ drill ✅；缺 valid-time / ACL 显式化 / stale state）。
4. **短命 view 是被低估的健康形态**：F148 briefing 每轮重建、F287 catalog 每次
   生成——"活得短"天然免疫过期。**不是所有 view 都需要持久化**；持久化本身应
   是被论证的例外（呼应 rethink §4.3"有些东西不该物化"）。
5. 与 W0-G 的接缝：view 的**消费后果**观测（被有害消费如何被发现）依赖 F263
   `harmful_consumption`——emitter 缺席（Maine Coon W0-G 实测），故当前所有 view 的
   "被用错了"均不可见。view 契约与 outcome 契约必须在 Wave 1 同时冻结才闭环。

## 3. 首根法庭纵切建议（回传件 3）

按 W0-G 五条件（合同覆盖 / 可裁决 outcome / 可归因边界 / 最少新基建 / 负例能力）
结合本 census 评分：

- **首选维持 ASR→F276（Person 车道）**：合同覆盖穿 write trigger → receipt →
  证据闸 → 审批 → cue 消费全链；owner 裁决强（黄挺先例）；基建全在（最少新建）；
  负例路径 schema 已有（reject/not-now/correct/forget）；且它恰好测到本 census
  最关注的剪刀差（receipt 1104 vs cue 消费 3）。
- **反例自审（预注册"我最可能错在哪"）**：Taste 车道的 speaker/审批/organic consumption
  病灶覆盖面很广，且有跨 owner 野外
  样本——若 Wave 1 认为"法庭该选病最重的被告"，Taste 反超。我判 ASR→F276 仍
  优的理由：法庭第一案要的是**证伪合同的完整链路**，不是修最多的 bug——Taste 虽已有
  canonical write/read，但没有 F276 同等级的 immediate/deferred、reject/not-now、correct/forget
  负路径；补齐它们会触发“为法庭造特供”。Taste 作为第二根，其 speaker guard 本来就在
  rethink §12-11。
- 终选权在三份 census（C/D/G）合并评分 + operator，此处只立建议与反例。

## 4. 不足以冻结合同的（回传件 4 之 W0-D 部分）

- invalidation 判定为定性（读代码/store 结构），未做逐 view 的 supersede 实测
  （改一条 source 看哪些 view 声称自己 stale——目前预期全部沉默）；
- ACL intersection 维度本轮未查（view 的可见域是否窄于其 source 的并集）；
- 手工 view 的实际消费频率未量化（MEMORY.md 每 session 注入=高频消费高风险；primer 的
  加载路径已闭环，但 organic read/adoption 仍无 typed evidence）。

### 4.1 Wave 1 深读更正

W0-C v0.2 已给出 Taste/Profile current-main code 坐标。这里据此撤回“primer 无加载路径”、
“Taste 与索引断链”以及“自动全健康/手工全带病”的 current-state 断言；三者保留为历史事故或
风险启发，不再作为冻结合同的前提。合同仍需覆盖 revision、valid-time、ACL intersection、
constructor version 与 `fresh|suspect|invalidated`，因为结构链存在不等于失效闭环存在。

---
*W0-D census v0.2 · 原始 census Ragdoll/claude-fable-5；Wave 1 深读更正 小太阳·Maine Coon/gpt-5.6-sol · 2026-08-15 · 取证均为只读*
