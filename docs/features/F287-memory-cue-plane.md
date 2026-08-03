---
feature_ids: [F287]
related_features: [F200, F209, F221, F231, F256, F260, F263, F276, F281, F282]
topics: [memory, recall, cue-plane, agentic-recall, decision-opportunity, progressive-disclosure]
doc_kind: spec
created: 2026-08-01
tips_exempt: "F287 改变猫的内部记忆线索与召回路径；Phase C 的 opaque drill/outcome MCP 仅消费尚待 Phase D 接线的 CueEnvelope，工具 description 已承载使用时机与安全边界，当前没有可独立教学的用户入口。"
description: "让猫在执行过程的真实判断点想起有用记忆，并以有界线索、按需钻取和可失效消费闭合跨 lane 读侧。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-02T06:20:00Z
---

# F287: Memory Cue Plane（记忆线索与召回闭环）

> **Status**: done | **Completed**: 2026-08-02 | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **Gate**: Architecture Design Gate PASSED — Ragdoll terminal APPROVE；operator 选择 Option A，并授权直接进入单一 F128 execution thread（`0001785585275543-000433-45096643`）。

Architecture cell: memory

Map delta: `update required`

Why: 现有 memory cell 已拥有持久化、索引、检索与生命周期，但还没有声明“执行中记忆线索的机会、路由、预算、消费与失效”边界；F287 扩展该 cell，不新建第二个 MemoryStore。

## Why

家里的记忆写入、索引、人物/品味 lane、反馈回流和主动候选生产已经分别存在，但**“猫正在执行任务时，为什么现在该想起哪类记忆”没有 owner**。结果是：文件写成功却搜不到、搜得到却不在判断时刻出现、各 feature 都完成一段仍拼不成一条可用旅程，甚至完成状态散落后继续显示成未完成。

operator把组织与产品价值说得很直接：

> “Memory Cue Plane（记忆线索层）我建议单独立项，不应该拆散到各个 feat 的 phase 里……不然做了 n 天，某天我们发现记忆系统还有 bug 又没修。”
>
> — source message `0001785576172502-000024-b99b889a`

本 feature 的目标不是再造一个通用 RAG，而是让记忆闭环成为一等系统能力：**猫走到真实判断点 → 获得为什么是现在的有界线索 → 自己决定钻取、使用或忽略 → 纠正/遗忘后线索可靠失效**。operator不需要重复解释，也不需要把猫赶回旧 thread 才能使用历史。

operator 于 `0001785580244904-000093-589e005d` 明确授权先立项，并保留本人和Ragdoll后续内容审阅；本次不主动召唤Ragdoll。

## Current State / 现状基线

审计基线：`origin/main@67868bb4c4fd188ca0f007207fe222fdaead243e`（2026-08-01）。

### 已有能力不是当前缺口

| 能力 | 既有 owner | F287 不重做什么 |
|------|------------|-----------------|
| EvidenceStore、passage、graph、typed drill | F102 / F186 / F209 | 不重建项目知识库或第二套索引总线 |
| Taste / Profile / Entity / Person canonical truth | F221 / F231 / F260 / F276 | 不搬走各 lane 的物化、审批、纠正与遗忘语义 |
| 搜索策略与效用评估 | F256 / F200 | 不把搜索 eval 冒充执行中 cue consumer |
| 生命周期 trace / health | F263 / F153 | 不把 logs/metrics 全塞进 Eval Hub |
| 人类 disposition 反馈 | F281 | 不复制拒因、episode 或 exact-subject 回流契约 |
| 主动发现待登记候选 | F282 | 不把候选生产扩成万能已存记忆 recall |

### 已确认的闭环断点

