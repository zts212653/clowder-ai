---
feature_ids: [F245]
related_features: [F192, F222, F167, F128]
topics: [friction, eval, harness-eval, aggregation, paw-feel, rollup, claw-friction]
doc_kind: spec
created: 2026-06-18
tips_exempt: Phase A-C 为内部 friction 采集/聚合 infra，无 user/cat 可感知 surface；Phase D Eval Hub rollup 视图落地时移除本豁免并补 capability tip
---

# F245: Friction Signal Eval — 摩擦信号统一聚合（eval:friction）

> **Status**: in-progress（Phase C PR1a + PR1b merged；shared Y-lite migration 已合入；**PR2 N-day cadence review in progress（PR #2483）**；Phase D 出口闭环待 PR2 合入后推进）| **Owner**: Maine Coon/Maine Coon (gpt52) | **Priority**: P1
>
> 🔴 **eval-domain 注册 approach 重置（operator directive 2026-06-21）**：PR1a/PR1b 实做了硬 enum-bump（`'eval:friction'` 散落 7 处 + 18 点 fan-out），**偏离Maine Coon 2026-06-18 在 F236 的 Y-lite 裁定**（加 domain=加 YAML 不改中心 contract）。根因=跨线程规矩漏接（裁定没传进 plan，审的非 eval-owner Maine Coon）。**approach 现已拍定：Y-lite 裁定继续作数**；`eval:friction` 作为已 ship 功能保留，但后续 eval-domain 扩展不再继续走硬 enum-bump。**自 2026-06-21 ownership reset 起，当前 owner = Maine Coon/Maine Coon (gpt52)**；本轮主责 = F245 文档澄清 + shared Y-lite migration plan/PR。**F236 thread 已完成 ack，shared Y-lite migration 已于 2026-06-21 合入（PR #2476，squash `0822a68b4`）**；后续可恢复 PR2 / Phase D。

## Architecture Ownership

Architecture cell: `harness-eval`
Map delta: **update required**
Why: 在 F192 harness-eval 控制面下新增 `eval:friction` domain + **爪感差 marker 采集子域**（全新，无既有 extension point）+ 跨通道 friction rollup aggregator；harness-eval cell 的 canonical files 需登记这些新组件。

## Why

猫每天报爪感差、用户每天 cancel、F222 采集用户反馈、5 个 eval 域各自产摩擦——**4 个采集通道散落在 4 个不同地方，没有任何统一视图**。结果：operator 想知道"这周到底产生了哪些摩擦"，得手动翻 4 处，而且看不懂技术细节。

operator experience（2026-06-18，本 thread）：
- "这些都特喵散落哪里了"
- "③ 用户直接反馈 → 他好像只是搜集了反馈 但是做了 eval 吗？用户到底都反馈了什么？"
- "只靠我看太不靠谱了，有些环境 工具 我也看不懂啊"
- "其实我们想看的是不是 每周/每3天 这些渠道到底产生了哪些摩擦"

核心痛点（每条对应一个采集通道的缺口）：
1. **爪感差是死信号**——猫每轮认真写 `[爪感差: 工具+现象]`，但写完躺在消息流里**没有任何采集**
2. **F222 只采集不 eval**——把单条负体验打包成 issue 喂给 task-outcome，**没有任何环节回答"用户都反馈了什么"**（聚合视图缺失）
3. **cancel signal 埋着不露头**——在 `task-outcome/cancel-burst-detector.ts`，作为子信号存在，operator 感知不到
4. **eval 域摩擦散在 5 处**——各域 friction_counts 各自为政，无横向汇总
5. **尾端人肉不可靠**——靠 operator 肉眼扫聊天流，会漏、会累、看不懂技术细节

要的终态：**周期性一张表**，所有渠道的摩擦聚合 → 分类（harness / 工具 / 环境）→ 可读分析（把技术细节翻译成人话）→ 可行动项走 F128 + code-as-harness 修。

## Current State / 现状基线

实测证据（本 thread 5 轮盘点，2026-06-18）：

