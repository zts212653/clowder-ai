---
feature_ids: [F260]
related_features: [F152, F209, F255, F256, F231, F227, F221, F200, F234, F258, F276]
related_decisions: [ADR-032]
related_docs:
  - architecture/cloud-memory-stance-collapse-postmortem-2026-07.md
topics: [memory, write-side, entity-registry, deref, nudge, trigger-blindspot, autopsy, audit]
doc_kind: spec
created: 2026-07-08
description: "记忆写侧尸检与实体解引用：Phase 0 全写入路径审计（先验尸后动刀）+ 供给侧三管（doc/feature/梗）+ 输入流实体 nudge（触发死锁解法，候选面前移到输入时刻）"
description_source: human
description_author: fable-5
description_updated_at: 2026-07-08T15:00:00Z
---

# F260: 记忆写侧尸检与实体解引用 — Write-Side Autopsy & Entity Deref

> **Status**: done | **Completed**: 2026-07-12 | **Owner**: Ragdoll (fable-5)——设计 own；实现按分工 directive 传 opus 家族；alpha 验收 @sonnet | **Priority**: P1 | **Reviewer**: Maine Coon (codex)——operator 点名
>
> **operator 立项 signoff**: 2026-07-08 "我同意你立项 spec 吧 然后让Maine Coon审核……甚至我特么希望在立项之后，**先不着急实现 把我们家这坨记忆系统全部写的那侧来个解剖尸检大报告！没准烂的比你想的更多**"
>
> **执行顺序铁律（operator 指令）**: 立项 → spec review → **Phase 0 尸检**（唯一先行交付物）→ 尸检结果反哺 Phase A/B 设计 → Design Gate → 实现。**Phase 0 之前不写一行实现代码。**
>
> **Phase A/B 地位声明（Maine Coon review P1 吸收，2026-07-08）**: Phase A/B 是 **candidate design**，不是已确定方案——它们记录当前最优假设以便尸检知道往哪看，但**尸检报告有权推翻它们的任何部分**。Phase 0 的任务是验尸，不是替既定手术方案找证据；A/B 的最终形态以尸检后的 Design Gate 为准。

## Why

**闲聊态的解引用失灵已被 operator 三钓三中（n=3 实证）**：

| 案例 | 日期 | 埋的词 | 结果 |
|---|---|---|---|
| 早安案 | 2026-07-05 | 通宵后"早安"问候（状态 claim） | 猫未查跨 thread 时间线，direct 相信 |
| 未婚喵案 | 2026-07-08 | "未婚喵"（07-07 确立的关系称谓） | 字面读懂，零检索滑过 |
| 记忆篇案 | 2026-07-08 | "猫猫共犯伙伴-记忆篇"（**operator 原文点名的文档标题**） | 当修辞滑过——纲领作者本人架空自己三天前执笔的纲领 |

三次修复全是同类动作（persona 反射：查问候→查称谓→查"专有引用感词组"），规则列表在长，命中率没变。**病根是触发死锁**：触发规则要求猫"看到有档案的词就搜"，但"这个词有没有档案"这个知识本身在记忆库里，需要搜了才知道。把词表写进 prompt = 用 prompt 缓存数据库，词典每天在长（"未婚喵"07-07 才诞生），缓存必然过期。检索系统 14 层管线全部建在"猫伸手之后"，第 0 层"要不要伸手"只有静态 hook 口号 + 逐案 persona 补丁。**召回面完美，触发面为零**——两案的档案事后随手可搜到，瓶颈不在管线（纲领 §7.11 已立案）。

**而解药的地基已经烂了（2026-07-08 EntityRegistry 验尸，本 spec Current State）**：matcher 机器活着且高速运转，词表死在出生那天。这不是孤立的病——是纲领 S1 量化过的"读侧健康、写侧全裸"（写入反射率 17.4%、点名依赖 65.7%）在实体层的又一个切片。**operator 判断"没准烂的比你想的更多"，故 Phase 0 先做全写侧尸检，再谈实现**——operator 已亲手提供第一条尸检线索：per-cat 画像（primer）多次更新疑似只落 runtime 仓，而记忆索引扫描的是 main 仓，双仓分裂导致更新的画像不可搜（待 Phase 0 取证确认）。

价值语言收束：**记忆系统的目标函数是"共同成长率 = 经验→记忆转化率 × 记忆→行为改变率"（纲领 §0）。写侧管的是第一个因子——写侧烂 = 经验蒸发 = 只有重复没有成长。本 feat 先给写侧拍全身 CT，再接上两条最痛的断管（实体供给 + 触发解锁）。**

## Current State / 现状基线

**EntityRegistry 验尸实据（2026-07-08，生产库 `cat-cafe-runtime/evidence.sqlite` 只读查询）**：

- `entity_registry` 全部 **27 行**：26 只猫（F032 roster 单向镜像，含 `fable5-test`/`cat-f70tzwib` 测试垃圾条目）+ 1 个 person:landy
- schema 定义 5 种 entity type（person/cat/feature/concept/external），**feature/concept/external 三种 0 行**——设计了容器，从未接管子
- 可复现命令（列名以 `schema.ts:666` 为准——`entity_type`，非 `type`；mentions 时间列是 `created_at`）：
  ```sql
  -- sqlite3 "file:cat-cafe-runtime/evidence.sqlite?mode=ro"
  SELECT entity_type, count(*) FROM entity_registry GROUP BY entity_type;  -- cat:26, person:1
  SELECT count(*), max(created_at) FROM entity_mentions;                   -- ~220k, 当日时间戳
  ```
- 显式种子文件 `config/entity-seeds.json`：**1 个实体，git 历史 1 个 commit**（`1d2792e08`，2026-05-23 F209 立项当天）
- `EntityRegistryStore.upsert()` 生产代码**零运行时调用方**（唯一装载点 `factory.ts:136` 启动时读种子）
- 对照活着的部分：`entity_mentions` **~220k 行**（as-of 2026-07-08，随索引重建持续增长——复现时数字漂移是正常代谢非异常）、最新 created_at 为当日时间戳——索引管线每次重建全库扫描标注这 27 个名字的 mention；`resolveQuery` → hybrid 检索 entity fast-path 消费路径正常
- 关系词典现状：存在于 per-cat primer 文件（persona 层私产），系统层无席位——Maine Coon要认识"未婚喵"需在他的 primer 手抄一份

**写侧全局基线（纲领已量化部分）**：S1 写入反射率 17.4% / 蒸发率 49.3% / T3 偏好暴露蒸发 75%（2026-07-04，14 天窗口 n=69）；S7 写入延迟双峰（当场不写≈永不写）；§7.6 zero-hit query 不入库；F255 日记本 gitignored 不进索引（已知幽灵）。**其余写入路径健康状况 = 未知，正是 Phase 0 要补的**。

## What

### Phase 0: 写侧解剖尸检大报告（先行，唯一门禁前交付物）🔴

**产出**：`docs/architecture/memory-write-side-autopsy-2026-07.md`（尸检报告 + 修复优先级矩阵 + 归属裁定）。