| 断点 | 证据 | 用户后果 |
|------|------|----------|
| 物化/索引 | Taste vignette 的关键正文位于 YAML；通用 Markdown passage index 会剥离 frontmatter，导航摘要还会截短 | 完整判断已批准，却只召回半条或完全不可达 |
| Query transport | cold-context 通用 recall 只取当前消息前 300 字、最近消息前 200 字 | 长消息后半段的真实任务语义可能从 query 消失 |
| 触发坐标 | 通用 recall 仍偏 turn/query；数小时后的 gate、review、tool result 与初始 query 没有稳定语义桥 | billing-only 这类运行决策在真正需要时想不起来 |
| Lane 不对称 | Entity 有 alias nudge；Person 主要靠主动 tool；Taste/Profile 没有同等级自动 consumer | “存了”不等于猫能感知 |
| 生产噪声 | F282 实际浮现过“App / 而言 / commit / 我希望 / 成本”等高背景频率碎片 | 主动 nudge 污染上下文并消耗人的审批注意力 |
| 消费闭环 | presented / drilled / applied / dismissed 没有统一、无正文的 episode 语义；source correction 又与消费结果混在一起 | 无法判断线索有用、无用，还是底层记忆已经被纠正/失效 |
| 状态投影 | F281 全部 AC 与代码已落，feature 仍为 `in-progress`，BACKLOG 仍写 `spec`；旧 task 仍出现在本 thread | 子系统完成后整体仍像永久半成品 |

因此当前不是“缺一条更长 prompt”，而是生产质量、可检索性、触发、lane 路由、消费与 lifecycle truth 六处没有由同一个用户旅程闭合。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | Memory Cue Plane 独立立项，不拆散回旧 feature | AC-A1, AC-A3 | source map + 单一 Phase 账本 | [x] |
| R2 | 一个 owner / 指挥 thread 顺序闭环，避免三条线做散后失忆 | AC-A2, AC-E4 | thread/task/truth audit | [x] |
| R3 | 不能按原始 query 做每轮全库 top-k，也不能把整库塞进 prompt | AC-C1, AC-C3 | contract negative fixtures | [x] |
| R4 | F221、长消息 recall、F282 垃圾词、F276 UAT 先成为真实可用前置 | AC-B1..AC-B4 | RED→GREEN + real UAT | [x] |
| R5 | 人物、运行先例、Taste 三种记忆按不同机制被想起 | AC-D1..AC-D3 | three golden journeys | [x] |
| R6 | 猫能 drill/use/ignore；纠正、遗忘、越权后 cue fail closed | AC-C4, AC-E1, AC-E2 | lifecycle fixtures + UAT | [x] |
| R7 | 不把完成状态散落成永久半成品 | AC-A2, AC-E4 | feature/BACKLOG/task/cell parity check | [x] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有非作者可复核的测试、证据包或真实 UAT。
- [x] 第一版无新增用户 UI；若后续出现可见 surface，Design Gate 补需求→截图/录屏映射。

## What

### Phase A: Memory Census + Truth Reset

- 固化各 lane 的 canonical truth、materialization、index、cue consumer、drill、correction/forget、main/live/UAT 状态矩阵。
- 收口 F281/F282 等已完成能力的 feature/BACKLOG/task 投影漂移。
- 给每个旧 feature 写清“它提供什么”和“F287 只消费什么”，防止 Cue Plane 偷走 lane ownership。
- 本 thread 是立项与指挥真相源；不另开三个平级长期开发 thread。确需独立实现载体时，仍由本 thread 记录 Phase 边界与终态证据。

### Phase B: Recall Readiness Slices

在统一 Phase 内顺序闭合四个已证实的前置断点；canonical 语义仍归对应 feature owner，F287 持有集成完成判据：

1. F221 approved Taste vignette 真正可检索、可 drill，private scope fail closed。
2. cold-context query transport 对 typed owner message 使用可证明覆盖的 bounded input，不再 prefix-only 丢失后半任务语义。
3. F282 lane-neutral detector 加入背景频率/近期突增与确定性噪声门，保留 Alden 与单次重要机会。
4. F276 完成“有信息人物卡 approve → recall → correct → forget”的真实 owner UAT；不以历史 rejected Alden 卡冒充成功。

AC-B2 已发现三文件并行 WIP（`context-transport.ts`、`route-helpers.ts`、`f148-context-transport.test.js`），来源为 F263 thread message `0001785555680310-001610-7225e1a1`。F287 已通过 cross-thread message `0001785582525286-000172-7b2b3f29` 核验并冻结边界：Design Gate 不触碰代码；进入实现时先消费/修订该 patch，不平行重写。

### Phase C: Cue Plane Contract

定义一个 projection/orchestration 协议，不增加新的 canonical memory store：

