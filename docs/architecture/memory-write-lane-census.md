---
doc_kind: architecture
description: "W0-C 写入车道 census v0.2：Entity/Taste/Profile/Event/Person/Knowledge/Diary 七条 lane 按 trigger→validation→consumption 三问重核；Wave 1 深读补齐 Taste canonical write→index→read 与 Profile canonical root→logical read 坐标，把缺口纠正为 speaker provenance、standing trigger 与 organic consumption。"
description_source: human
description_author: fable-5
description_updated_at: 2026-08-15T13:04:00Z
feature_ids: []
related_features: [F260, F276, F282, F227, F231, F221, F255, F263]
related_docs:
  - docs/architecture/memory-standing-reflex-contract.md
  - feature-specs/2026-08-15-memory-system-research-first-roadmap.md
  - docs/architecture/memory-write-side-autopsy-2026-07.md
  - docs/architecture/context-injection-reflex-source-map.md
  - docs/architecture/memory-outcome-attribution-source-map.md
  - feature-discussions/2026-08-10-memory-write-trigger-rethink.md
topics: [memory, write-side, census, lane, trigger, validation, consumption]
created: 2026-08-15
status: v0.2
---

# Memory Write Lane Census（W0-C）

> **取证纪律**：所有 counts 为 2026-08-15 runtime store 只读实测（evidence.sqlite /
> event-memory.sqlite / 文件系统）；"待深查"= 本轮未闭环，不装知道。基线对照 =
> F260 尸检（2026-07-08）。三问 = trigger（何时启动写入）/ validation（谁校验）/
> consumption（谁消费、闭环吗）。

## 1. 七车道三问矩阵

| Lane | Trigger | Validation | Consumption | Verdict |
|---|---|---|---|---|
| **Entity**（F260-A：doc-alias/feature/梗） | 输入流 nudge 运行中（`entity_nudge_events` **1568**）+ propose_entity（concept **0→5**，person 1→9） | doc-alias 自动分层；concept 管 Hub 审批 | 解引用亮牌 + `entity_mentions` 297k；`entity_revision_events` 14 | ✅ **活，三问齐**——F260 A1"词表死在出生那天"已翻案（registry 27→42，doc_aliases 0→**5148**） |
| **Taste**（F221） | 猫 propose——强产品面，活跃**过度**（TERRY 案：他猫语录被投入） | Hub 审批卡在，但 speaker 无机械校验 + 批量审批可击穿（跨 owner 实证） | 当前 main 已有 approve checkpoint → canonical-main vignette/index 原子 commit → IndexBuilder v11/TasteMemoryReader → F287 passage 的结构链；organic consumption quality 仍无足够样本 | 🟡 **结构链闭、治理与效用未闭**：触发过强 / speaker 校验软 / 有机消费不明；TERRY fork 孤岛是部署侧野外样本，不再代证家内 current main 断链 |
| **Profile / per-cat 画像**（F231） | 蒸发（operator 证词 2026-08-15"彻底蒸发"+"从认知路径蒸发"） | Hub 机制在 | 当前 main 已统一 canonical data root；L0 compiler 注入 `cat-cafe-profile://relationship/current`，authenticated `cat_cafe_read_profile` 回到同一 repository/persona。organic read 使用仍未量化 | 🔴 **触发死，结构链已修**：旧 F260-A2 双仓分裂是已修事故，不是 current topology；复活仍须 trigger 与真实消费同验，不能因 reader 存在宣称健康 |
| **Event**（F227 mark_event） | 猫 mark_event——`event_memory` **2152 行** | 型别约束（轻） | timeline + magic-word meanings 读面在（events.ts） | ✅ **活**——F260 A4"使用率未知"翻案；consumption 健康度未量化（待深查） |
| **Person**(F276) | 双路径：即时 propose + capture/defer（F282 receipt **1104**）——vertical slice 已通（2026-08-12） | 证据闸（两次实拦）+ owner 逐条审批——**全家最强校验** | `memory_cue_events` 仅 **3**——cue 读面刚通车 | 🟡 **最健全也最年轻**：消费端样本极少，Phase C dogfood 未开始 |
| **Knowledge**（W7 / distillation） | `distillation_candidates` **0 行** | — | — | 🔴 **零触发实锤**——F260 A5"触发率未知"翻案为零；W7"涌现是系统能力"仍是口号。需 keep-or-sunset 机制选择（operator） |
| **Diary**（F255） | present loop 定时唤醒 + 写盘义务——**41 篇**持续增长（3 猫） | 无需（第一人称；降权 +"未清洗"标签） | 已进索引（AC-A2）+ operator 阅读面（AC-A1.5）+ `reflection_outputs` 52；F231 organic proposal 通道零（AC-C2 未开工，**合法沉默**——MF-1 允许） | ✅ **活且健康**；唯一开放缺口 = organic proposal 通道 |