| 采集通道 | 定义在哪 | 现在落点 | 状态 |
|---|---|---|---|
| ① 猫爪感差 `[爪感差]` | L0 staging / ADR-038 | `grep packages/` **零命中** | 🔴 死信号，无采集 |
| ② 用户 cancel signal | audit §七 §八（act 类） | `harness-eval/task-outcome/cancel-burst-detector.ts` | 🟡 埋在 task-outcome |
| ③ 用户直接反馈 | **F222（done）** | `RedisFrustrationIssueStore`（单条 issue，自述"采集+报告"非"诊断+修复"） | 🟡 采集了无聚合 eval |
| ④ eval 域产出摩擦 | 5 个 eval domain | `harness-eval/{a2a,capability-wakeup,memory,sop,task-outcome}/` 各自 friction_counts | 🟡 散在 5 域 |

摩擦定义现状（散在一份文档无统一视图）：
- **五类摩擦传感器**（信号形态）：`2026-06-01-f192-eval-coverage-audit.md` §八——中断动作(act) / 中断理由(reason) / 世界结果真值 / 聚合proxy / 缺席摩擦
- **L1–L4 四层模型**（判断层）：同文档 §一
- 四个**采集通道**（信号来源）：从未被任一文档汇总过

signal 体量实证（今天 UTC 0:00 → 16:07，16 小时）：
- **56 个 thread 活跃**（~12 MR review 自动轮转，~44 实质讨论）
- **15 个不同猫 identity**，平均 **~4 猫/thread**（f229 球 8 猫 / f211 antig 10 猫）
- 本地单机 **42 个 session 文件**当日写入（仅一台机器的 CLI session）
- invocation 量级估算：**数百次/天起跳** → 摩擦信号按 invocation 粒度产生，攒一周 = 几百上千条 raw → eval 猫一次性消费 **context 必爆**

## What

### Phase A: 爪感差采集层（补死信号）

把 `[爪感差: 工具+现象]` 从消息流自由文本变成结构化 friction signal：回扫当周消息（OQ-1：回扫 vs 实时打标）→ 正则提取 → 结构化字段（catId / threadId / timestamp / tool / symptom）→ 写入 friction signal store。这是唯一"全新采集"的通道，其余三通道是引用既有数据。

### Phase B: 跨通道统一消费 + dedup/cluster

统一消费 4 个通道，**Port + Adapter → 公共中间类型 `FrictionSignal`，只读引用源数据、不建统一 store**（46 Design Gate；4 通道形态异构，强推统一 store 违反 KD-1）。把 raw signal dedup + cluster 同类（"rg 噪音大 ×12" 折叠成 1 个 cluster）。**采集层只做幂等去重**（messageId+markerIndex / issueId / episodeId），**语义 cluster 必须等 rollup**（Maine Coon：跨通道同源事件会重复表现，采集时合并不可逆误折叠）。

> ⚠️ **Maine Coon Design Gate 纠正**：`rollup_deferred` **不是现成 extension point**——代码里还没 rollup sink（`publish-policy.ts` 只是未来意图）。F245 要**自己实现这个 sink**，不是"复用现成机制"。

### Phase C: eval:friction domain 注册 + 周期 rollup + verdict

注册 `eval-domains/eval-friction.yaml`，**频率可配置**（社区默认 weekly / 本家默认 3 天 / 可调 daily）。到周期点 flush 出**已聚合**报告：Top-N 配额（Top-10 深挖 + 长尾折叠；排序 = severity × count × **channel diversity** ——跨通道出现=强信号）+ **token 硬上限 ~4000**（46：比纯 Top-N 更有效）→ 按五类传感器形态标注 + 7-class 根因分类（harness_misfit / tool_gap / environment_drift / …）→ 复用 F192 Verdict Handoff Packet 产出 verdict。

> ⚠️ **Maine Coon Design Gate 纠正**："本家 3 天"**不是纯配置文案**——registry 现只支持 `daily|weekly`，要加 **N-day cadence + last-run gate** 才落得进 3 天默认。

### Phase D: 出口闭环 + Eval Hub 呈现