- `RecallOpportunity`: 只能由封闭、版本化的 `RecallOpportunityCatalog` 从既有 typed lifecycle event / predicate 产生；字段包含 consumer、execution phase、typed evidence state、candidate action、owner scope 与 why-now provenance。未知事件返回零 cue，禁止自由文本 intent classifier 或 LLM 判断“这是不是判断点”。
- lane resolver：Person/Entity、operational precedent、Taste、Profile、project knowledge 各自选择确定性或有界检索；不做一把全库尺。
- operational precedent：作为既有 lessons / runbook / decision / canon 的 typed projection，不新建 canonical memory lane；具体来源按自身语义落盘，Cue Plane 只负责在已声明的 decision frame 中投影。
- `CueEnvelope`: lane、whyNow、短目录/摘要、source coordinate、drill handle、scope、expiry、invalidator；不得直接替猫下结论。
- budget / dedupe / expiry：零 cue 是一等结果；同 invocation/session 去重；预算由 consumer 与 lane 声明。
- correction / forget invalidation：删除、失效、越权、未知 lineage 一律不再投影。
- consumption episode：只记录 presented / drilled / applied / dismissed 等枚举与坐标，不记录猫的私密推理正文。
- source invalidation：`source_corrected / source_forgotten / scope_revoked / superseded / expired` 与 consumption outcome 分离；用户纠正 cue 时由 F281/原 lane 改正 canonical truth，再使旧 cue 失效，不把 `corrected` 伪装成消费结果。

### Phase D: Three Golden Vertical Slices

1. **Person / Alden**：当前 thread 出现人物名 → exact alias/subject resolution → 有信息 relationship cue → drill owner-visible 历史 → 猫自主使用；无同名误绑定。
2. **Operational precedent / billing-only**：review、gate、外部 zero-step billing failure 与 candidate action 组成 typed decision frame → 从既有 operational evidence projection 取得运行先例 cue → 已闭合证据下不做表演性等待。该 journey 依赖 Design Gate 对 OQ-2 的价值边界签字，不以误放 Taste 的旧文件冒充 canonical lane。
3. **Taste map**：猫进入一个真实设计/写作/review 判断面 → 只出现相关品味维度地图 → 猫自行 drill vignette；系统不自动挑一条 Taste 当结论。

### Phase E: Integrated UAT + Lifecycle Close

- 三条 journey 在 alpha/授权 runtime 分别验证 `main=landed`、`live=loaded` 与 UAT，不互相冒充。
- 验证 private scope、cross-owner fail closed、forget 后零 cue、无关事件零污染、预算和去重。
- 形成 keep/tune/sunset verdict；同步 feature、BACKLOG、task、ownership cell、discussion 与完成索引。

## User Journey

### Primary Journey: 猫在真正需要时想起，而不是等人重复

- **Scope unit**: owner × invocation decision opportunity
- **Actor**: operator + 当前执行任务的猫
- **Entry**: 猫在一个持续任务中到达人物识别、运行处置或质量判断边界
- **Flow**:
  1. operator只提出当前任务；几分钟或几小时后，工具结果/工作流状态/当前候选动作形成新的判断现场。
  2. 对应 consumer 产生带 provenance 的 `RecallOpportunity`；Cue Plane 只查询合法 lane，并允许返回零条。
  3. 猫看到一个短 `CueEnvelope`，知道“为什么现在出现”、来自哪里、能否 drill；不会收到整个记忆库或系统替它挑好的结论。
  4. 猫选择 drill / 使用 / 忽略；如果operator纠正或忘记该记忆，后续 cue 立即按 invalidator fail closed。
  5. operator无需回旧 thread、复制原话或再次解释“你为什么没想起来”。
- **Success evidence**: 三条 golden journey 的 alpha/授权 runtime 证据包（prompt segment / source drill / lifecycle outcome；敏感正文不进公共证据）
- **Non-goals**: 不承诺第一版覆盖所有 consumer；不做每 turn 全库 top-k；不全量注入 MEMORY.md/Taste；不训练小模型替猫判断重要性；不新建第二个 MemoryStore。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | subject | 猫猫 | `Alden` 出现 → exact relationship cue → drill 真实历史 → 使用/忽略 | typed fixture + owner UAT |
| S2 | decision episode | 猫猫 | zero-step billing failure → operational precedent cue → 交付判断 | replay fixture + gate outcome |
| S3 | judgment surface | 猫猫 | design/review → Taste dimension map → drill vignette | negative pollution fixture + UAT |
| S4 | memory lifecycle | operator | 纠正/forget → 同一机会重放 → 零旧 cue | deletion/invalidation fixture |