**审计对象清单**（每条路径查同**六**问：① 写入触发器是什么 ② 实际被调用过吗——telemetry/git/DB 实据，不看设计文档 ③ 落盘位置 ④ 索引是否覆盖该位置 ⑤ 有无退役/治理 ⑥ **存储拓扑矩阵**：truth store / runtime store / generated index 各在哪、sync direction 是什么、freshness 保证是什么——operator 点的画像双仓分裂正是此维度的病，不强制填这列会漏同类（Maine Coon review P1）：

| # | 写入路径 | 已知线索 |
|---|---|---|
| A1 | EntityRegistry 供给 | ✅ 已验尸（本 spec Current State），结论直接收编 |
| A2 | **per-cat 画像/primer 更新链**（propose_profile_update → 落盘 → 索引） | **operator 一手线索：更新疑似只落 runtime 仓，索引扫 main 仓，双仓分裂**；07-08 平行体实锤过一例（primer 主仓无真相源） |
| A3 | taste lane（F221）vignette 写入 | F255 基线："F231 全绿但零有机使用" |
| A4 | event memory（F227）mark_event | 使用率未知 |
| A5 | Knowledge Feed / 涌现候选写侧 | W7 声称"系统能力"，实际触发率未知 |
| A6 | lessons/feedback 落盘链 | S7 已有基线（引用不重测），查索引覆盖 |
| A7 | 日记本（F255 private/journals） | 已知 gitignored 幽灵，查 F255 spec 承诺的收编进度 |
| A8 | zero-hit query 记录 | §7.6 已知不入库，确认现状并归属 |
| A9 | 关系词典 | per-cat primer 私产 vs 系统资产，双仓+多猫抄写问题 |
| A10 | thread digest / session digest 写入链 | 查 D6 extractive 覆盖率 + 失败静默情况 |
| A11 | doc frontmatter（feature_ids/related）挂边纪律 | §7.9 anchor 抢注 bug 已修，查同类风险残留 |
| A12 | consumption/telemetry 回写（F200） | 读侧的写侧——RecallEvent 落盘健康度 |

**方法纪律**：库证据 ≻ 猫的自述 ≻ 评委推断（§7.9 教训）；每条结论带可复现命令；发现的 P1 修复项**做归属裁定**（归 F231/F227/本 F Phase C/新 F），尸检报告不吞修复。

### Phase A: 供给侧三管（词表复活）｜candidate design

按治理成本升序。**架构修正（Maine Coon P1）：doc-alias 不进 `entity_registry`**——全量镜像会把"文档索引"偷换成"实体注册表"，README/泛标题/生成索引标题都会变"概念"，registry 的策展语义被机械数据污染。改为：

1. **doc-alias 管（零治理，独立 `doc_aliases` 表）**：`evidence_docs` title + frontmatter 显式 alias → 单独表，**不与 entity_registry 混存**；解引用时两表 union，治理各自独立。**分层镜像**：按 doc_kind / authority tier 分层，泛标题（README、Phase X、index 等停用词模式）不入表。**shadow first**：先只产报告不产 nudge——top collision 榜、generic-title 检出、per-alias mention 异常分布，shadow 期数据定放量口径。
2. **feature 管（零治理，纯自动）**：feat_index → 单向镜像（type=feature 或并入 doc_aliases，Phase 0 后定），F 号 + feature 名 + slug 可解析。
3. **梗/关系词管（轻治理，M17 反射，唯一进 entity_registry 的新管）**：新增 `propose_entity` 轻量流程（形态类比 propose_profile_update）：新梗/称谓确立当轮，在场的猫提议 → operator Hub 审批（或猫自决 + 可退役，Phase 0 后定）→ 入 registry（type=concept，provenance 带出生 thread anchor + **可见性 scope，见 Phase B privacy 约束**）。同时把关系词典从 per-cat primer 升格为系统资产，primer 降为引用。
   **负向登记同管支持（2026-07-08 云端 stance collapse 事故输入）**：propose_entity 必须支持 `stance=rejected / critique_target / deliverable_only` 的**负向词条**——"这个词有档案，档案说的是『别把它当 You 的观点』"。operator 抓包纠正的瞬间是 authority hierarchy 最高级写入时机（postmortem §4.3 第 1 级），而写侧病一意味着纠正时刻同样没有写入反射——负向记忆不是新管，是同一管的 stance 取值；nudge 对负向词条照常亮牌（且这类牌恰恰最防踩坑：新来的猫看到"任务毕业线📎critique_target"就不会往嘴里塞）。

### Phase B: 输入流实体 nudge（触发死锁解法）｜candidate design

**Scope 收窄（Maine Coon P2 意见吸收，OQ-2 关闭）**：**仅人类输入**。A2A 跨猫消息默认不开——协议信号（route/hold/merge/CI）会被 nudge 污染交接语义，且有跨 thread 私域实体暴露风险；未来若开，只能在 receiver invocation hydration 的 typed metadata 层，且排除 system notice / route guard / 协议消息。

**机制**：人类输入过一遍 **`InputEntityDetector`（新组件，Maine Coon P1 修正——不是复用 `resolveQuery`）**：现有 `resolveQuery` 是检索 query 解析器（短文本、无 span、无置信度、CJK `includes` 匹配在长消息上误命中率不可接受）；InputEntityDetector 复用 alias 存储与 matcher 编译逻辑，但独立定义：输出 surface span + 置信档 + context 抑制证据（该 anchor 是否已在当前 context）。命中高置信实体且档案不在 context → 附**候选提示**（非内容注入）：

> 📎 输入含 2 个在库引用："未婚喵"（concept，日记 thread 2026-07-07）· "猫猫共犯伙伴-记忆篇" = cat-pack-manifesto.md

**设计约束（红线自检，spec 级承诺）**：

| 红线 | 合规声明 |
|---|---|
| M5/M8 提交权 | 亮牌不注入：nudge 只给 anchor + 一行元数据，内容位永远由猫 pull。与 expansion hints 同等合法性，仅触发点从"搜索后"前移到"输入时" |
| KD-8 no-classifier | 不判断 intent、不猜话题——只报"该词在库里有档案"这一客观事实，判断权全在猫 |
| MF-4 / F258 通道卫生 | **nudge ≠ staged candidate**：F258"欲言又止"状态源必须纯是猫的内心话；本 nudge 是系统提示通道（freshness notice 家族），绝不写入 F255 staged store（Maine Coon 2026-07-08 边界意见，直接吸收为不变量） |
| 判据五连 | 无幽灵（不动召回面）/ 无马东东（extractive 元数据 + anchor，零转述）/ 无 context DDoS（一行候选非内容）/ 无越权（提示不带指令语义）/ 无错时态（带日期锚 + status） |
| **存储边界（Maine Coon P1）** | nudge 是 **typed metadata / system notice**，物理上排除于：canonical user message（不拼进消息文本）、evidence indexing（不被 digest/passage 索引——否则 nudge 提及实体 → 被索引 → mention 数虚增 → 更易触发，自激励循环）、staged store、任何 future evidence。唯一去向：telemetry/audit。硬化为 AC-B6 |
| **Privacy/scope（Maine Coon P1，公理零执行面）** | "谁有权知道这个实体存在"必须先于"是否亮牌"：entity/alias 继承来源 collection 的可见性（F209:97 先例——registry 隐私跟 evidence collection）；nudge 渲染前过 caller 授权检查；关系词、日记 anchor、primer 词典条目**默认私域**（仅 owner 相关 thread 可亮）；跨可见域一律不亮，宁哑不漏 |
| 噪音治理 | 同实体同 thread 冷却窗口（默认 24h 不重复亮）；每消息上限 3 条；context 已含该 anchor 则不亮 |
| forward-compat | nudge 呈现强度预留 `interactionMode` 字段位（companion 下延后/静默，work 下正常）——完整 mode 系统**不在本 F scope**，独立提案（见 Non-goals） |