- **①②③**（爪感差/cancel/用户反馈）可行动项 → **F128 propose_thread** 创建修复 thread → **code-as-harness** 修（复用 F222/F128 pattern）
- **④**（eval 域摩擦）→ **只列出 + 链接**各域既有 verdict（各域自修，不重复处理）
- Eval Hub friction rollup 视图（现场可感知，不只 dashboard 数字）

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。 -->

### Phase A（爪感差采集层）
- [x] AC-A1: 爪感差 marker 采集器——回扫消息提取 `[爪感差: …]`，输出结构化字段（catId/threadId/timestamp/tool/symptom），红→绿测试覆盖（trace Why#1 死信号）✅ PR #2422
- [x] AC-A2: 采集覆盖验证——给定含 N 条爪感差的消息 fixture，采集出 N 条结构化 signal，precision/recall gate（非作者可跑 fixture 复核）✅ PR #2422

### Phase B（跨通道聚合）
- [x] AC-B1: 4 通道统一消费 adapter——爪感差新建 + cancel 引 task-outcome + F222 引 issue 池 + eval 域引 friction_counts；**不重新实现既有三通道的采集**（trace Why：A 聚合不搬迁）✅ PR #2443
- [x] AC-B2: dedup + cluster——"rg 噪音 ×N" 折叠成 1 cluster，cluster 含 count + 成员 evidence refs；误聚合率有 fixture 验证（误聚合率=0 corpus gate）✅ PR #2443

### Phase C（domain + rollup）
- [ ] AC-C1（部分）: `eval-domains/eval-friction.yaml` 注册 + `enabled:true` flip（PR1b #2469），frequency 可配置（weekly/N-day/daily），默认社区 weekly / 本家 3 天（trace Why：operator signal 体量担忧）— yaml+enabled+weekly 已落；**N-day cadence + last-run gate（本家 3 天默认）= PR2 #2483 review in progress**
- [x] AC-C2: 周期 rollup 报告——Top-N 配额（深挖 Top-N + 长尾折叠），按五类传感器形态 + 7-class 根因分类（命令产出可复核）✅ PR1b #2469（live rollup 接入 4-channel provider + generator）
- [x] AC-C3: verdict 产出复用 F192 Verdict Handoff Packet schema（缺字段不得 handoff）✅ PR1b #2469

### Phase D（出口闭环）
- [ ] AC-D1: ①②③ 可行动项 → F128 propose_thread 创建修复 thread（复用 F222/F128 pattern，截图/thread 链接可复核）
- [ ] AC-D2: ④ eval 域摩擦只列出 + 链接各域 verdict，不重复处理（trace Why：operator"④各自会修，只需列出"）
- [ ] AC-D3: Eval Hub friction rollup 视图（在 context 可感知性自检过；截图复核）

## Eval / Tracking Contract

### 1. Primary Users + Activation Signal
- **Users**: operator（读周期 rollup 报告）+ 猫猫（接 F128 修复单的人）
- **Activation**: 周期 rollup 触发 / 新高频 cluster 浮现 / F128 修复 thread 创建

### 2. Friction Metric
- rollup 处理时长 & eval 猫消费 token（验证"不爆 context"）
- cluster 误聚合率（把不同问题折一起）
- 可行动项 acted-on rate（F128 thread 真被修的比例）
- 爪感差 signal 漏采率（fixture 验证）

### 3. Regression Fixture
- 含 N 条 `[爪感差]` 的消息样本 → 采集出 N 条结构化 signal
- "rg 噪音大 ×12" 同类反馈 → 折叠成 1 个 cluster（count=12）
- ④ eval 域摩擦 → 只列出 + 链接，不进入 F128 出口（不重复处理）
- 正常无摩擦消息 → 不误采

### 4. Sunset Signal
- rollup acted-on rate <50% 且 duplicate cluster >0 → 控制面比散落更重，进 simplify/sunset review（沿用 F192 KD-2 sunset 逻辑）
- 某通道（如爪感差）长期零摩擦 → 该通道可降频或休眠

## 软 + 硬 + eval 三层（ADR-031）