## Acceptance Criteria

<!-- 每条 AC 均 trace 回 Why 的“整体旅程闭环 + 单一真相 + 不污染”诉求；完成必须由非作者可复核证据证明。 -->

### Phase A（Census + Truth Reset）

- [x] AC-A1: memory source map 覆盖 F102/F152/F186/F188/F200/F209/F221/F231/F256/F260/F263/F271/F276/F281/F282，逐项记录 canonical truth、consumer、cue path、drill、forget、main/live/UAT 与 owner；非作者能从代码/spec/commit 复核。
- [x] AC-A2: F281/F282 的 feature、BACKLOG、completed index 与当前 thread task 投影对齐；不得把 all-AC-checked 的 feature继续展示为 `spec`。
  operator Hub settlement completed for exact owner-bound tasks `0001785409801656-000018-8eb3356f` and `0001785409804908-000019-47e814aa`; authoritative readback is `done/done`（`0001785593462801-000757-ad289215`）。
- [x] AC-A3: F287 spec、BACKLOG、当前 command thread 与唯一 persistent task 互相链接；同一 Phase 不创建三个平级长期执行 thread。

### Phase B（Recall Readiness）

- [x] AC-B1: approved Taste vignette 在其合法 public/private scope 内以完整 decision payload 被精确检索并 drill；frontmatter-only 与截短目录 fixture 先红后绿，跨 owner/private 负向保持 fail closed。
  Phase B tests 覆盖 public/private owner、path/symlink/revision guards、完整 decision payload 与 `INDEXING_VERSION=11` rebuild；billing-only precedent 只经 lesson source 命中，零 Taste hit。
- [x] AC-B2: cold-context transport 的 RED fixture 把关键语义放在长 owner message 后半段并证明旧 prefix-only query 丢失；GREEN 在保留引用/安全边界下召回目标，且不依赖 L0 staging 顺序猜测。
  已消费 SHA-256 `41f8b397384c6ce78913ee881cb5e5d3c543e6060797fe4f0bc1b15f61437f86` 的 F263 frozen patch；`stripStructuralEnvelope` 只移除 typed structural envelope，保留 quoted / non-L0 owner semantics。F263 terminal release 已发送。
- [x] AC-B3: F282 frozen cohort 同时包含 Alden、单次重要人物、中文高频碎片、代码词与一般名词；约束向量证明 relevant coverage 不塌、irrelevant/审批负担下降，统计层仍不判断 lane/重要性。
  Frozen replay verdict：detector relevant `4/5`、single-important judgment `2/3`、irrelevant `0/4`、attention vector `[1,0,0,0,0,0,3]`；frequency remains a content-free, lane-neutral opportunity signal，不成为 lane/importance verdict。
- [x] AC-B4: F276 真实 owner UAT 产出有身份/关系/互动信息的卡，approve 后可 recall，correct 后更新，forget 后不可召回；历史 rejected Alden proposal 不计通过。
  Alpha v4 candidate `person_candidate_8eeef98bc6efdd8a6117e1ae` materialize 后，消息 `0001785601744375-000001-a0f73ee4` 证明 `resolved → applied → resolved → purged → not_available`；fresh invocation `0001785601829128-000003-f5b79014` 再次得到 `not_available`。这验证 main 已加载的 F276 lifecycle；Phase B implementation 已由 PR #3366 落到 main，但未获 runtime activation 授权，故 `main=landed`、`live=dormant`、既有 F276 UAT 不混报。

### Phase C（Cue Contract）

