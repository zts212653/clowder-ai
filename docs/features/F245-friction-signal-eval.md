---
feature_ids: [F245]
related_features: [F192, F222, F167, F128]
topics: [friction, eval, harness-eval, aggregation, paw-feel, rollup, claw-friction]
doc_kind: spec
created: 2026-06-18
---

# F245: Friction Signal Eval — 摩擦信号统一聚合（eval:friction）

> **Status**: done | **Completed**: 2026-06-22 | **Owner**: Maine Coon/Maine Coon (gpt52; close sync @codex) | **Priority**: P1
>
> ✅ **Closed state**: Phase A/B/C/D all merged; Phase D PR #2504 squash `440d8942d`; capability tip seeded; F245 removed from BACKLOG (`243458651`); opus-47 vision guardian APPROVE 2026-06-22; formal close report added 2026-06-23.
>
> ✅ **Architecture correction resolved**: PR1a/PR1b initially shipped a hard enum-bump, which violated the 2026-06-18 Y-lite eval-domain registration decision. operator reset ownership on 2026-06-21; shared Y-lite migration merged in PR #2476 (`0822a68b4`); PR2 and Phase D then landed on top of that contract. Current final contract: registered strings + YAML registry validation + explicit code wiring + fail-closed missing wiring.

## Architecture Ownership

Architecture cell: `harness-eval`
Map delta: ✅ updated（harness-eval.md cell 已登记 9 个 friction code anchor + feature doc link；愿景守护 2026-06-22 确认）
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

## Original Baseline / 立项时现状基线

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
- [x] AC-C1: `eval-domains/eval-friction.yaml` 注册 + `enabled:true` flip（PR1b #2469），frequency 可配置（weekly/N-day/daily），默认社区 weekly / 本家 3 天（trace Why：operator signal 体量担忧）✅ N-day cadence + last-run gate（本家 `every-3d` 默认）merged PR2 #2483（squash `806527665`）
- [x] AC-C2: 周期 rollup 报告——Top-N 配额（深挖 Top-N + 长尾折叠），按五类传感器形态 + 7-class 根因分类（命令产出可复核）✅ PR1b #2469（live rollup 接入 4-channel provider + generator）
- [x] AC-C3: verdict 产出复用 F192 Verdict Handoff Packet schema（缺字段不得 handoff）✅ PR1b #2469

### Phase D（出口闭环）
- [x] AC-D1: ①②③ 可行动项 actionability 分类 + followupDraft payload（eval cat 手动触发 propose_thread，不自动——INV-D5）✅ PR #2504
- [x] AC-D2: ④ eval 域摩擦只列出 + 链接各域 verdict，不重复处理（referenceOnly clusters；trace Why：operator"④各自会修，只需列出"）✅ PR #2504
- [x] AC-D3: Eval Hub friction rollup 视图（"建议修复"/"仅引用"/honest empty state；截图复核）✅ PR #2504

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
- [x] 频率可配置（社区 weekly / 本家 3 天 / daily）（Phase C）
- [x] Top-N 配额防 context 打爆（Phase C）✅ Top-10 + 4000 token 硬上限 fold-down（friction-rollup-report.ts）
- [x] 五类传感器形态 + 7-class 根因分类（Phase C）✅ FrictionSensorForm 5 值 + CHANNEL_SENSOR_FORM 映射；FrictionRootCause 7-class 由 eval cat verdict 层判断（KD-8）
- [x] ①②③ actionability 分类 + followupDraft payload → eval cat 手动触发 F128 propose_thread（INV-D5）（Phase D）✅ PR #2504
- [x] ④ 只列出 + 链接（referenceOnly clusters），不重复处理（Phase D）✅ PR #2504
- [x] Eval Hub friction rollup 视图（"建议修复"/"仅引用"/honest empty state）（Phase D）✅ PR #2504

## Dependencies

- **Evolved from**: F192（eval 控制面母 feature——复用 domain registry / Verdict Handoff Packet / daily-spec cron / Eval Hub / rollup_deferred 占位）
- **Related**: F222（用户反馈采集——本 feat 补它缺失的聚合 eval）/ F167 KD-27（持球+event 双重唤醒 = 经典 friction cluster 案例，软约定失效→该升硬层）/ F128（propose_thread 出口）/ code-as-harness skill（修复路径）
- **Downstream consumer（historical unblock: F236 Track-2）**: F236 Track-1 merged first（PR #2411，squash `21ae2c83b`，anchor telemetry 收口为 chars/request-volume substrate）。F236 Track-2（open-rate correlated-event model + `eval:anchor-first` domain 注册）曾 downstream-blocked 在 F245 Phase C 的 shared Y-lite eval-domain infra 上（registered string `domainId`/`sourceAdapter`/`sourceRefsKind` + YAML registry 校验 + N-day cadence + missing-wiring fail-closed）。该 shared infra 已于 2026-06-21 随 F245 PR #2476（squash `0822a68b4`）合入；**F236 Track-2 随后于 2026-06-22 合入（PR #2490，squash `5251c2f75`），说明 blocker 已解除并完成继承。** Track-2 设计约束（open-rate = 跨请求 preview↔drill 可 join 事件模型；高基数 id 不做 metric label，走 event/log/trace/adapter source record）在 F236 doc item 6（commit `e62e6eac8`）；Y-lite contract canonical home = F192（Maine Coon定）。