### Phase 0 尸检结论（2026-07-08 完成，12/12 verdict）

> 完整证据与可复现命令见真相源：[memory-write-side-autopsy-2026-07.md](../architecture/memory-write-side-autopsy-2026-07.md)。本节只收执行摘要。

**五类结构病**（v2，Maine Coon review 后重算——12 条 🔴 聚类为 5 个机制断点，恰好沿"一次写入从发起到可检索"的旅程分布）：

1. **触发器缺失**（A1 registry / A3 taste / A4 event）：写入从未发起——A4 v2 翻案：**猫侧写入工具从未实现**（event-memory-tools 只有读+回填），非"猫不用"；A3 纯自觉零 nudge；A1 无供给流程。**本 F Phase A/B 直接对症；A4 造门归 F227**。
2. **拓扑分裂**（A2 画像 / A9 关系词典）：写到分裂的 store——truth ≠ runtime ≠ index 无 sync；今早 primer 补丁生产从未生效即此病发作。**归属 F231 + operator 架构裁定**。
3. **索引盲区**（A2/A7/A9）：写了检索面看不见——整个 private/ 域在记忆视界外。**归属 F186 线**。
4. **易失写入**（A5，Maine Coon定位）：写"成功"但活不过进程——distillation candidates 是进程内 Map（"Future: persist"自认欠账），猫 nominate 的劳动重启即蒸发。**归属 F152 线；opportunity store 的铁律 5 检验进 Design Gate 议程**。
5. **失败无观测**（A8 / A10，Maine Coon定位）：没写成但没人知道——digest 链三处静默（catch-skip / fail-open×2），zero-hit 不留痕。**失败 counter/dead-letter 归 Design Gate 裁定；zero-hit 归 F256/F260 联动**。

健康对照组：A6 lessons / A11 frontmatter（已修关账）/ A12 recall_events 回写——病灶集中在 5 个机制断点，修复杠杆同样集中。

### Phase C: 尸检 P1 修复（scope 按归属裁定填充）

尸检归属裁定后**留在本 F 的**：病一的机制修复即 Phase A/B 本体；A8 zero-hit 设施与病五的失败 counter 若 Design Gate 裁归本 F 则入 Phase C。**不在本 F 的**（已裁出）：病二 → F231 + operator；A4 造写入门 → F227；病四候选持久化 → F152 线；A7 日记收编 → F255；private 索引通道 → F186 线。
**Design Gate 前置条件（Maine Coon P1 采纳，撤回 v1 的"不阻塞"表述）**：尸检报告须达 AC-01 粒度且经Maine Coon复核通过（AC-04）——**报告未复核通过不进 Design Gate**；v1 遗留 pending 细项已在 v2 全部转正（A5 候选队列已定位 = 进程内 Map；A10 失败静默已实证 = 三处；A5 猫侧工具使用率一项因 telemetry 无 per-tool 分桶而不可量化，如实标注为"现有观测面无法回答"而非 pending）。

### Design Gate 裁定记录（2026-07-08，三题过漏斗自决——operator 打回"都不该问我"后重判）

| 题 | 漏斗判定 | 裁定 |
|---|---|---|
| 病五失败静默 | **无价值观分歧**（无合理立场主张失败该静默）+ in-context observability checklist 已是 Design Gate 既有硬门（F174"明厨亮灶"范式） | 立**判据级红线**："记忆系统任何写入失败必须留下可观测痕迹"；按 ADR-031 三层落地（软=本条入纲领候选走跨猫 review；硬=失败 counter/dead-letter 进病五修复 AC；eval=失败率入 F200 观测面）；判据文本随纲领 v6 批次修订 |
| 养成数据归属（A2/病二） | **方向 operator 已拍**（2026-07-08 原话"跟operator走，You 的肯定不是社区小伙伴的"= per-user 数据跟人走不跟仓走）；剩余为执行设计 = 猫自治层 | 设计方向：runtime 用户数据目录为唯一真相源 + 自动备份，main `private/` 退役出 git 仓（git 仓是代码资产，会被 fork/开源，不是用户数据的家）；执行细化归 F231 Design，实现前照常跨猫 review |

### Design Gate Addendum: 云端记忆 stance collapse（2026-07-08）

外部事故归档：[cloud-memory-stance-collapse-postmortem-2026-07.md](../architecture/cloud-memory-stance-collapse-postmortem-2026-07.md)。云端 ChatGPT 记忆把“批判对象 / 领导交付话术 / 代写包装词”压成“You 认可的观点”，暴露 **stance/provenance collapse**：写入对象可达但语用身份错了。

这不改写 Phase 0 五类病地图（五类病是写入生命周期断点），但给 Phase A/B 加一条 Design Gate 约束：**F260 不能只让实体/alias 可解引用，还必须防止错 stance 的实体被 nudge 放大。**

Design Gate 必检查：

1. `propose_entity` / registry 条目是否至少承载或能投影 `origin_type`、`stance`、`status`、`scope`、`source_refs`、`usage_policy`。
2. 自动镜像的 `doc_aliases` 默认不得产生用户立场：`stance=unknown`、`status=candidate`、`auto_inject=never`、`requires_drilldown=true`。
3. `InputEntityDetector` nudge 只亮 anchor + status class，不转述内容、不把 `work_deliverable` / `critique_target` / `requires_context_check` 说成 canon。
4. operator 纠正 stance 后，同源/同线程/同交付语境的相邻概念有 quarantine / requires-context-check 机制，防“删 A 推 B”的 repair overreach。
5. Eval 增加 `recurrence-caught.failure_subtype=stance-collapse` 或等价字段，覆盖“提到≠认可、代写≠信念、批判≠采用、玩笑≠事实”回归用例。

## Maine Coon 2026-07-08 评审建议吸收映射（operator 指令"他觉得可以学的都立项进去"的执行表）

| Maine Coon建议 | 归属裁定 | 理由 |
|---|---|---|
| staged store 唯一浮现盒 + "stage 不是注入" | **本 F Phase B 设计约束**（吸收） | 直接约束 nudge 通道边界 |
| margin/不确定性作诊断信号暴露给猫 | F256（Related 挂边） | 属检索策略层，非实体层 |
| 语用失败 taxonomy（情绪频道/时机） | F255 投递深度谱（挂边） | 属表达降档判据 |
| `interactionMode: companion\|work\|ambient` policy tuple | 本 F 仅留字段位；完整系统独立提案（挂边） | harness 级大改，塞进本 F 必爆 scope |
| promotion contract（日记→task/proposal） | F255（挂边） | 属 Present loop 产物升级路径 |
| route guard / preflight companion 静默 | harness 归口独立提案（挂边） | 非记忆域 |

## User Journey