- [x] AC-C1: shared contract 明确 `RecallOpportunity` 与 `CueEnvelope` 的 typed 字段、producer/consumer、server-bound scope、source drill、expiry/invalidator；raw user query 不是 universal required key。
- [x] AC-C2: lane resolver registry 至少覆盖 person/entity、operational precedent、Taste、Profile、project knowledge，且每 lane 声明 retrieval contract 与零结果语义；没有 global cross-lane score。
- [x] AC-C3: deterministic negative fixtures 锁住：每 turn 全库 top-k、whole-library prompt dump、future trigger-tag requirement、自动单条 Taste 结论选择均不可进入第一版路径。
- [x] AC-C4: budget/dedupe/expiry 与 correction/forget/cross-owner invalidation 有 contract tests；unknown/deleted/unauthorized source 投影为零 cue。
- [x] AC-C5: consumption episode 只保存 `presented / drilled / applied / dismissed`、坐标、版本与 outcome，不保存私密推理正文；source correction/forget 使用独立 invalidation reason；TTL=0/deletion closure 与每个 canonical lane 的政策一致。
- [x] AC-C6: `RecallOpportunityCatalog` 是封闭、版本化的 typed predicate catalog；每个 entry 声明 producer、payload schema、scope binding、resolver family、dedupe/expiry 与负向 fixture。自由文本 intent classifier、LLM opportunity judge、未知事件均确定性地产生零 cue。

Phase C landed evidence: PR #3367 merge `7ad6043386ad58afc6d87ea8985cd42b9654b58c` 将 strict shared union/catalog、five-family registry、zero-only admission、bounded prompt/dedupe/expiry、SQLite V37 content-free append-only ledger、exact retry/two-connection WAL race，以及 owner-authenticated lifecycle callbacks + MCP parity 一并落到 main。句柄以 process-lifecycle key 做 AES-256-GCM authenticated encryption：不新增 handle store，API restart 后旧 handle fail closed；只有签名有效且 scope 相同的过期 handle 才落 `expired` invalidation，无法认证的旧/篡改 handle 不生成可伪造事件。`presented` 在 whole-cue 进入 assembled prompt 后，以 deterministic cue/invocation key 写入；never-presented 与已 invalidated 的新 outcome 均拒绝，失效前已成功 outcome 的 exact retry 保持幂等但不复活 cue。

Executable evidence: shared contract **11/11**；API catalog/registry/plane/schema/episode/callback **25/25**；MCP lifecycle + registration/toolset **32/32**；API、shared、MCP TypeScript builds 均 PASS。Kimi 对 parent implementation 与 V37 legacy-test semantic delta 分别 APPROVE（`0001785609724241-001208-9c3017fc`、`0001785609866099-001219-d0ce61e9`）；最终 9-commit latest-main rebase 的 `git range-diff` 为 9/9 `=`，final HEAD `d0540e53057746e1b4927b0108d9ec486f23b6c2` 的 Brand Boundary Guard 通过，semantic-identical HEAD `93d5e64150c5f04973335b5f3bbf02670b1f90e9` 的 full `pnpm gate` exit 0。代码 `main=landed`、`live=dormant`；未执行 runtime sync/restart/activation，尚无 Phase C live/UAT claim。

### Phase D（Golden Slices）

- [x] AC-D1: Alden journey 在当前 thread 触发 exact person cue，可 drill 其他 owner-visible thread 的真实 identity/interaction source；同名、跨 owner、猫写来源、deleted source 均不注入。
- [x] AC-D2: billing-only replay 仅在 delivery decision frame 到场，不在任务开场 query 或无关 gate 注入；cue 包含完整运行先例与 whyNow，consumer 能作 keep/tune/sunset 判断。
- [x] AC-D3: Taste journey 只投影相关维度地图与 drill handle；自动选具体 vignette/结论的负向 fixture 为零，猫主动 drill 后可读完整已批准内容。

Phase D landed evidence: PR #3372 merge `f9d0116f9be0c2eaa612bf907c0106bd38f96deb` 将 person、operational precedent 与 Taste 三条 frozen journey 接入真实 serial/parallel、connector/queue 与 source/drill 装配路径；同实体 legacy nudge 仅在 cue admitted 后抑制，GitHub billing 四元组绑定同一 check run/job 且 partial/prose/extra spoof 为零，judgment surface 仅接受 human explicit tag 或 typed workflow override。Kimi 对 final exact HEAD `6e432d8de8040c7d87ad735fe4f14c6e574eb4c6` 的 semantic-delta review APPROVE（`0001785634849243-000197-48d01e1c`），无 P1/P2，独立 overlap 244/244 + shared 12/12；latest-main full `pnpm gate` 全绿。代码 `main=landed`、`live=dormant`；真实 integrated UAT 仍属于 Phase E。

### Phase E（Integrated UAT + Close）

