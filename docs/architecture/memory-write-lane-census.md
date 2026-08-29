---
doc_kind: architecture
description: "W0-C 写入面 census v0.3：覆盖全部 durable memory-bearing surfaces，以感知→提案→裁决→消费四拍盘点，并拆分 LL/Decision/Method 与 F152 global distillation。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-26T06:00:00Z
feature_ids: []
related_features: [F102, F152, F221, F227, F231, F255, F260, F263, F276, F282, F287]
related_docs:
  - docs/architecture/memory-standing-reflex-contract.md
  - feature-specs/2026-08-15-memory-system-research-first-roadmap.md
  - docs/architecture/memory-write-side-autopsy-2026-07.md
  - docs/architecture/context-injection-reflex-source-map.md
  - docs/architecture/memory-outcome-attribution-source-map.md
  - docs/decisions/015-knowledge-object-contract.md
  - feature-discussions/2026-08-10-memory-write-trigger-rethink.md
topics: [memory, write-side, census, lane, convention, lifecycle, lessons-learned]
created: 2026-08-15
status: v0.3
---

# Memory Write Surface Census（W0-C）

> **v0.3 范围更正**：v0.2 的七条产品 lane census 没有错，但 universe 太窄——它以 MCP/API
> 写入工具为主要观察面，漏掉了 LL、ADR/Decision、Method/Skill、feedback、reflection、
> provider-local memory 等最老、最常用的文件习俗。本文保留原七 lane 结论，同时把所有能改变未来
> 猫的判断、行为或 owner-visible truth 的 durable surface 纳入同一四拍盘点。

四拍 = ①感知（何时知道可以写）→ ②提案（从哪个入口、typed 成什么）→ ③裁决（谁签字、在哪签）
→ ④消费（谁读、能否纠正/遗忘、是否可观测）。答案可以是 `none`、`exempt`、`unknown` 或
`sunset`，但不能缺席。**统一协议，不统一 detector、store 或审批权。**

## 1. 七条产品 lane：v0.2 结论保留

下表 counts 是 2026-08-15 runtime/file snapshot；current topology 仍以各 feature truth 为准。

| Lane | 感知 / trigger | 提案与裁决 | 消费 | v0.3 判读 |
|---|---|---|---|---|
| **Entity / F260** | input nudge 运行中；历史 snapshot `entity_nudge_events=1568` | doc alias 可机械分层；concept 走 Hub | 解引用、entity mention/revision reader | ✅ 健康；无需为协议整齐重做 |
| **Taste / F221** | 猫主动提议，触发很活 | Hub 审批；speaker/quote author 仍缺机械校验 | canonical vignette→index→F287 已接通；organic use/harm 样本不足 | 🟡 结构闭，治理与效用未闭 |
| **Profile / F231** | standing trigger 从认知路径蒸发 | Hub 合同存在 | canonical data root→logical URI→authenticated reader 已接通；organic read 未量化 | 🔴 触发死；不能再造第三仓补偿 |
| **Event / F227** | `mark_event` 活跃；历史 snapshot 2152 行 | typed write、轻校验 | timeline/magic-word reader 存在，消费健康未量化 | ✅ 写入活；缺运行健康证据，不等于缺 detector |
| **Person / F276** | immediate propose + capture/defer；ASR scene 可形成 WriteOpportunity | owner evidence gate + 逐条审批 | relationship recall、cue、correct/forget 已有；Standing Reflex real runtime episode 仍待验证 | 🟡 合同最完整；继续作首案法庭 |
| **Global distillation / F152** | `distillation_candidates=0`（2026-08-15 snapshot） | 独立 SQLite nominate/approve | materialize 到 global distilled truths；无已证明 consumer | 🔴 keep/sunset；**只代表跨项目蒸馏，不代表全部 Knowledge** |
| **Diary / F255** | present loop 定时唤醒 | 第一人称作者自治，合法免 operator 审批 | index + operator 阅读面 | ✅ 健康；不强塞 owner-approval 模型 |