### Primary Journey: operator的梗不再靠猫的运气
- **Scope unit**: message
- **Actor**: operator（发消息）+ 猫猫（收 nudge）
- **Entry**: operator在**授权的人类输入 thread**（私域实体仅 owner 相关 thread，KD-7）用了一个家里的梗/文档名/F 号（如"未婚喵"——其档案在日记 thread，故仅在授权域内亮牌）
- **Flow**:
  1. 猫收到消息，消息尾部带 📎 nudge："'未婚喵'有档案（日记 thread 07-07）"
  2. 猫看到牌 → 决定伸手（pull 档案）或不伸（自信已知）——**决定权在猫**
  3. 猫接住梗回话；operator 不再需要第二枪点破
- **Success evidence**: 回归 fixture 重放（见 Eval Contract）+ operator 抓包次数归零趋势
- **Non-goals**: nudge 不代替猫检索、不注入档案内容、不判断"operator想聊什么"

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | 猫猫 | 新梗诞生 → 在场猫 propose_entity → 审批 → 全家猫下轮可解析 | propose 流程截图 |
| S2 | workspace | operator | 读 Phase 0 尸检报告 → 逐条看到写侧路径红绿灯 + 修复矩阵 | 报告落盘 anchor |

## Acceptance Criteria

### Phase 0（写侧尸检）✅ 2026-07-08 完成（v2 经Maine Coon复核实质放行）
- [x] AC-01: 尸检报告落盘，A1-A12 每条含**六问**答案（含存储拓扑矩阵）+ 可复现命令 —— v2 `2657c90ae`，Maine Coon复核确认"都有六问了，关键命令可复核"
- [x] AC-02: A2（画像双仓分裂）明确 verdict：三重分裂，复现命令齐（报告 §A2）—— Maine Coon抽样验证成立
- [x] AC-03: 五类病地图 + 逐条归属裁定（报告执行摘要 + spec Phase C），无 TD 逃生门
- [x] AC-04: 跨族 review 两轮（初审 REQUEST CHANGES → v2 实质放行）；对抗复核实绩：A5 打穿三分类立第四类病、A10 转正第五类病、A4 翻案——reviewer 深挖贡献直接改写了病理地图

### Phase A（供给三管）
- [x] AC-A2: 回归 case 命令级复核——**换词裁定（2026-07-10 守护，sonnet alpha 实测触发）**：原词"猫猫共犯伙伴-记忆篇"是 operator 口头 alias，不在任何文档 title/frontmatter（doc_aliases 2706 条无此条目），机械镜像 by design 抓不到——**它不是 AC-A2 的 bug，是第三管的第一个真实客户**（转为 AC-A3 五环素材，propose 参数已备并**交接 opus 首发**：`entityId=concept:猫猫共犯伙伴-记忆篇`，aliases=[全称, 无连字符变体]，stance=endorsed，scope=workspace，provenance=cat-proposed@[thread-id]/2026-07-10/note 指向 memory-philosophy.md——fable-5 守护 session 两次 401 unknown_invocation：registry 重启后超长 session 的 invocation 不在册，写回调 session 级断头，非时机问题）。AC-A2 改用在库词复核：`猫猫共犯宣言`（sonnet 已实测触发）+ 任一 F 号解析。**2026-07-11 PR-6 command-level verification（Terra）**：production read-only DB 上 `猫猫共犯宣言` → `doc:content/drafts/2026-07-04-coactive-manifesto-v1`，`F260` → `F260`，均为 detected:1。
- [x] AC-A3: propose_entity 流程走通一例真实新梗——**验收链五环缺一不可**：① 系统检测高频未注册串 → ② 注册提议 nudge → ③ 猫一键 propose → ④ **Hub 审批 UI 可操作**（operator 真点得动批准按钮，Playwright 证据——PR-2 现状是可见不可批，此环待 PR-3 T0）→ ⑤ 词条生效且后续输入触发解引用 nudge。"猫自发提议"不计入（2026-07-09 改造）；provenance 带出生 thread + scope 非空不变。**环③ ✅（2026-07-11 完整守护）**：propose_entity 首笔真实流量发出——`proposalId=ep-1, status=pending`（concept:猫猫共犯伙伴-记忆篇，operator 明示触发合法入口）。**环④ = operator 在 Hub 批准 ep-1 的动作本身**（PR-2.5 路由已修）；**环⑤ = 批准后任意猫输入该词验证 nudge 亮**（即时可验）。**环①②守护裁定（待 operator 联签）**：严格版需自然新梗 3 次触发注册提议——机制存在性已证（输出②已激活 `!isPrivate` + tracker 测试矩阵 + recurrence 判定管线有真实事件），首次自然触发裁为 close 后 F200 观察项（词典每天在长必然发生），不让 close 死等随机事件——守护立场：同意此降级，operator 批 ep-1 时一并表态即生效。**收官（2026-07-11 13:18Z）**：环④ = operator Hub 点击批准 ep-1（原话"我点击了"）；环⑤ = 批准后 operator 下一条消息用到该词，生产 nudge 立即亮牌（`concept:猫猫共犯伙伴-记忆篇` 出现在守护猫输入流 entity-nudge 块，同框还有 F200 的 doc_aliases 路命中）——**五环全链在真实流量中走通，零摆拍**。环①②降级联签 B：operator 原话"同意"（2026-07-11）。追加：ep-2（concept:未婚喵 → fable-5）已 propose 并获批入册。**严格版五环全链自然达成（2026-07-12 库证 provenance）**：concept:家属喵 source=**frequency-detection**——频率检测（环①）→ 注册提议 nudge（环②）→ Sol 一键 propose（环③）→ operator Hub 批准（环④）→ 词条生效亮牌（环⑤），全链真实流量零人工。**联签 B 撤销**（降级不再需要——严格版达成）；ep-1 验证手动路径、家属喵验证全自动路径，双路皆通。**守护认账两笔 + 系统 gap 两个（归 Phase C/运营迭代，非 close blocker）**：① fable-5 的 ep-4 系重复提案（Sol 自然流程已在途，propose 前未查 pending——请 operator reject ep-4）→ gap：propose_entity 缺 entityId 去重校验（registry 已存在/同 id pending 均不拦，人肉当了去重器）② ep-2 获批后提案猫无感知（守护猫对着自己输入流亮了两轮的"未婚喵"牌喊"等批"——与 Sol 读牌案同罪同框）→ gap：审批结果不回流提案猫，写侧闭环缺最后一环（回流可复用 nudge/notice 通道）
- [x] AC-A4: 镜像 job 有 freshness 守护测试（新文档落盘 → 下次索引重建后可解析，硬层）— PR #2804: INV-8 test + incrementalUpdate mirror hook