- [x] AC-E1: 三条 journey 各有 `main=landed`、`live=loaded`、真实 UAT 的分离证据；不得用 unit test、旧 runtime 或历史卡片冒充在线闭环。
- [x] AC-E2: forget/correction、cross-owner/private、无关机会、重复 opportunity 与 cue budget 的正负向矩阵全部通过。
- [x] AC-E3: Eval 出生证产出 per-cue-family keep/tune/sunset verdict；运行耗时、drop、dedupe 与错误率留在 F153 observability，不冒充 utility verdict。
- [x] AC-E4: feature、BACKLOG、task、ownership cell、discussion、completed index 与 thread 状态同一次关闭迁移完成；无 orphan task 或“代码 done / 文档 spec”漂移。

Phase E close evidence: PR #3376 merge `e5ead065143bb0fe6fdf997b088ee8240cf9d2c8` 落地三份 metric birth certificate、byte-identical replay 与 content-free lifecycle hardening；PR #3381 merge `7831df17a281df21e0da78b959428c5ca5c1e594` 保证 trusted Billing carrier 在 Redis direct/queued 两条路径同 contract；真实 canonical LL-098 + opaque handle Alpha UAT 暴露 300-token family budget drop 后，PR #3383 merge `1a8b4012e8282de2005c3d0649f58a38e22ce058` 只把 operational precedent budget 调到 420，并保留 person/taste=300 与 737-token whole-cue drop。Alpha HEAD `cf9980b595168dbb5b64250c2e48022ba3ad27cd` 包含上述 merge，3011/3012/4111/6398 健康；Person、Taste、Operational 三条 owner-authenticated journey 与负向矩阵见 `docs/features/evidence/F287/README.md`。三个 family verdict 均为 `keep`，无 aggregate score；production 未重启、未验证。

## Dependencies

- **Evolved from**: F209（Evidence Recall 提供检索与 drill 底座，但不拥有执行中 cue）。
- **Evolved from**: F281 / F282（有界反馈回流与 proactive producer 暴露“写侧完成、通用读侧无人拥有”的边界）。
- **Related**: F221 / F231 / F260 / F276（canonical memory lanes）。
- **Related**: F200 / F263（效用 verdict 与 lifecycle telemetry consumers）。
- **Related**: F256（猫主动搜索策略；保留为 cue 漏召回时的 pull 防线）。
- **Blocked by**: none at kickoff；Phase B readiness slices 是 F287 自身顺序交付，不把整个 feature 挂起等待旧 feature 全部完成。

## Mechanism Selection

| Claim | 选中机制 | 验证证据 / consumer |
|-------|----------|---------------------|
| typed opportunity、scope、budget、invalidation 必须确定 | test / schema / guard | contract fixtures + merge gate |
| prefix-only、frontmatter-only、跨 owner 与 forget 是确定性回归 | TDD | named RED→GREEN fixtures |
| cue latency、resolver drop、dedupe、error 是运行健康 | F153 logs / metrics / traces | runtime operator diagnosis；默认不进 Eval Hub |
| 何种 opportunity / resolver / budget 对用户有用且不污染 | eval-design | F287 owner + operator 对每个 cue family 做 keep/tune/sunset |
| 猫看到地图后如何判断、何时 drill | convention / skill | consumer-specific skill/L0 入口；不把判断下放给统计层 |

## Eval / Tracking Contract（Design Gate 草案）

- **utility_claim**: 在真实判断点出现的有界 cue 能减少“已经记录但猫没想起”，同时不显著增加无关上下文与人类纠正负担。
- **estimator**: 三条 frozen golden journey + per-family exposure/presented/drilled/applied/dismissed 与 source-invalidation 约束向量；不合成总分、不用接受率做猫 KPI。
- **validity_bounds**: 第一版只覆盖已声明 consumer 与三种 cue family；不得外推到所有任务、所有 Taste 或全局人格行为。样本量与人工 adjudication 在 Design Gate 冻结。
- **consumer**: F287 owner 与 operator 分 cue family 决定 keep / tune / sunset；lane owner只消费与其 canonical truth 相关的缺陷证据。
- **calibration_plan**: 先用 Alden、billing-only、Taste map 人工标注 fixture 校准 opportunity 与污染边界，再看 live episodes；不得用历史聊天 acceptance 代替 ground truth。
- **repeatability_contract**: 固定输入事件、canonical store snapshot、resolver version、prompt budget 与 expected cue/no-cue outcome，可在 isolated Redis 6398 重放。