**对照 F260 基线的整体判读**：写侧不再"全裸"——Entity 复活、Person 新建、Event 证实
活着、Diary 健康；病灶收敛到三处：**Taste 的 speaker 校验与 organic consumption**、**Profile 的 trigger 蒸发**、
**Knowledge 的零触发**。"只有 taste 运转得好"（operator 2026-08-15 观察）需修正为：taste
是**触发最活但治理仍病**的车道——结构链存在，活跃度仍会掩盖 speaker 与效用缺口。

## 2. 每车道缺口与 owner（Wave 1 输入 · 回传件 1）

| Lane | 缺口 | 归属 |
|---|---|---|
| Entity | 无 P0 缺口；concept 管量低属正常（轻治理设计） | F260 维护态 |
| Taste | ① speaker 机械校验（quote 引 messageId 验 author）② canonical write/read 链的 organic consumption 与 harmful-use health | rethink §12-11；speaker guard 是确定契约，消费质量另按 consumer 决策 |
| Profile | standing trigger 重建 + organic consumption 证据；复用现有 canonical root/logical read，禁止再造第三仓 | F231 复活案，走 Standing Reflex 合同后实施 |
| Event | consumption 健康度量化（谁在读 timeline、频率） | F227 维护态，非紧急 |
| Person | Phase C dogfood（真实卡→审批→recall 验证 + Write Opportunity 记账） | Maine Coon/F276；operator 已 signoff 记账 |
| Knowledge | keep-or-sunset 决策（零触发两个月 = sunset 强候选，除非 Wave 1 给它触发合同） | operator 机制选择 |
| Diary | AC-C2 organic proposal 通道（做梦真长出观察时管道走得通） | F255/Ragdoll，Phase C |

## 3. Shared invariants 候选（Wave 1 合同输入 · 回传件 2）

1. **车道活性三因子**：触发存在 × 校验有效 × 消费闭环——缺一蒸发或污染（本 census
   七车道全部可用此公式判读）；
2. **speaker/provenance 机械校验**：owner 语录类车道的 quote 必须引 messageId 且
   服务端验 author——prompt 层叮嘱与审批卡都已被实证击穿（TERRY 案）；
3. **写入验收 = 端到端可搜**，不是落盘（taste fork 孤岛教训）；
4. **receipt 类信号必须有消费率审计**——无人消费的 receipt 与没写无异（F282 1104 条
   receipt vs cue 3 条消费的巨大剪刀差是第一个观测点）；
5. **审批面优化 anomaly 可见性而非吞吐**（speaker 高亮；批量确认关闭 owner 检测器）；
6. **typed disposition 三态**（propose/defer/abstain）——沉默留痕；
7. **零条 = no-data 不是零发生**（F263 先例已合同化此语义）。

## 4. 不足以冻结合同的（回传件 4 之 W0-C 部分）

- Taste/Profile 的 current-main 结构坐标已在 Wave 1 深读闭环；尚未闭的是两者 organic
  consumption、Taste speaker 误投是否被运行健康发现，以及 Profile trigger 的实际送达率；
- Event 车道 consumption 只证实读面存在，未量化健康度；
- `reflection_outputs` 52 条的生产者与消费闭环未查（F255 相关，待 Phase C 一并）；
- `markers` 表 0 行用途未核（爪感差另有存储的假设未验证）。

---
### 4.1 Wave 1 深读更正坐标（2026-08-15）

- Taste write：`callback-propose-taste-routes.ts` → `taste-proposal-decision-routes.ts` →
  `approveTasteProposal.ts` → `writeVignette.ts`；`TasteRepository.ts` 定位持有
  `refs/heads/main` 的 canonical root，public approve 原子 commit vignette + `docs/taste/index.md`。
- Taste read：`IndexBuilder.ts` v11 + `CatCafeScanner.ts` + `TasteMemoryReader.ts` 生成带
  sha256 revision 的完整 decision passage，并进入 F287 source。
- Profile read：`ProfileRepository.ts` 统一 `CAT_CAFE_DATA_DIR` / persona scope；
  `l0-compiler.ts` 与 `compile-system-prompt-l0.mjs` 生成 logical URI，
  `callback-read-profile-routes.ts` 以同一 repository 鉴权读取。
- 因此旧 F260/F231 split-brain 与 F221 canonical-write bug 只保留为 failure history；本文已按
  current main 纠正，不用历史事故冒充当前缺口。

---
*W0-C census v0.2 · 原始 census Ragdoll/claude-fable-5；Wave 1 深读更正 小太阳·Maine Coon/gpt-5.6-sol · 2026-08-15 · 取证均为只读*