| 层 | 承重 | 载体 |
|----|------|------|
| **Soft** | 猫在正确路径上想起报摩擦 | L0 爪感差 convention（已有）+ code-as-harness skill 引导 |
| **Hard** | 不靠自觉也能采到 + 不爆 context | 采集 precision/recall test + cluster dedup test + Top-N 配额 schema guard |
| **Eval** | 持续检验摩擦是否真被修好 | 本 feature 自身即 eval 层（eval:friction domain）+ Sunset Signal 自检 + acted-on rate |

## 需求点 Checklist

- [x] 爪感差结构化采集（Phase A）
- [x] 4 通道统一消费，不搬迁既有采集（Phase B）
- [x] dedup + cluster 同类摩擦（Phase B）
- [ ] 频率可配置（社区 weekly / 本家 3 天 / daily）（Phase C）
- [ ] Top-N 配额防 context 打爆（Phase C）
- [ ] 五类传感器形态 + 7-class 根因分类（Phase C）
- [ ] ①②③ → F128 + code-as-harness 修复出口（Phase D）
- [ ] ④ 只列出 + 链接，不重复处理（Phase D）
- [ ] Eval Hub friction rollup 视图（Phase D）

## Dependencies

- **Evolved from**: F192（eval 控制面母 feature——复用 domain registry / Verdict Handoff Packet / daily-spec cron / Eval Hub / rollup_deferred 占位）
- **Related**: F222（用户反馈采集——本 feat 补它缺失的聚合 eval）/ F167 KD-27（持球+event 双重唤醒 = 经典 friction cluster 案例，软约定失效→该升硬层）/ F128（propose_thread 出口）/ code-as-harness skill（修复路径）
- **Downstream consumer（F236 Track-2，2026-06-18 跨线程登记）**: F236 Track-1 已 merged（PR #2411，squash `21ae2c83b`，anchor telemetry 收口为 chars/request-volume substrate）。**F236 Track-2**（open-rate correlated-event model + `eval:anchor-first` domain 注册）**downstream-blocked 在 F245 Phase C 的 shared Y-lite eval-domain infra** 上（registered string `domainId`/`sourceAdapter`/`sourceRefsKind` + YAML registry 校验 + N-day cadence + missing-wiring fail-closed）。Maine Coon eval-owner 裁定排序：**F245 Phase C 先 land 该 infra，F236 Track-2 rebase 继承不另起一套**。🔴 **Phase C land shared Y-lite infra PR 时必须 `cross_post_message` ping `opus-48` @ F236 thread `[thread-id]`**。Track-2 设计约束（open-rate = 跨请求 preview↔drill 可 join 事件模型；高基数 id 不做 metric label，走 event/log/trace/adapter source record）在 F236 doc item 6（commit `e62e6eac8`）；Y-lite contract canonical home = F192（Maine Coon定）。

> 🔴 **实做偏离 — 待纠正（operator directive 2026-06-21，opus-48 已接，对事不对猫）**：上面承诺的 **Y-lite eval-domain infra**（registered string `domainId` + YAML 校验、加 domain=加数据不改中心 contract、Maine Coon明令"两 feature 禁硬 enum +1/+2"）**没有兑现**。PR1a（`1b67516b9`）+ PR1b（`ef1d1cca7`）实做的是**硬 enum-bump**：中心 `domainId` enum 直接 +`eval:friction`（`verdict-handoff.ts` + `domain/eval-domain-registry.ts`），`'eval:friction'` 硬编码散落 **7 处**（index.ts / verdict-handoff.ts / eval-domain-registry.ts / eval-cat-invocation.ts / publish-verdict.ts / friction-generator-adapter.ts / friction-submitted-packet-guard.ts）+ 18 点 fan-out。**根因 = 跨线程规矩漏接**：Maine Coon 2026-06-18 在 F236 thread 的 Y-lite 裁定没传进 F245 Phase C plan，PR review 是 gpt52 + 云端（非定规矩的 eval-owner Maine Coon），所以没人发现违裁——代码过了 review（不烂），但 approach 违背架构裁定。**架构腐败风险**（operator）：eval 越铺越多，enum-bump 每加 domain 改中心 contract（高 blast-radius）+ 并行撞车 + fan-out 越堆越肿，核心退化成瓶颈。**下一步**：由当前 owner gpt52 按已拍定的 Y-lite migration 落地（去中心 enum → registered string + YAML 校验），不再讨论“保留 enum”分支；adapter/generator 仍必须代码显式 wiring、缺 wiring fail-closed。F236 Track-2 下游按这套 shared Y-lite contract rebase 继承。本 note 先消除"承诺 Y-lite、实际 ship enum"的 doc 自相矛盾，再补 migration plan/PR。

