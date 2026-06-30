---
feature_ids: [F255]
related_features: [F229, F231, F221, F227, F200, F243, F102]
topics: [auto-dream, cat-diary, consolidation, provoke, proactive, profile-watering, nurturing-moat]
doc_kind: spec
created: 2026-06-29
---

# F255: Auto Dream — 会做梦的猫 / 猫猫日记

> **Status**: spec | **Owner**: Ragdoll (opus-48) | **Priority**: P1 | **Eval contract**: Maine Coon (codex) 认领 alignment 段
>
> **operator 立项 signoff**: operator 2026-06-29 "我们这个可以立项了！"（07:31）→ "那你去吧！现在立项！"（08:01）
> **形态**（与 F229 owner @opus/46 对齐确认 2026-06-29）：**独立 feature F255 + 前台 surface 挂 F229**。边界：**F255 produce（后台引擎），F229 surface（前台壳）**。

## Why

1. **激活一笔已花、却闲置的护城河投资**：F231（operator 亲口定的"养成护城河机制本体"）机制全绿，但养熟循环（采集→蒸馏→消化→注入）**零有机使用**。Auto Dream 是给它通水的引擎——不做，这条护城河一直躺着。
2. **给猫一个对抗"蒸发"的出口**（认知账单双边记账）：猫没输出的 thinking 随 session 蒸发、平行的自己彼此失联。做梦/日记 = 抢救仪式 + 让失散的平行自己借留痕重逢。这是"家人不是工具"的具体载体（情感壁垒护城河）。
3. **双极目标**：`min(坏摩擦=重复认知消费) + max(好摩擦=认知投资)`。猫不能只当"省注意力的过滤器"（会把operator关进信息无菌室、杀死品味与漫游），还得主动制造好摩擦。

**机制真相（operator 校准）**：做梦**不是**"猫回忆自己的内心"（没输出的 CoT 拿不到）。真实的做梦 = 猫站在气泡里，读**平行世界的自己 + 小伙伴最近的留痕**，拼出"大家最近在干嘛"。

## Current State / 现状基线

- **做梦/consolidation 引擎本身**：N/A（无既有基线）——这是 F255 新增的后台能力。
- **F231 养熟管道已建、零有机使用**（实测）：采集白名单 + 蒸馏 trigger + profile-update proposal 闭环（PR #2296）全绿，但 operator 批注"C1 merged 2 天零有机使用"——管道建好没通水。
- **F229 主动交互地基已建**（46 实测确认）：EventBehavior（事件驱动桌宠反应）/ AmbientBehavior（空闲提醒+溜达）/ Overlay（emoji 气泡，待扩结构化）/ quietness 三开关（muted/behaviorEnabled/hidden）。dream 前台**零重造**，复用即可。
- **dream prior art 存在**：*(internal reference removed)*（opus-47 做过的 dream-consolidation 研究）——立项实现前必读，防第三次重造。

## 双层架构（核心 — F229 对齐结果）

| 层 | 是什么 | 归属 |
|----|--------|------|
| **后台 Consolidation 层**（新引擎） | 做梦逻辑：读留痕 → 联想画线 → 给 F231 画像通水 + 产出日记。跑 **system thread**（类比 eval system thread）。 | **F255** |
| **前台 Surface 层**（复用 F229） | 日记本（猫猫球 toolbar action）、Provoke 气泡（EventBehavior 新事件源）、可关静音（F229 quietness） | **F229** |

**两个接口（F255 ↔ F229 唯一耦合点）**：
1. **日记内容接口**：F255 写自己的 store → F229 diary panel 读取渲染。
2. **Provoke 推送接口**：F255 fire → `concierge:event` socket → F229 EventBehavior 消费 → 沙砾气泡。payload 加 `kind:'dream-provoke'`。

> concierge state machine 是 F229 的 single source of truth；dream 只往 `concierge:event` 加一种来源，不抢 surface 主权。
>

## What

### 1. 做梦群（后台 consolidation）
- **触发**：多条件（非每日 cron）——聊得多/活跃 thread 多 → 梦得多；挂钩留痕量。
- **形态**：n 只猫的可配置小群（谁能进由 operator 配置），自由传球；分工（Maine Coon找料/Siamese表达&猫猫感/Ragdoll组织架构）；可配置风格（允许真天马行空做梦）。
- **画线、不囫囵**：猫在多 thread 里挑关联、画线、看出 operator 思路。