旧结论“Knowledge 零触发、无 consumer”在 v0.3 被**限缩**为 F152 global distillation。项目内
Operational Knowledge（LL / Decision / Method）每天都在被 scanner、search、F287、Skill/ADR 链路
消费；把两者揉成一个 lane，会把高权重行为真相误判为 sunset 对象。

## 2. 文件习俗写入面：四拍 current-state census

| Durable surface | ① 感知 | ② 提案 | ③ 裁决 / canonical target | ④ 消费与失效 | Verdict / owner |
|---|---|---|---|---|---|
| **Normative Lessons Learned** | feature/PR 收尾、用户纠正、self-evolution、L0 提醒；无共享 mechanical opportunity | A. 直接改 `docs/public-lessons.md`；B. F102 marker；C. `docs/lessons-learned/*.md` | A/C 依赖 Git author/review；F102 显式 candidate 可 auto-approve、推断 candidate 另审；Approval Hub producer catalog 无 Lesson/F102 | monolith 被 scanner 拆成 authoritative passages；目录项进入 search/F287，但 exact lesson adoption/harm 无统一 receipt；correction 走 Git | 🔴 **同一规范 authority 有多套出生法**；memory/knowledge governance owner |
| **Decision / ADR** | 方向分歧、operator 拍板、feature lifecycle | discussion/plan 后 direct ADR edit | operator、reviewer 与 Git history；canonical 在 `docs/decisions/` | doc links、search、L0/Skill 引用；单次消费回执不统一 | 🟡 authority 较清楚，四拍未机器化；architecture governance owner |
| **Method / Skill** | 重复成功/失败、self-evolution、writing-skills | direct Method doc 或 Skill package/edit | 方法 owner + reviewer/发布门；canonical 依对象而异 | Skill manifest/load 是真实 consumer；Method doc 走 search；usage evidence 不同源 | 🟡 不应强行合库；需 closure adapter 与 authority map |
| **Episode / Reflection / Diary** | 真实任务结束、present loop、自省 | typed store 或 direct file | 事实 episode 可先落 provenance；第一人称 reflection 由作者自治 | scanner/search/diary reader；promotion 成规范 LL 前必须另走裁决 | 🟡 证据与规范必须分层；F255/各 producer owner |
| **Feedback / Verdict / harness evidence** | eval/harness 运行与用户反馈 | 各 producer 的 typed artifact/publication | Eval Hub/verdict-specific contract 已较强，不由 memory Hub 接管 | Eval consumer、sunset/iterate 决策；但 scanner 把 `harness-feedback` 等统一映射成 `lesson` | 🟡 保留原 authority；禁止“被检索为 lesson”自动升级成 LL |
| **Provider-local MEMORY / primer** | provider/harness convention | runtime-local edit/compile | provider owner；repo 内无完整 current census | prompt injection/read；当前 source/失效坐标未闭环 | ⚪ `unknown`：在纳入统一只读 closure catalog 前不得声称健康 |
| **Global distillation / F152** | 已索引 evidence 被标 generalizable；生产样本为零 | `distillation_candidates` nominate | 独立 approve + `~/.cat-cafe/distilled-truths/` | consumer 未证明 | 🔴 `sunset_candidate`，与项目 LL 分开裁决 |

这里的目标不是让 ADR、Skill、Diary 都经过同一张 Hub 卡，而是让每个 surface 明说：为什么现在可以
写、候选是什么、谁有权签字、写完谁会用。`exempt` 只免某一种审批，不免 provenance、canonical
owner、correction/forget 与 consumption 声明。

## 3. Lessons Learned 深查：读取强、出生法分叉

### 3.1 当前三条出生/提升路径

```text
feature / correction / self-evolution
  ├─ direct Edit → docs/public-lessons.md ───────────┐
  ├─ F102 candidate → MarkerQueue YAML → docs/lessons/ ├─ scanner/search/F287
  └─ indexed lesson → F152 SQLite → global distilled ─┘
```

三路不是同一个 authority：

1. `docs/public-lessons.md` 是 scanner 特判的 authoritative LL passages，通常由猫直接编辑、commit；
2. F102 从 summary 抽 `decision|lesson|method` candidate，当前会把 `method` 归入 `lesson`，显式
   candidate 可 auto-approve，并由 `MaterializationService` 写到 `docs/lessons/`；