> ✅ **已解决的历史偏离（operator directive 2026-06-21，对事不对猫）**：上面承诺的 **Y-lite eval-domain infra**（registered string `domainId` + YAML 校验、加 domain=加数据不改中心 contract、Maine Coon明令"两 feature 禁硬 enum +1/+2"）最初没有兑现。PR1a（`1b67516b9`）+ PR1b（`ef1d1cca7`）实做的是硬 enum-bump：中心 `domainId` enum 直接 +`eval:friction`（`verdict-handoff.ts` + `domain/eval-domain-registry.ts`），`'eval:friction'` 硬编码散落 7 处 + 18 点 fan-out。根因 = 跨线程规矩漏接：Maine Coon 2026-06-18 在 F236 thread 的 Y-lite 裁定没传进 F245 Phase C plan。处置结果：2026-06-21 ownership reset 后，PR #2476 (`0822a68b4`) 已把 eval-domain registration 迁到 Y-lite；adapter/generator 仍代码显式 wiring，缺 wiring fail-closed；F236 Track-2 已继承并合入。

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
| KD-7 | **Y-lite eval-domain registration 是最终共享 contract** | operator directive 2026-06-21：硬 enum-bump 造成跨 feature split-brain 与 fan-out；PR #2476 迁移为 registered string + YAML registry validation + `sourceRefsKind` + fail-closed wiring。F236 Track-2 已继承并合入。 | 2026-06-21 |

## User Visibility Disclosure

| Surface | 用户能做什么（达成态） | 用户实际能做什么（本 feat close 时） | 缺失/退化 | 处置 |
|---------|--------------------|--------------------------|----------|------|
| Eval Hub friction view | 在 eval verdict 页面看到 friction rollup 的"建议修复"与"仅引用"分区，理解哪些摩擦可行动、哪些只需回指原 eval 域 | `HubEvalFrictionSections.tsx` 已渲染 actionable/referenceOnly/honest empty state，Phase D PR #2504 merged | 无 | met |
| Eval cat handoff | eval 猫拿到 bounded rollup，不消费 raw 几百条 signal；可按 ①②③ 生成修复草稿 | `friction-rollup-report.ts` 产出 Top-N + tail aggregate + `actionableCandidates`/`followupDraft` | 无 | met |
| 修复出口 | 可行动项可由 eval 猫手动触发 F128 propose_thread；系统不自动乱开 thread | `followupDraft` payload 存在，INV-D5 明确"不自动开 thread"；UI 文案不伪装自动修复 | 无 | met |
| ④ eval-domain 摩擦 | 只列出并链接原 domain verdict，不重复创建修复出口 | `referenceOnly` clusters + `referenceOnlyEvidenceRefs` | 无 | met |
| 周期频率 | 社区 weekly，本家 3 天，可用 N-day cadence 执行 | PR #2483 merged：`every-3d` + Redis last-run gate | 无 | met |

## Vision Guardian Evidence

| operator experience（逐字引用） | 当前实际状态（代码/命令/PR 证据） | 匹配？ |
|----------------------|----------------------------------|--------|
| "这些都特喵散落哪里了" | Phase B 4-channel adapters + `FrictionAggregator` merged in PR #2443 (`0be8b6b5`)，Phase D 在 Eval Hub 汇总展示 | ✅ |
| "③ 用户直接反馈 → 他好像只是搜集了反馈 但是做了 eval 吗？用户到底都反馈了什么？" | `UserFeedbackAdapter` 只读 F222 confirmed issues，进入 friction rollup；Phase D view 展示可行动候选 | ✅ |
| "只靠我看太不靠谱了，有些环境 工具 我也看不懂啊" | eval:friction rollup 做 sensorForm/rootCause 分类，eval cat handoff 输出人话 verdict；operator 不需要手扫 raw 聊天流 | ✅ |
| "其实我们想看的是不是 每周/每3天 这些渠道到底产生了哪些摩擦" | `eval-friction.yaml` + N-day cadence PR #2483 支持本家 `every-3d`，社区可 weekly | ✅ |
| "④各自会修，只需列出"（Phase D 边界） | `referenceOnly` clusters 永远不进修复出口，只链接原 eval verdict；AC-D2 checked | ✅ |