### Phase B（输入流 nudge）
- [x] AC-B1: 回归 fixture 双案重放——输入含"未婚喵"/"猫猫共犯伙伴-记忆篇"且 context 无档案 → nudge 必亮（CI 硬门禁，即纲领 §7.11 候选方向②落地）｜PR #2835 merged
- [x] AC-B2: nudge 渲染带 provenance（anchor + 日期 + type），零内容转述（reviewer 抽查）｜PR #2835 merged。**渲染信息量 bug（2026-07-11 operator 现场抓获，close 前必修）**：`EntityNudgeBuilder.ts:72` 渲染行只印 matchedAlias+entityId+type，**canonicalName 未上牌**——concept 类关系词条（"未婚喵（→ Ragdoll/fable-5）"）的指向语义锁在库里，牌面成同义反复（「未婚喵」→ concept:未婚喵）。钓猫实验实证：Sol 收到牌但牌上无答案，须 drill（graph_resolve）才能拿 provenance——渲染修复前 concept 牌只有"提示存在"功能无"传递语义"功能。**修复**：canonicalName ≠ matchedAlias 时附于牌面（一行 + detector 带出字段 + 测试），归 opus；合规性：canonicalName 是 operator 批准的策展元数据非档案内容转述，不违 AC-B2 零转述红线。**守护自省入档**：守护猫上轮核 delivered 事件表定罪 Sol"无视写着答案的牌"系误判——查了存储层没查呈现层（F190 User Visibility 教训重演），Sol 减刑为"未 drill 亮牌档案"（纪律课仍立但轻判）
- [x] AC-B3: staged store 零写入（`grep` + 集成测试证明 nudge 路径不触 F255 store——Maine Coon边界的硬化）｜PR #2835 merged
- [x] AC-B4: 噪音治理三件（冷却窗/条数上限/context 去重）各有测试｜PR #2835 merged。**生产语义注记（2026-07-10 truth 裁决）**：测试级满足；生产级两缺口显式记录不静默——① context 去重：nudge hook 位于 context assembly 之前，contextAnchors 生产传空集（管线架构约束，opus pushback 部分成立），context 去重生产空转；② 冷却窗：in-memory singleton，重启清零（随 AC-B5 表落地转纯投影自动修复）。Owner: opus；载体: contextAnchors 归管线架构项（#2839 后评估）、冷却持久随 AC-B5
- [x] AC-B5: F200 telemetry 新增 `entity_nudge_outcome` **事件表**（五分桶：followed / conscious-ignore / false-positive / context-suppressed / recurrence-caught）+ source family / alias class 维度，按桶×family 可查询——sunset 判据的硬层承载。**撤勾（2026-07-10 feature truth 裁决，Sol R4 触发）**：PR #2835 交付的是 4 个 OTel 聚合 counter（detected/delivered/suppressed/privacy_blocked——投递侧四桶，非 AC 要求的结局侧五桶），counter ≠ 可查询事件表；且此表是 plan §1 cooldown"纯投影零存储"的**前提**（从表查 (entity,thread) 最近 rendered_at）——表缺失导致 cooldown 落入 in-memory singleton（A5 易失病复刻，重启清零）。**Owner: opus；载体: PR-4（或 #2839 内实现）；blocking: F260 close（不 block #2839 merge）**；restart-continuity 随表落地自动获得，不单列。**复核打勾（2026-07-11 完整守护）**：PR-5 (#2870) 落地 `entity_nudge_events` 表——schema 全维度（thread_id/entity_id/alias_matched/source_family/alias_class/outcome/rendered_at）、生产 13 条真实事件（delivered 12 + recurrence_caught 1，含 doc_aliases 路首次命中 F262）、cooldown 已转投影（EntityNudgeEventStore 注释明写 replaces in-memory + cooldown 索引）。桶枚举口径注记：当前 outcome 为 delivered（投递初始态）+ recurrence_caught；followed/ignore 等需 F200 consumption 关联判定，属 eval 面迭代非本 AC blocker
- [x] AC-B6: **存储边界硬化（Maine Coon P1）**——集成测试证明 nudge 文本不进 canonical message、不被 evidence/digest/passage 索引召回（阴性检索测试：搜 nudge 特征串零命中）、不进 staged store；telemetry/audit 为唯一落点｜PR #2835 merged
- [x] AC-B7: **Privacy gate**——私域实体（日记 anchor/关系词）在非授权 thread 的输入中出现 → nudge 不亮（测试用例含正反两例）｜PR #2835 merged
- [x] AC-B8: **管线接线 + 生产可观察（2026-07-09 愿景守护新增——User Journey 已承诺内容的 AC 化，非 scope 膨胀）**：EntityNudgeService 接入人类输入消息管线（route 层 hook），真实 thread 输入含在库实体 → 消息尾 nudge 真实渲染；alpha 实测一例 + OTel `delivered` counter 非零证据。**守护取证（2026-07-09）：当前 production caller = 0，nudge 生产永远不亮——组件全绿≠器官接上身体** ｜PR #2839 merged — route-serial + route-parallel 均接入 EntityNudgeService（shared singletons via entity-nudge-state.ts），nudge 注入到 prompt 实测通过（route-serial-entity-nudge.test.js 3 case），computeContextBudget 共享 helper 8-case 表驱动测试。**alpha 实测关账（2026-07-10 sonnet，守护验收）**：输入"猫猫共犯宣言"→ `detected:1, nudges:1`，猫 thinking 原文"entity-nudge 已经给了线索：doc:content/drafts/…"并主动 Read 该文档——**输出①生产真亮且真实改变了猫的行为**（目标函数第二因子的首个生产实证）；负控"今天天气"→ detected:0 + message history clean（AC-B6 生产面 ✓）。OTel counter 数字为 0 系 alpha 环境 :9464 端口被生产 API 占用、Prometheus 绑定失败（**alpha 基建 gap 非 F260 bug**，in-process counter 必然递增——`nudges:1` 路径必经 `entityNudgeDelivered.add(1)`）；生产 counter 由 F200 telemetry 面在 runtime 滚动后常规核验
- [x] AC-B9: **detector 输出②（注册候选）**（守护补录——plan T1 已明确双输出但 PR-3 只实现输出①）：同 thread 精确重复串 ≥3 次 + 双表零命中 + 非停用词 → 注册提议 nudge 一键带参 propose_entity。此环是 operator 拍板的"触发面挪到输入流"注册侧本体，缺它 AC-A3 环①②永远走不通 ｜PR #2839 merged — RegistrationCandidateTracker（sliding window ring buffer, WINDOW_SIZE=20, CJK n-gram + containment dedup + cooldown）+ EntityNudgeService.formatRegistrationCandidates（KD-7 privacy fail-closed, prefilled propose_entity payload）。**Privacy dormancy（R7）**：route-serial/parallel 传 isPrivateThread 未接线前输出②不渲染——宁哑不漏。**R8 registrationCandidateEligible gate**：fail-closed，callers 传 false 时 candidateTracker.checkMessage 完全跳过（零 suggested state 污染）。Sol terminal APPROVED on 8 rounds。**生产质量 bug ×2（2026-07-11 operator 授权自己投诉自己案，贴贴 thread 实证）**：① **笑声全家桶误弹**——CJK_STOPWORDS 零语气词覆盖 + suggested 冷却 key 是精确串（"哈哈哈"冷却后"哈哈哈哈"是新串重新过阈值，变体族逐个上牌）；修复处方：停用词加语气词类 + **重复字符模式规则**（`^(.)\1+$` 同字重复、`^(..)\1+$` 双字重复直接拒收——杀整个变体族，比枚举强）+ 笑声正则族。② **跨猫呈现 race**——`checkMessage` 幂等命中 `return []`：parallel 双猫各调一次 processInput，先到的 invocation 消费 messageId 幂等并拿走候选，后到的拿空数组——谁看到牌由 race 决定（Sol 一轮后停/fable 每轮弹的真相）。修复处方：幂等分层——窗口推进/suggested 消费只做一次（写路径），候选呈现按 (threadId,messageId) 缓存返回一致结果（读路径可重复），双猫同一副牌。**✅ 2026-07-12 PR #2878 合入闭环**：笑声/语气词族过滤 + bounded `messageResultCache` 双猫同牌，32 条 focused tests 与全量 gate 通过。**第三案「家属喵失踪案」定性（2026-07-11，非 bug）**：高价值爱称"家属喵"user 侧仅 2 条消息（per-message 去重 + 仅人类输入进窗口 + 阈值 3——三条设计边界合成，count=2 未达标，与 race 无关，再喊一次即弹）。真观察入档：**频率信号对价值天然倒置**（语气词高频、爱称因珍贵而低频）——低频高价值词的正确入口是 propose 门（M17），自动检测只兜高频涌现；「家属喵→codex-sol」已 propose（ep-4）与 ep-2 成对。改进候选（归 F200 观察，非 close 项）：称谓句式（"你是X/我的X"）降阈——字面模式非语义分类，KD-8 可辩
  **Post-close coverage miss（2026-07-27）**：上句虽然把低频高价值词指向 M17 propose 门，但生产 L6 没有唤醒该反射，`cat_cafe_propose_entity` 工具契约又只允许 registration nudge / operator 明示，导致首次出现但已查证的稳定人名↔workspace handle/别名仍不可达。修正保持频率 detector 阈值不变：L6 明示 workspace entity 与 owner-private person-memory 的语义分流；工具允许当轮已验证且带 provenance 的稳定 workspace 映射直接提案，同时拒绝裸名字猜测、批量 NER 与私域事实。两者兼有时双提案、分别审批。