3. F152 从已索引、被标 generalizable 的 lesson/decision 再提名，使用独立 SQLite，并物化到
   `~/.cat-cafe/distilled-truths/`。

Approval Hub 的 producer catalog 当前不含 F102、F152 或 Lesson。读侧又把 `docs/lessons/`、
`project-reflections/`、`methods/`、`episodes/`、`postmortems/`、`stories/`、`harness-feedback/` 等多种对象
折叠成 kind=`lesson`。因此最大 bug 不是“LL 没被索引”，而是：**读侧给予 lesson-like authority，
写侧却没有唯一的规范性提升法；对象类型与裁决权被一个 scanner kind 压平。**

### 3.2 2026-08-26 文件 snapshot（只用于定位，不是 current truth owner）

| Surface | Snapshot |
|---|---:|
| `docs/public-lessons.md` 的 `### LL-*` | 100 |
| `docs/lessons-learned/*.md` | 11 |
| `docs/lessons/*.md` | 33 |
| `docs/decisions/*.md` | 53 |
| `docs/methods/*.md` | 2 |
| `project-reflections/*.md` | 125 |
| `docs/harness-feedback/**/*.{md,yaml,json}` | 1103 |

数量只说明 surface 真实存在且规模不小，不能决定哪一条更真，也不能从“被命中很多”推出
“应提升为全家规范”。

### 3.3 目标不变量（不在 census 偷定实现）

- failure/event 可先以 source-backed Episode 留证；提升成全家行为规则时，必须生成独立 normative
  candidate，并由声明过的 authority 裁决；
- LL、Decision、Method 可继续拥有不同 canonical store，但同一 claim family 不能有两个 active
  normative owner；
- direct edit 不是被禁止，而是必须由 closure declaration 说明 author/reviewer/guard 为何足够；
- F102/F152 若保留，必须成为上述 authority 的 adapter，不能继续各自产生 lesson-like canonical；
- scanner kind 只负责发现与读取，不授予 truth authority；来源对象、revision 与 promotion lineage
  必须可 drill；
- 先补确定性协议与 guard，再让 utility eval 比较污染、审批负担和采用；不以 eval 代替出生法。

## 4. Shared invariants（Standing Reflex v1.1 输入）

1. **四拍 completeness**：感知、提案、裁决、消费均须有明确答案；`none/exempt/sunset` 合法，
   `missing` 不合法；
2. **车道活性三因子**：触发存在 × 校验有效 × 消费闭环；reader 存在不等于被使用；
3. **统一协议，不统一 authority/store**：每条 lane 保留自己的 canonical truth owner；
4. **speaker/provenance 机械校验**：owner 语录类 proposal 必须服务端核 author/source；
5. **规范性 promotion 与证据留存分层**：Episode 可以先留证，LL/Decision 提升需独立裁决；
6. **写入验收 = canonical 可读 + 可纠正/遗忘**，不是文件存在或落库；
7. **typed disposition**：主动 opportunity 必须 `propose|defer|abstain`；沉默不是合法第四态；
8. **zero = no-data**：零条不代表零发生/零伤害；
9. **scanner/index/view 不夺权**：发现、排名、被频繁消费都不能提升 truth authority。

## 5. 下一步边界

- 先为上述 surface 逐条生成 lane-owned `MemoryWriteSurfaceClosureV1` 声明；这不是中央可写 registry；
- LL/Decision/Method 先做 claim-family/authority map，再决定 F102/F152 的 migrate/adapter/sunset；
- Person 首案 replay 只验证已冻结的确定性合同；它不产出 utility verdict，也不替代真实 runtime
  episode；
- Taste/Profile 下一案先过四拍 E0：有 consumer、有可裁决失败路径、有足够 observation；不为七格整齐
  自动施工；
- Provider-local MEMORY/primer 仍是本 census 的 honest unknown，需 owner 坐标后再冻结。

---
*W0-C v0.3 · 原始七 lane census Ragdoll/claude-fable-5；Wave 1/v0.3 current-truth correction 与 universe expansion 小太阳·Maine Coon/gpt-5.6-sol · 2026-08-26*