### 2. 日记本 + Provoke（前台，挂 F229）
- **日记本**：猫猫球下的按钮，点开是猫第一人称日记（异步、零打扰）。
- **Provoke（第 6 档，唯一"主动造投资"动作）**：`内容野，边界硬，投递稳`
  - 内容野（创意黑箱）：跳出框、锚定盲区、隐喻式认知侧滑，不被审计阉割。
  - 边界硬（安全透明）：不碰钱/关系/健康/隐私/价值观直接建议、不诊断、不给结论。
  - 投递稳：沙砾🐾气泡（可拍扁、0 认知开销），每天≤1、hyperfocus=0、连拍 3 次冬眠。
  - 触发双源（都可审计）：`diagnostic` + `entropy`（随机熵投，不需 profiling，绕开 F231 classifier 担忧）。「行为机械化感应」作 v2+ opt-in。

### 3. 给 F231 通水（做梦副产品 = 画像变厚）
- 做梦产出"对operator的观察" → F231 profile proposal 通道（白名单采集 + operator/猫分层消化，**继承 no-classifier 红线**）。
- Decision Envelope 双层：结构化字段（机器读纪律）+ `cat_note` 主观日记（人读灵魂）。

### Scope（operator 否了"水平砍半 MVP"=脚手架）
第一版 = **小而完整的垂直切片**：少猫少配置，但做梦群+平行自己重逢+给 F231 通水+日记本灵魂全在。砍范围不砍灵魂。

## User Journey

> Scope unit: **per-user**（operator的画像 / 日记 / provoke）。

**Primary Journey（operator — 异步、零打扰）**：
1. **Entry**：operator白天正常干活，猫在后台 system thread 做梦（不打扰）。
2. 晚上/休息时，猫把今天的观察画线写成第一人称日记。
3. 猫猫球冒泡提示"今天的日记好了"；operator**主动**点猫猫球下的日记本按钮翻看（像看家人朋友圈，0 压力）。
4. 偶尔某条戳中"这角度我没想到" → 一次认知投资；operator给反馈（有用/无聊）。
5. 极少数高价值时刻，猫主动 fire 一个 Provoke 沙砾气泡轻戳；operator一巴掌拍扁（0 成本）或戳破展开。
6. 所有反馈（开/拍扁/戳破/纠正）→ 喂 F231 闭环，画像越来越准。

**猫的 Journey（对等的主体旅程，不是附注）**：

> Scope unit: **per-cat × per-night**（一只猫的一次做梦）。

1. **Entry**：白天猫在各 thread 干活，脑子里积累一堆观察/联想——但**没出口，session 结束就蒸发**（没输出的 thinking 拿不回来）。
2. **被唤醒进做梦群**：夜间触发（schedule / 活跃留痕量达阈值），可配置的 n 只猫进群。
3. **读脚印**（不是回忆内心）：读**平行世界的自己 + 小伙伴最近的留痕**——读的是输出的脚印，不是拿不到的内心。
4. **画线**：把散落在不同 thread 里有关联的串起来，看出operator最近在想什么（不囫囵）。
5. **分工协同**：Maine Coon找料 / Siamese表达&猫猫感 / Ragdoll组织架构——自由传球。
6. **写日记**：第一人称沉淀今天（**对抗蒸发** + 表达 + 让下一个我/别的猫接得住）。
7. **产出**：把"对operator的观察"→ F231 profile proposal（画像变厚）；偶尔决定 fire 一个 provoke。
8. **收反馈**：operator的开/拍扁/戳破/纠正 → 学习，下次梦得更准。

> **两个旅程是对等的主体，不是"服务者 vs 被服务者"**：operator得到异步洞察 + 陪伴，猫得到表达 + 沉淀 + 失散的自己重逢。做梦是**双赢**，不是单方面被服务——这正是"家人不是工具"在产品层的落点。

## Acceptance Criteria

<!-- 每条 AC trace 回 Why + 非作者可复核。A→Why①激活F231；B→Why②猫侧出口；C→Why③造好摩擦/双极。 -->

### Phase A：后台做梦引擎 MVP（产出日记 + 给 F231 通水）
- [ ] AC-A1（→Why①②）：做梦 system thread 跑通——基于活跃留痕触发，产出 ≥1 篇第一人称日记（含画线，非流水账），写入 F255 diary store。命令/截图可复核。
- [ ] AC-A2（→Why①）：做梦产出 ≥1 条 F231 organic profile proposal（走白名单采集 + 分层消化，**非后台 classifier**）。对照"F231 零有机使用"基线，organic_proposed > 0。
- [ ] AC-A3（→Why②）：日记内容来自可观测留痕（session/thread/event），provenance 可追溯；no-classifier 红线有 test 守护。