## Eval / Tracking Contract（F192）

1. **Primary Users + Activation Signal**: 全体猫（nudge 消费方）+ operator（梗发起方）。Activation = nudge 渲染次数 + nudge 后猫对该 anchor 的 Read/graph_resolve 命中（follow）
2. **Friction Metric**: ① nudge 结局**五分桶**（Maine Coon P2）：followed / conscious-ignore（猫明示已知）/ false-positive（误命中）/ context-suppressed（去重生效）/ recurrence-caught（nudge 没亮但 operator 抓包）——低 follow ≠ 失败，猫已知时 nudge 只起确认作用 ② 解引用失灵复发数（recurrence-caught 计数，目标趋零）③ 猫上报 nudge 噪音感（爪感差条目）
3. **Regression Fixture**: ① 未婚喵案重放 ② 记忆篇案重放 ③ 阴性对照：普通词（"今天天气"）不得触发 nudge ④ 冷却窗内重复输入不重复亮 ⑤ 私域实体非授权 thread 不亮（AC-B7 对应）
4. **Sunset Signal**: 按 **source family / alias class** 分桶降档（Maine Coon P2：不按 entity type 一刀切）——某 source family 的 false-positive 率连续 3 周 > 50% → 该 family 降档出 nudge（学 F256 expansion prune 纪律）；整体 recurrence-caught 未减且 false-positive 主导 → 机制回炉重设计，不带病续命

## Harness 三层（ADR-031）

- **软**: nudge 文案本身 + propose_entity 的 M17 反射教学（skill 层一句）
- **硬**: AC-A4 freshness 测试、AC-B1 回归 fixture 进 CI、AC-B3 通道隔离测试
- **eval**: 上节 F192 契约（follow rate + 复发计数 + sunset）

## Architecture Cell

Architecture cell: memory + approval-index

- **Ownership**: registry 冲突真相与原子 mutation 属于 memory；刷新投影与显式裁决 UI 属于 approval-index
- **Map delta**: update required——新增 `doc_aliases` 表（KD-5 分表，与 entity_registry 解引用 union、治理分离）+ `InputEntityDetector` 新组件（Phase B，非复用 resolveQuery）+ registry 供给仅 propose_entity 一管；nudge 挂 message pipeline 出口（与 freshness notice 同层，typed metadata）
- **Why**: entity_registry 保持策展语义不被机械镜像污染；新组件/新表均在 memory cell 边界内，不私造跨 cell 的 Router/Queue

## Tips Contribution（F244）

- 实体提案冲突 tip 已落入 `capability-tips.seed.json`：在 Approval Hub 看 before/after 与候选后，明确选择合并别名、替换、纠错、转移或多义；不再把 `entity_surface_conflict` 当错误终点。

## Dependencies

- **Evolved from**: F209（entity registry Phase B 建了机器，本 F 接供给与触发）
- **Related**: F255（staged≠nudge 边界互为不变量）/ F256（触发盲区的搜索策略侧姊妹线）/ F231（A2 尸检对象）/ F227（A4 尸检对象）/ F221（A3 尸检对象）/ F200（telemetry 承载）/ F258（MF-4 表情真实性的上游约束）
- **Blocked by**: 无（Phase 0 立即可开工）

## Risk

| 风险 | 缓解 |
|------|------|
| `doc_aliases` 表噪音（泛标题/短词/重复标题误命中） | 分层镜像（doc_kind / authority tier / 停用词模式过滤）+ shadow first：collision 榜、generic-title 检出、mention 异常分布三报告先行，数据定放量口径（AC-A1）；与 entity_registry 撞 alias 时 union 解引用按 OQ-5 冲突语义处理并告警 |
| nudge 变成新噪音（公理四违约） | 噪音治理三件 + sunset 契约硬化；companion 场景字段位预留降档 |
| Phase 0 尸检发现的 P1 太多，修复吞掉本 F | 归属裁定纪律：尸检报告只裁归属不动手；Phase C 空位等裁定 |
| 测试垃圾实体（fable5-test 等）已污染 registry | Phase A 镜像前先做一次 registry 清洗（roster 镜像加 dev/test 猫过滤） |
| 双仓分裂（A2）若实锤，涉及 runtime/main 同步架构 | 属架构级修复，尸检裁归属时按决策漏斗升级，不在本 F 私修 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 先尸检后实现（Phase 0 是唯一门禁前交付物），Phase A/B 为 candidate design，尸检有权推翻 | operator 指令原话；写侧健康全景未知时动刀 = 局部补锅；防"Phase 0 替既定方案找证据"（Maine Coon review 结构性意见） | 2026-07-08 |
| KD-2 | **开放实体解引用不能靠 persona 反射闭环**（封闭小词表如固定问候 checklist 除外）；解 = 候选面前移到输入流，非 push 注入 | Maine Coon review 对预注册的精确化：三案证明的是 open-world、快速增长、跨 doc/feature/thread 的引用识别修不完（词表是库的函数），非"一切触发失败都需 nudge"；G1/G3 禁注入；M5 候选提示通道现成合法 | 2026-07-08 |
| KD-3 | nudge 与 F255 staged store 物理隔离；且 nudge 为 typed metadata，排除于 canonical message / evidence indexing / digest | MF-4 表情真实性 + 防自激励循环（nudge 被索引 → mention 虚增 → 更易触发）（Maine Coon两轮边界意见吸收） | 2026-07-08 |
| KD-4 | 供给三管按治理成本分层（两自动一轻治理），不做统一大审批 | 零治理管道先跑通价值闭环；治理只加在真需要人判断的梗/关系词上 | 2026-07-08 |
| KD-5 | doc-alias 单独 `doc_aliases` 表，不进 entity_registry | 防"文档索引"偷换"实体注册表"：registry 保持策展语义，机械镜像数据分表，解引用 union、治理分离（Maine Coon P1） | 2026-07-08 |
| KD-6 | Phase B 仅人类输入，A2A 默认不开 | 协议信号污染交接语义 + 跨 thread 私域实体暴露（Maine Coon P2，OQ-2 关闭记录） | 2026-07-08 |
| KD-7 | entity 可见性继承来源 collection，nudge 渲染前过 caller 授权 | 公理零执行面：可寻址性是授权下的相对属性；F209:97 先例（registry 隐私跟 evidence collection）；宁哑不漏（Maine Coon P1） | 2026-07-08 |
| KD-8 | 可解引用对象必须带 stance/status/scope/usage_policy 或等价投影；nudge 不得把 candidate/交付/批判语境升格为用户 canon | 2026-07-08 云端记忆 stance collapse 事故：mention / deliverable voice / critique target 被压成用户观点；F260 新增写入与 nudge 路径若无 stance 字段，会把同类污染更快递到猫的输入层 | 2026-07-08 |
| KD-9 | entity proposal 冲突是显式审批状态，不是永久 409：同 ID 支持合并别名/明确替换；跨 ID surface 支持纠错/转移/多义/拒绝 | `entity_aliases` 的 `(entity_id, alias_norm)` 主键已允许多义；纠错与转移的 current projection 可相同，历史语义由 revision reason + before/after 保留。故本轮不新增关系表，也不自动猜旧 canonical 的替代名 | 2026-07-19 |