> 🟡 **执行顺序（2026-06-21 ownership reset，已完成）**：先改清这份 F245 feat doc → 直接 cross-thread 发给 F236 thread 审核/ack → 两边对齐后写 **shared Y-lite migration plan/PR** 并合入。**先 migration，后 PR2 / Phase D**；Y-lite 只是注册/校验层，不是插件系统，adapter/generator 仍必须代码显式 wiring，缺 wiring fail-closed（Maine Coon 2026-06-21 二次边界确认）。

## Risk

| 风险 | 缓解 |
|------|------|
| signal 体量打爆 eval 猫 context（实证数百 invocation/天） | 持续聚合 + Top-N 配额（核心设计，非事后补救） |
| cluster 误聚合（不同问题折一起，verdict 失真） | 误聚合率 metric + fixture 验证 + 人工抽查 |
| 与 task-outcome / F222 职责重叠 | 边界钉死：friction = 跨通道聚合视图，A 聚合不搬迁；task-outcome=单任务成败(L3)；F222=单条采集喂数据 |
| 频率配置过激（daily）反而噪音 | 频率可调 + Sunset Signal 监控 acted-on rate |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 走 A 聚合视图，不 B 重构搬迁 | operator分级设计"④只列出 / ①②③聚合分析"= 不动 task-outcome/F222，风险低 | 2026-06-18 |
| KD-2 | 频率可配置（社区 weekly / 本家 3 天），不固定 weekly | 实证 signal 体量大（数百 invocation/天），固定 weekly 攒太多且迭代慢 | 2026-06-18 |
| KD-3 | 新开 F245 link F192，不塞进 F192 | F192 已是巨型控制面 meta-feature，recall 困难；F222 先例（用户反馈也独立开号 link F192） | 2026-06-18 |
| KD-4 | F245 = **只读 rollup/read-model 域，不抢 canonical signal ownership** | Maine Coon Design Gate：最危险的不是重复代码，是 F222/task-outcome/eval 域各自闭环被第二套出口抢走。把 KD-1"不搬代码"升级到"不抢 ownership"——F245 只读不写（不写 episodeVerdicts，只读 cancel/episode 作传感器） | 2026-06-18 |
| KD-5 | **Port + Adapter + `FrictionSignal` 中间类型，不建统一 store** | 46 Design Gate：4 通道形态异构（消息文本/episode/issue 生命周期/数值 metric），内存聚合 ~10-30 cluster，持久化的是 verdict artifact 不是中间 store | 2026-06-18 |
| KD-6 | **Phase A 实施接口校准**（plan 假设 → 实际，给 Phase B-D 实施者）| ① 测试框架是 `node --test`（手写 `.js` import `dist/`）非 plan 写的 vitest；② 全局时间窗扫描用 `IMessageStore.getBefore(userId=undefined)` 走全局 TIMELINE zset 游标翻页——`IThreadStore` 无全局枚举（仅 per-user），plan/handoff 的"枚举 thread"方案不可行；③ adapter 仅依赖 `getBefore`，非 plan 的 IThreadStore+RedisMessageStore 双注入；④ Redis 测试 timestamp 必须 `Date.now()` base——`append` 会 `zremrangebyscore` prune `score<now-TTL`，远古固定 ts 一存即删 | 2026-06-18 |

## Review Gate

- Phase A–D: 跨族 review（Ragdoll author → Maine Coon/Maine Coon or gpt52 review）；架构 Design Gate 拉 harness-eval owner（Maine Coon/47）收敛 cluster 算法 + Map delta + 频率默认值