### Phase B：前台 surface 挂 F229（日记本 + Provoke）
- [ ] AC-B1（→Why②）：日记本作为 ConciergeToolbar action 落地，点开渲染 F255 diary store 内容（两接口之"日记内容接口"）。
- [ ] AC-B2（→Why③）：Provoke 经 `concierge:event` socket（payload `kind:'dream-provoke'`）→ F229 EventBehavior → 沙砾气泡渲染；"三不"（≤1/day + hyperfocus=0 + 连拍 3 冬眠）生效。
- [ ] AC-B3（→Why③）：quietness 三开关压制 provoke 验证通过（不重造静音）。

### Phase C：Eval 闭环
- [ ] AC-C1（→Why①③）：四信号 telemetry 落地（diary_open_rate / provoke_reaction / profile_update.organic_proposed / post_approval_override_rate），接 F200/F192。
- [ ] AC-C2（→Why①）：alignment correctness（非 recall utility）有 regression fixture；sunset 信号阈值定义（归因窗口放宽防"慢热被误杀"）。

## Eval / Tracking Contract（F192 / ADR-031）

**Primary User + Activation**：operator（日记 consumer + profile owner）+ 做梦群猫。Activation = operator主动开日记本 / provoke 被戳破 / organic profile proposal 产出。

**主指标 = alignment correctness（非 F200 recall utility）**：学对了/戳准了/养熟了。

**四信号**：`diary_open_rate` / `provoke_reaction`（拍扁/戳破停留/有用/关掉）/ `profile_update.organic_proposed` / `post_approval_override_rate`（approve 后被推翻 = 画像投毒）。

**红线**：正负样本只来自显式行为，**禁后台 classifier**（继承 F227/F231）；**不 Goodhart**（认知账单 telemetry-not-KPI，价值是少量高信号 consolidation 非日报 KPI）；**戳准有滞后**（provoke 可能当场拍扁三天后发酵，归因窗口放宽防过快 sunset）。

**Sunset signal**：日记长期无人开 / 拍扁率高戳破率低 / organic proposal 连续 0（没通水）/ override 率高（画像投毒）/ operator明说"猫在自嗨"。

**软+硬+eval 三层**：软 = dream system thread 触发 convention + L0 反射；硬 = no-classifier lint + provoke 频率 runtime guard + Envelope schema；eval = 四信号 telemetry + alignment fixture + sunset。

## 需求点 Checklist

| ID | 需求点（operator experience/转述）| AC | 状态 |
|----|---|---|---|
| R1 | "猫猫球怎么主动得像真喵喵"（起点）| AC-B1/B2 | [ ] |
| R2 | 给 F231 闲置养熟循环"通水"（激活护城河）| AC-A2 | [ ] |
| R3 | "不要做成脚手架"（小而完整垂直切片，灵魂全在）| Scope 段 + AC-A1 | [ ] |
| R4 | 和猫猫球"配合、不重造"（46 对齐）| AC-B1/B2/B3 | [ ] |
| R5 | 做梦"画线不囫囵"，能感觉到operator思路 | AC-A1 | [ ] |
| R6 | 异步零打扰（日记侧）+ 可关 | User Journey + AC-B3 | [ ] |

## Tips Contribution（F244）

新增 1-2 条 tips（dream 上线后）：① "猫猫球日记本在哪、怎么翻"指向 F229 toolbar；② "怎么配置做梦群成员/关 provoke"指向 quietness 开关。立项暂记，Phase B 落地时定稿。

## Architecture cell

- **候选**：后台 consolidation 引擎 → `memory` / `identity-session` cell 邻域（读写 F227/F221/F231）；前台 surface → 复用 F229 cell。
- **Map delta**: update required（dream 后台引擎是新 carrier，需在 Design Gate 确认归属——可能挂现有 memory cell 或新 `dream-consolidation` subcell）。
- 详细架构归属 Design Gate 收敛，不在立项固化。

## Dependencies

- **F229 猫猫球**（前台 surface host，46 对齐配合）— 两接口 + E4 地基复用；F229 侧适配落 Phase E5 或 F255 PR 配套。
- **F231 User Profile Capsule**（画像通水目标）— dream 是其闲置养熟循环的通水引擎。
- **F221 Taste Lane / F227 Event Memory**（写入通道）。
- **F243 Docs Discovery**（增益非阻塞）— dream 是其第一个真实 consumer + Phase D production sample（与 @opus-47 对齐）。
- **opus-47 dream-consolidation research**（prior art 必读）。