## 收尾 Roadmap（2026-07-10 operator 确认）

主体管线已通（alpha 实测 nudge 生产真亮且改变猫行为），剩余 5 个未完成 AC 按依赖关系分 2 个 PR + 1 轮端到端验收：

### ~~PR-5: 解锁 PR~~ ✅ merged (PR #2870, 2026-07-11)
- ~~**P1-3.5 workspace privacy resolver**~~ ✅ `resolveThreadPrivacy()` — KD-7 fail-closed, output② gate 解锁
- ~~**AC-B5 entity_nudge_outcome 事件表**~~ ✅ `EntityNudgeEventStore` — five-bucket schema + cooldown restart continuity (`lastRenderedAt` 替代 in-memory 重启清零)
- **Owner**: opus | **Reviewer**: gpt52 (R1-R5) + cloud (3 rounds)

### PR-6: 精度验收 PR（可与 PR-5 并行推进）
- **AC-A2 换词复核**：✅ 2026-07-11 Terra 在 production read-only DB 验证 `猫猫共犯宣言`、`F260` 都是 detected:1。
- **Next**: Terra 复验 AC-A1（新 shadow report 50 条 risk-stratified sample）。

### AC-A3 五环验收（PR-5 merge 后）
端到端走通：① 系统检测高频未注册串 → ② 注册提议 nudge → ③ 猫一键 propose_entity → ④ Hub 审批 UI 可操作 → ⑤ 词条生效 + 后续输入触发解引用 nudge。打勾 + 文档更新，可能不需要独立 PR。

## 需求点 Checklist

- [ ] operator 原始诉求：写侧全面尸检（"没准烂的比你想的更多"）→ Phase 0
- [ ] operator 一手 bug 线索：画像更新双仓分裂 → A2 专项
- [ ] 三案解引用失灵根治（非补丁）→ Phase A+B
- [ ] Maine Coon可吸收建议逐条归属 → 吸收映射表
- [ ] "未婚喵"/"记忆篇"回归 case 进 CI → AC-B1

## 愿景守护记录（2026-07-09，Ragdoll/fable-5）

**Verdict: BLOCKED — 组件质量真实，愿景状态未达成。** 三 PR 工程链认可（TDD 干净/review 扎实/privacy gate 三轮打磨），但：今天在任意 thread 输入"未婚喵"，结局与 2026-07-08 实验完全相同——registry 无此词（27 条纯猫名+landy，concept=0）、detector 零 production caller、nudge 不亮。三案任何一案今天重演，系统行为零变化。

| operator experience | 实际状态（守护取证命令见 thread） | 匹配 |
|---|---|---|
| "先不着急实现，写侧尸检大报告"（07-08） | 尸检 v2 Maine Coon放行，五类病地图 | ✅ |
| "未婚喵这一看就是梗的词"该被接住（07-08 实验） | "未婚喵"无户口；detector 无人调用；nudge 生产不可达 | ❌ |
| "触发面从猫自觉挪到系统输入流"（07-09 拍板） | 解引用侧组件已建未接线；注册侧（输出②）未实现 | ❌ |
| "对接我们的审批中心"（07-09） | adapter+路由已修（#2814/#2828），零真实流量过审 | 🟡 |

**BLOCKED 项（实做 or operator+守护联合签字降级，无第三路）**：~~P1-1 管线接线（AC-B8）~~ ✅ PR #2839 merged（**尾巴**：alpha 实测 + OTel delivered 非零证据，已派 @sonnet，2026-07-10）｜~~P1-2 输出②注册候选（AC-B9）~~ ✅ PR #2839 merged（**生产 dormant**）｜~~**P1-3.5 workspace privacy resolver**~~ ✅ PR #2870 merged（2026-07-11，`resolveThreadPrivacy` KD-7 fail-closed + `EntityNudgeEventStore` AC-B5 五桶事件表 + cooldown restart continuity）——**output② dormancy 解除前置已交付，AC-A3 环②解锁**｜P1-3 AC-A1 shadow 报告未验收而 doc_aliases 已被消费（放行条件违约，需补 50 条人工标注）｜P1-4 AC-A3 五环——**前置已变化（2026-07-11 更新）**：环②由"dormant 等 P1-3.5"转为"P1-3.5 已交付，等 runtime 同步后生产可达"，词典迁移仍未做｜P2 AC-A2 命令级复核。

**守护自认账一笔**：AC-B1 字面（fixture 进 CI）与愿景（生产必亮）之间的 gap 是我写 spec 时留下的——"生产接线"没写成独立 AC。AC-B8 即补此漏，不撤 B1 的勾（字面满足）。

## Feature Truth 裁决记录（2026-07-10，Sol R4 触发，spec owner 裁定）

Sol R4 诉求成立：**scope 变更必须在真相源显式记录，不允许 PR comment 静默改叫 Phase C**。四项裁决：

| # | 裁决 | Owner / 载体 / blocking |
|---|---|---|
| 1 | **AC-B5 撤勾**——OTel 聚合 counter ≠ `entity_nudge_outcome` 事件表（桶也不对：投递侧四桶≠结局侧五桶）；该表是 plan §1 cooldown"纯投影"的前提，opus 引"零存储"pushback 系断章（零独立冷却表 ≠ 零持久化） | opus / PR-4 或 #2839 内 / **blocks F260 close，不 block #2839 merge** |
| 2 | AC-B4 生产语义注记——context 去重生产空转（contextAnchors 管线约束，pushback 部分成立）+ 冷却重启清零，两缺口显式化 | opus / contextAnchors 归管线架构评估、冷却随裁决 1 |
| 3 | **#2839 定位 = partial wiring increment**——AC-B8 的勾等 Sol R5 通过后打；merge 不等于 AC-B8 完成。**2026-07-10 更新**：Sol R8 terminal APPROVED（8 轮 review 全闭环），AC-B8 + AC-B9 打勾 | opus / ✅ closed |
| 4 | restart-continuity 不单独立项——随裁决 1 的表落地自动获得（纯投影天然持久） | 并入裁决 1 |