Guardian verdict: opus-47 于 2026-06-22 输出 APPROVE；其核验链包括 Phase D merge、10/10 AC、runtime data flow、UI 真渲染、capability tip seed、BACKLOG cleanup。

## Close Gate Report

```yaml
feature_id: F245
spec_path: docs/features/F245-friction-signal-eval.md
head_sha: eefac7f75  # verified main HEAD before formal close-sync doc patch
report_date: 2026-06-23
close_author: Maine Coon/Maine Coon (@codex, model=gpt-5.5)
guardian: Ragdoll Opus 4.7 (@opus-47, non-author, non-reviewer)
harness_feedback: docs/harness-feedback/reviews/F245-feature-fit-review.md
```

### AC Matrix

**Phase A (PR #2422, squash `9f3f0b862`)**
- AC-A1 ✅ met — `PawFeelAdapter` 回扫 `[爪感差: ...]` marker，输出结构化 `FrictionSignal`；fixture + node:test 覆盖
- AC-A2 ✅ met — marker precision/recall fixture 覆盖含 N 条爪感差与无摩擦消息，PR #2422 cloud findings fixed

**Phase B (PR #2443, squash `0be8b6b5`)**
- AC-B1 ✅ met — paw-feel/cancel/user-feedback/eval-domain 4 adapters 统一消费，只读 canonical sources
- AC-B2 ✅ met — `FrictionAggregator` 幂等 dedup + `FrictionClusterer` rule/embedding fail-open 聚类，误聚合 fixture gate

**Phase C (PR #2458 `1b67516b9`, PR #2469 `ef1d1cca7`, PR #2476 `0822a68b4`, PR #2483 `806527665`)**
- AC-C1 ✅ met — `eval-friction.yaml` enabled + Y-lite registry contract + N-day cadence，本家 `every-3d`
- AC-C2 ✅ met — rollup report producer + live sink：Top-N、tail aggregate、sensorForm/rootCause contract、4-channel provider
- AC-C3 ✅ met — Verdict Handoff schema 复用并 fail-closed；Y-lite migration 补齐 `sourceRefsKind` 与未知 selector 错误码

**Phase D (PR #2504, squash `440d8942d`)**
- AC-D1 ✅ met — ①②③ `actionable_candidate` + `followupDraft` payload，eval cat 手动触发 F128，不自动开 thread
- AC-D2 ✅ met — ④ eval-domain-only clusters `reference_only`，只列出并链接原 verdict
- AC-D3 ✅ met — Eval Hub friction view 渲染"建议修复"/"仅引用"/honest empty state

Summary: 10/10 AC met, 0 unmet, 0 deleted, 0 cvo_signed_off.

### Contract Drift Check

| Contract | Changed by | Surrounding consumers checked | Result |
|----------|------------|-------------------------------|--------|
| `domainId` / `sourceAdapter` | PR #2476 Y-lite migration | registry schema, publish-verdict, eval-cat invocation, F245 eval-friction, F236 eval-anchor-first | ✅ registered string + YAML validation, no future enum-bump |
| `sourceRefsKind` | PR #2476 | `friction-rollup-snapshot`, `anchor-first-rollup-snapshot`, `unsupported_source_refs_kind` guard | ✅ unknown kind fail-closed |
| actionability split | PR #2504 | report producer, Eval Hub projection, UI, eval cat invocation | ✅ ①②③ actionable, ④ reference-only |
| cadence | PR #2483 | eval-domain registry, cron creation, Redis last-run gate, `eval-friction.yaml` | ✅ `every-3d` works without raw weekly pile-up |

## Harness Eval Checkpoint

F245 是 harness-eval feature，本 checkpoint 触发并展开。Feature-fit review: `docs/harness-feedback/reviews/F245-feature-fit-review.md`.

## Reflection Capsule

## Review Gate

- Phase A–D: 跨族 review（Ragdoll author → Maine Coon/Maine Coon or gpt52 review）；架构 Design Gate 拉 harness-eval owner（Maine Coon/47）收敛 cluster 算法 + Map delta + 频率默认值

## Tips Contribution（F244）

- [x] Added tip `feature-f245-friction-eval-rollup` in `packages/web/src/lib/capability-tips.seed.json`（Phase D merge 后补）