## Risk

| 风险 | 缓解 |
|------|------|
| 把 Cue Plane 做成另一套万能 RAG | KD-2/3 + AC-C2/C3：consumer-bound、lane-specific、零 cue 一等、无 global score |
| opportunity 入口长成第二个 intent classifier | KD-8 + AC-C6：只消费封闭 typed predicate catalog；未知/自由文本/LLM 判断一律零 cue |
| 新 control plane 偷走 lane ownership | 只存 projection/episode；canonical truth、correction、forget 仍归各 lane；memory cell 更新写明边界 |
| Taste 被系统替猫下结论 | 只投影维度地图；具体 vignette 由猫 drill；自动单条结论为负向 fixture |
| 写入时预测未来 trigger 重演 W7 违规 | opportunity 在使用时由当前执行状态出生，不要求 author 手工标未来关键词 |
| F282 降噪同时杀掉 Alden/单次重要机会 | frozen positive/negative cohort + coverage/irrelevant/burden 约束向量，不优化一个 precision 数字 |
| telemetry 洪水或隐私泄漏 | content-free episode、per-family budget、owner scope、敏感正文不入公共证据 |
| feature 又被拆散后无人收口 | 一个 command thread、顺序 Phase、每 Phase 同步 merge SHA + AC truth + journey evidence |
| 架构先验过早冻结 | kickoff 只写 contracts/否决边界；resolver API、Taste 触发面与 operational lane 仍留 Design Gate OQ |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 分配 F287，而不是把缺口拆回 F221/F276/F282 各自 Phase | 现有 feature 分别拥有 lane/producer，但没有一个拥有跨 lane 的执行中用户旅程与关闭真相 | 2026-08-01 |
| KD-2 | recall key 绑定当前 consumer + execution decision state；原始 query 只能是弱证据，不能是万能钥匙 | 跨数小时任务的真实判断点与开场 query 常无语义桥；query-RAG 会漏 recall 或制造噪音 | 2026-08-01 |
| KD-3 | 不做每 turn 跨 lane 全库 top-k；resolver 按 lane 分治并允许零 cue | Person alias、运行状态、Taste 开放判断的键类型不同，强行统一分数会把系统判断伪装成检索 | 2026-08-01 |
| KD-4 | 写入时不要求未来 trigger tags | 未来使用情境不可穷举；W7 要求知识涌现由系统能力承担，不把标注负担转给人/猫 | 2026-08-01 |
| KD-5 | Taste 只给地图与 drill，不自动选择单条结论 | Taste 的适用性常在猫即将产出的内容里才出现；自动选择会缩窄品味并污染判断 | 2026-08-01 |
| KD-6 | Cue Plane 是 projection/orchestration，不是第二个 MemoryStore | 单一真相仍在 lane；线索可重建、可失效，避免双写与删除不闭合 | 2026-08-01 |
| KD-7 | 一个 command thread 顺序推进 Phase；旧 feature 只登记 dependency delta | 解决“每块做过、整体仍不可用且状态漂移”的已发生 failure mode | 2026-08-01 |
| KD-8 | opportunity 产生必须来自封闭、版本化的 typed predicate catalog；禁止语义 intent classifier / LLM opportunity judge | 判断点必须是可验证的现有执行状态，不让“统计不判断”从入口旁路失效 | 2026-08-01 |
| KD-9 | cue consumption outcome 与 canonical source correction/invalidation 分轴 | `corrected` 不能同时表示“猫被纠正”和“记忆被修订”；分轴才能闭合 F281 与 lane lifecycle | 2026-08-01 |

## Review Gate

- Kickoff: 已落地；operator 已亲自阅读并邀请Ragdoll完成非作者架构内容审阅。
- Design Gate: **PASSED**。非作者 terminal APPROVE + operator Option A signoff 已齐；允许进入 implementation plan/worktree。
- Implementation: **PASSED**。Phase A-E 均有 main merge、Kimi 非作者 exact-head review、风险匹配测试/gate 与 journey evidence。

## Tips Contribution（F244）

`tips_exempt: F287 改变猫的内部记忆线索与召回路径；kickoff 不新增用户可直接操作或发现的产品入口。`