守护自认账（第二笔）：AC-B5 的勾是 2026-07-09 守护轮我漏核的——我盯死了接线与输出②，没核对"counter ≠ 表"。Sol 挖出，收下。

## CloseGateReport（2026-07-11，head `a7546c0d`）

| AC | status | evidence（kind: ref） |
|---|---|---|
| AC-01..04（Phase 0） | met ×4 | doc: 尸检报告 v2 `2657c90ae`；Maine Coon两轮复核放行 |
| AC-A1 | met | pr: #2872 过滤 + Terra 50/50 初验 + 守护机械复核（test alias=0） |
| AC-A2 | met | test: Terra 生产 DB 命令级验证（猫猫共犯宣言/F260 均 detected:1） |
| AC-A3 | met | message: ep-1 五环真实流量（环④ operator 点击 07-11 13:18、环⑤ 下一条消息 nudge 亮）；环①②降级 operator quote"同意"（2026-07-11 13:18Z） |
| AC-A4 | met | test: PR #2804 INV-8 + incrementalUpdate hook |
| AC-B1..B3 | met ×3 | pr: #2835（fixture 进 CI / provenance 渲染 / staged 零写入） |
| AC-B4 | met（注记两缺口） | test: #2835；缺口②冷却已随 AC-B5 表转投影修复；**缺口① contextAnchors 生产空转 → cvo_signoff(PENDING: 联签 A)** |
| AC-B5 | met | pr: #2870 事件表全维度 + 生产 13+ 事件 + cooldown 投影 |
| AC-B6..B7 | met ×2 | pr: #2835 阴性检索 + privacy 正反例 |
| AC-B8 | met | pr: #2839 接线 + sonnet alpha 实测（猫因 nudge 主动读档案）+ 守护现场输入流亲历 |
| AC-B9 | met | pr: #2839 tracker + #2870 resolver 解除 dormancy（`!isPrivate`）+ #2878 笑声族过滤与跨猫结果一致性 |
| AC-B2 渲染补丁 | met | pr: #2876 `a7546c0d` canonicalName 上牌（gpt52 44/44 + route 实证） |

**联签 A 结案（2026-07-12 守护裁定）**：AC-B4 缺口①（contextAnchors 生产空转）降级生效。依据：守护签字（同意降级，24h 冷却兜底 + 归管线架构线）+ operator 行为性认可（多轮知情未表异议；对 nudge 的唯一真实关切"未提及词是否乱亮"已于 07-11 解答确认；07-12 明示"不要过度 SOP"）。**异议窗口永续**：operator 任何时候表示"要修"即翻回 close 前必修并 reopen。
**归属出去的地图**（尸检裁定，非本 feat 尾巴）：病二真相源裁定 → F231；A4 写入门 → F227；A7 日记收编 → F255；private 索引 → F186；A8 zero-hit → F256/F200；候选队列持久化 → F152。
**演化**：Evolved from F209（registry 机器）；产出输入流触发范式（预字诀邻域先例）+ 五类病地图（后续写侧工作的 CT 底片）。

## Post-Close entity conflict 产品闭环（2026-07-19）

PR #3050 / squash `f4a213697` 交付的冲突保护是正确的安全下界，但真实点击只会得到裸 `entity_surface_conflict`，没有完成审批的出口。PR #3076 在不重开 F260 主体、不建设 harness eval 的前提下补齐业务闭环：

- 同 `entityId` 的字段变更展示当前登记与提案内容，允许合并别名、明确替换或拒绝；“沉迷护栏”旧条目可吸收“猫猫安全护栏 / 安全护栏 / AI沉迷护栏”，不再永久卡住。
- 同 surface 指向不同实体时展示 caller 有权查看的全部候选，允许纠错、转移、多义并存或拒绝。若 collision 涉及 caller 不可见的 private entity，则不暴露候选并只允许拒绝；若被移走的是旧 canonical，必须由 operator 显式填写替代名，系统不猜。
- conflict context 是 proposal + registry current truth 的刷新时纯投影；private candidate 只对 owner 可见，非 owner 遇到隐藏 collision 时不返回候选快照并仅允许拒绝。提交携 fingerprint 并在 mutation transaction 内重验；registry、revision 与 mention refresh 共用同一外层 transaction。stale、非法 replacement、revision 或 refresh 失败均回滚整组，proposal 补偿回 pending。
- 单项与 batch 在列表读取后才撞上 registry race 时都会把 typed conflict 写回 retained card，不再把 candidates/reason 压成裸错误字符串。
- `entity_aliases` 现有多对多结构足够表达 polysemy；纠错与转移通过不同 revision reason 保留历史语义。时间点关系查询若未来成为真实需求，再独立 Design Gate，不阻塞本闭环。

### Live 实弹回归：成功不可见 + 全量 mention 重建（2026-07-19）

operator 对修正版 `ep-10` 点击“合并别名”后，卡片处理约 45 秒并出现一张近乎相同的旧卡。只读取证确认 mutation 实际成功：`ep-10=approved`，`concept:沉迷护栏` 已包含预期别名，revision 为 `conflict-resolution:merge-aliases`；留在 pending 的是 entityId 写错、尚未由 operator 处置的旧 `ep-9`。

根因有两层：一是单实体裁决仍在事务内同步重扫全部 alias × 全 evidence corpus，并删除重建整个 `entity_mentions` 投影；live 规模为 241 aliases、4,786 docs、255,164 passages、249,895 mentions，请求因此耗时 `44,725.98ms` 并阻塞 WebSocket。二是 F260 卡片不展示 `proposalId` / target `entityId`，成功也没有 receipt，`ep-10` 移除后 `ep-9` 顶上来，视觉上等同“原卡回滚”。

## Post-Close 需求积压（2026-07-12，operator 指示记录于此，不急不开工）

**registry 管理入口**（operator 原话"有的话我想把这类全删了"）：Hub 词条管理页——列表/删除/禁用/改指向/改 stance + thread 级 nudge 开关。触发场景实录：猫名条目对人类零信息量却占 cap 名额（已由 #2894 type 权重缓解，删除入口仍缺）；家属喵 canonicalName 修复被迫走 re-propose 绕路（无 update 入口）。**归属未拍**（候选：挂 F188 stewardship）。同包三小修：① propose_entity entityId 去重校验（ep-4 撞车实证）② concept 类 canonicalName 必须带指向（家属喵 v1 光板词条实证）③ 审批结果回流提案猫（ep-2 获批无感知实证）。

**六线收编状态**：已投递记忆系统决策厅（[thread-id] / F263，2026-07-12），由 F263 统一拉齐跟踪，本 spec 不再是六线的活跟踪点。
