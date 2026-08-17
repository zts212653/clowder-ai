---
title: "Context Injection & Standing Reflex Source Map"
doc_kind: architecture
feature_ids: [F065, F148, F203, F225, F229, F237, F254, F260, F276, F281, F282, F287, F296]
related_features: [F041, F070, F091, F093, F155, F163, F167, F193, F247]
topics: [prompt-injection, context, standing-reflex, source-map, lifecycle, continuity, memory]
created: 2026-08-15
updated: 2026-08-15
status: census-v0.2
author: "小太阳·Maine Coon/GPT-5.6 Sol"
description: "运行时代码实查的 model-facing 注入面全图：区分身份、证据运输、状态投影、控制门与 standing reflex，并逐面记录触发、权力、预算、去重、失效、观测和 owner。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-15T13:04:00Z
---

# Context Injection & Standing Reflex Source Map

> **W0-B census v0.2；原始代码基线 `main@587320cf5`，Wave 1 字段审计 2026-08-15 回流。**
> 本文回答“哪些系统内容会在模型
> 工作时出现、为什么出现、谁有权让它重发或消失”。它不是一份“把所有条目补进中央
> registry”的 implementation plan。F296 的 carrier/cold-hot/compaction 能力由已合入的
> W0-E census (internal)
> 独立摸底；本文只登记其交界面。

## 1. 先划边界：进入模型视野，不等于 standing reflex

纳入 census 的对象是：**不是当前人类正文，却由 Clowder AI、provider 或 harness 主动放进模型
工作上下文的内容**。它们按权力分五类：

| 类别 | 回答的问题 | 例子 | 是否 Standing Reflex |
|---|---|---|---|
| constitution / identity | 我是谁、有哪些不可越界规则 | native L0、static identity、ADR-038 staging | 通常不是；其中少数家规级行为反射可编译到此 |
| evidence transport | 这轮有哪些原始消息、附件或可回源坐标 | N2 history delta、current message、content attachment | 否；只运输证据 |
| state projection | 当前世界/任务/提案状态是什么 | navigation、F276 proposal status、Session Bootstrap | 否；不得偷偷变成行动命令 |
| control gate | 这轮必须满足什么确定协议 | F167 stop gate、F225 context warning | 否；属于契约 guard 或健康提示 |
| opportunity / reflex | 某个机械事实是否值得把一次判断机会送给猫 | F287 RecallOpportunity、目标 WriteOpportunity | **是候选**；必须有 owner、consumer、预算、失效和 terminal disposition |

不把普通工具 schema、猫主动调用后返回的一般 tool result、当前用户原文、模型自己先前的普通
回复算作 standing reflex。provider-native freshness notice 是例外：它虽经 tool/event carrier 到达，
却由系统主动生成，故纳入。图片路径和 `<context_attachments>` 记为 evidence transport，不获得
独立认知权力。

## 2. 真实组装顺序

当前没有一个函数拥有最终 prompt。route 层先成形，invocation 层再包裹，provider/harness 还可在
其外增加 native context：

```text
provider / harness plane
  native developer/system instructions · AGENTS/skills · external hooks
  provider-native freshness / continuity carrier
                    │
                    ▼
invoke-single-cat effectivePrompt（外 → 内）
  ADR-038 staging（每轮）
  → F225 context-management hint（有 pending warn 时一次）
  → static identity / pack-only（新 session、reinject、registry revision 变化）
  → F070 mission prefix（外部项目 dispatch）
  → route prompt
       invocation context（D* + N1 + F276 + guide/world/signal/always-on/concierge duty）
       → mode prompt R1/R2 → B1 bootstrap → C1 MCP fallback
       → N2 history/current message/evidence transport
       → F229 concierge search table
       → F260/F282/F281 nudge projections
       → F167 structured stop gate（serial only）
  → F287 admitted cue prompt additions
  → M2 transcript path hints（尾部）
```

因此，`buildInvocationContext()` 或 F237 的 route trace 都不是 delivered prompt 的单一真相源。
最终字符串可由 debug prompt capture 看到；native provider channel 与中途 event notice 仍须另记。

## 3. F237 两代现状：旧 baseline 与已运行的 Phase 2 partial catalog

### 3.1 旧清单：52 个已登记 baseline

`assets/prompt-injection-manifest.yaml` 是 **display-only manifest**，不被 runtime builder 读取。
它仍是旧面盘点的好索引，本文不复制 52 行内容，而按真实生命周期登记：

| IDs | 数量 | 运行面 | source / owner | 当前生命周期能力 |
|---|---:|---|---|---|
| L1–L7 | 7 | native L0 compile | `assets/prompt-templates/l*.md` / F203 | native channel；按 L0 编译与 budget guard 管理 |
| S1–S13 | 13 | static/session identity | templates + `SystemPromptBuilder.ts` | 新 session/reinject；3 个 local overlay，其余只读 |
| D1–D21 | 21 | per-turn invocation context | templates + `SystemPromptBuilder.ts` | 条件式；无统一逐项 budget/dedupe/expiry |
| R1–R2 | 2 | mode prompt | serial/parallel route | 按 route mode；无独立生命周期账 |
| M1–M2 | 2 | mission / transcript transport | `invoke-single-cat.ts` | M1 条件 prefix；M2 每轮尾部追加 |
| B1 | 1 | Session #2+ bootstrap | `SessionBootstrap.ts` / F065 | hard cap 2000 tokens；分段降级；session chain 触发 |
| C1 | 1 | MCP fallback | `McpPromptInjector.ts` / F041 | MCP 不可用时注入；有 local overlay |
| N1–N2 | 2 | navigation / history delta | navigation + route helpers / F148 | N2 有 cursor+budget；N1 每轮重算但无 version dedupe |
| H1–H3 | 3 | Claude external hooks | `.claude/hooks/user-level/` | 不走 Clowder AI content pipeline；H3 不进 model prompt |

#### Manifest drift guard 的真实能力

`scripts/check-manifest-drift.mjs` 只扫描 **manifest 已列出的 `.ts` source** 与
`SystemPromptBuilder.ts` 中的 `@segment ID`，能发现“已登记 ID 少了 annotation”或“被扫描文件里多了
annotation”。它不能发现：

- 新代码没有写 `@segment`；
- 新 source file 从未进入 manifest；
- route trace 之后追加的内容；
- provider-native、external harness 或 tool-response carrier；
- 同一语义经两个 carrier 重复送达。

所以 `52/52 aligned` 只证明旧登记内部自洽，不证明 current runtime surface 完整。

### 3.2 Phase 2 已在运行，不是 greenfield

F237 后续已经从单体 YAML 向 **per-hook canonical manifest + generated read-only catalog** 迁移：

| 已有部件 | 代码事实 | 已经证明什么 | 仍不能证明什么 |
|---|---|---|---|
| 46 个 `assets/prompt-hooks/*/hook.yaml` | 每项含 `id/name/stage/order/version/enabled/template/resolver/inputs/disableable` 与 safety/transparency/governance 分类 | 注入条目可以由 owner-near manifest 描述并按 stage/order 校验 | 这些字段足以表达 standing reflex 生命周期 |
| `HookRegistry` | 扫描、解析、校验并注册 per-hook YAML | 可从联邦条目生成统一只读目录，无需复制 canonical 状态 | 所有 provider/carrier 都受同一 registry 控制 |
| `PipelinePromptBuilder` + `SystemPromptBuilder` | 传统 `buildStaticIdentity()` / `buildInvocationContext()` 已是 pipeline-backed thin wrapper | 当前 **S*** 与 **D*** 两块 production prompt 已从 HookRegistry 构建 | 46 个 hook 已由一条 pipeline 全量送达；当前 wrapper 仍分别只输出 S* / D* |
| `/api/prompt-injection/manifest` | live scan HookRegistry，并补 N2/M1/M2/H* 等 supplemental display segments | Console 的 aggregate view 已从旧单体 YAML 迁到生成视图 | aggregate view 等于最终 delivered prompt |
| `InjectionTraceStore` + trace collector | 持久化被 scope 后实际 delivered 的 S*/D* pipeline event/patch | delivered trace 已有早期运行抓手 | route 后追加、invocation 外包裹、provider-native notice 已全覆盖 |

边界必须说准确：L/B/C/R/N 虽已有 hook manifest，legacy wrapper 的 scoped filter 不会把它们随
S*/D* 一起交付；各自原有 lifecycle 仍在迁移期继续拥有送达。F229 concierge duty 甚至仍在
`PipelinePromptBuilder` 内手工 splice。所以下文 11 个 delta 不是“F237 不存在”，而是 **F237
partial catalog 尚未覆盖这些独立 lifecycle 的最终送达与 Standing Reflex 合同**。

### 3.3 Wave 1 字段覆盖审计（已完成）

现有 `hook.yaml` 适合 identity/prompt assembly，但 standing reflex 还需要回答另一组问题：

| 当前已有 | reflex candidate 仍缺 |
|---|---|
| identity、stage/order、version/enabled、template/resolver/inputs | owner cell、consumer、eligible destination lanes |
| safety/transparency/governance、disableable、user explanation | source coordinates、mechanical predicate revision、epistemic ceiling |
| generated manifest view + S*/D* trace | typed disposition、immediate/deferred terminal、per-entry budget、dedupe、expiry/re-arm |
| template/resolver ownership 形态 | ACL/invalidator、health/burden、sunset owner |

审计结论已冻结进
[Memory Standing Reflex Contract v1](./memory-standing-reflex-contract.md)：这不是要求 46 个
identity/history/control hook 全部长成 reflex schema。只有 opportunity/reflex candidate 需要补齐
entry 字段；canonical truth 保持 per-lane owner，统一面是 generated read-only catalog。不得把非
reflex 条目强塞进同一权力模型，也不得绕过 F237 先例重建第二套 greenfield registry。

## 4. 2026-08-15：11 个运行面 delta + 1 个目标边界

下表是旧 52 项之外，或虽借旧 segment 外壳但拥有独立 owner/生命周期、必须单独治理的现行面。
`—` 表示不是“实现忘了填”，而是当前没有这层能力。

| Surface | 类别 / 触发 | producer → consumer / 权力 | budget · dedupe · expiry | invalidator / owner | 现状 verdict |
|---|---|---|---|---|---|
| ADR-038 L0 Staging | constitution；所有已知猫每轮 | `l0-staging-content.md` → 全猫；教行为，不判场景 | 6 shared items，约 698/2000 tokens；整段每轮；process cache | 手工增删/operator signoff；ADR-038 owner | **账本最好、runtime 最粗**：有出生证/预算，尚无 per-entry selection、触发率 telemetry 或 hot reload |
| F225 context hint | control/health；上一轮 warn 后 | context health → 当前猫；只要求自检 | take-once；无正文持久化 | 被 `takeContextHintPrefix` 消费；F225 | 一次性失效清楚；不是 memory/reflex |
| F276 proposal status | state；最近 200 条有 typed card，或像状态询问 | owner-private store → 当前猫；只覆盖历史卡状态 | 最多 8 proposals；每轮 bounded discovery；无 token cap/epoch dedupe/expiry | canonical candidate revision；F276 | freshness 强、scope 粗：旧 proposal 仍可因“最近出现过”在无关 query 重复占位 |
| F229 concierge duty | constitution/role；concierge thread + config | concierge config → duty cat；限定岗位/工具/动作 | 大段每轮；无独立 token cap/dedupe/expiry | thread kind/config；F229 | 没有 manifest/trace identity；与普通 D* 混在 invocation context |
| F229 search handles | state/evidence；concierge query 有结果 | hybrid search → duty cat；结果只获本轮 R-handle 权力 | max 10；per-invocation handle digest；turn 后自然失效 | 当前 handle table；F229 | 生命周期较强，但在 route trace 之后追加 |
| F260 entity nudge / legacy fallback | recall opportunity 前身；human input 命中已登记实体 | mechanical alias detector → F287，失败时 legacy prompt | delivery cap 3；thread×entity 24h cooldown；persistent event 可补 restart continuity | entity revision/retire + cooldown；F260 | typed source 坐标较强；同时存在 Cue Plane 与 legacy fallback 两条呈现路径 |
| F287 Memory Cue | **RecallOpportunity**；closed catalog 的 typed seed | F260/GitHub CI/workflow SOP → current invocation | 每类 max 1 cue；300/420 tokens；invocation dedupe；5/30min expiry | source revision/scope/forget；F287 + lane owner | 当前最完整的 opportunity 出生证；在 `invoke-single-cat` 追加，F237 route trace 看不到 |
| F282 proactive candidate | write-side candidate；公开 workspace 机械重复命中 | detector+registry resolve → 猫做 lane judgment；频率不等于重要性 | per-turn cap 来自 config；window receipt；2min claim lease；window-end suppression | receipt/window + registry state；F282 | 有坐标、去重和 telemetry；**还没有全局 WriteOpportunity/disposition contract** |
| F281 disposition feedback | state/correction；direct-owner input 可证明 exact subject | disposition ledger → 当前 subject；只能定向纠偏 | 最多 3 roots；每 root 100 entries / scan 500；无显式 token cap | source supersession + exact subject proof；F281 | fail-closed、权力窄；route trace 看不到 |
| F167 structured stop gate | control gate；typed hold/dispatch custody 尚无状态迁移 | custody projection → holder；强制结构化 terminal action | 每个 protocol wake；由 projection state 去重 | verified transition / projection close；F167 | 确定契约，合理强权；只在 serial route 拼入，不能被误归为一般 reflex |
| F254 freshness notice | event attention；invoke 中出现 unseen frontier | broker/tool-response service → running cat；只说“有未读” | provider frontier/dedup key；tool notice 每 invocation 最多 3；content-free | seen cursor / delivered event；F254 | carrier 与去重成熟；消费行为另靠 staging 常驻规则，形成“双层合同” |
| F296 presentation target | context presentation；cold/hot/compaction/版本变化 | 各 producer typed state → current epoch | 目标：subject+version+epoch dedupe；能力待 W0-E | source invalidator + context epoch；F296 | spec/Design Gate；尚未拥有所有 producer 的统一 mapper |

## 5. 旧项中最需要治理的四个现状面

| Surface | 当前事实 | 缺口为何重要 | 后续 owner |
|---|---|---|---|
| B1 Session Bootstrap | Session #2+ 注入 identity、handoff、Thread Memory、digest、task、按标题自动搜到的最多 5 条 knowledge snippet 与 recall tools；hard cap 2000 | title recall 与无 invalidator 的 rolling summary 在真正冷启动时最容易冒充适用事实；F296 Phase A 已要求正文降为 pointer | F296 负责 presentation；F065/source owner 负责 canonical lifecycle |
| N1 Navigation | 每轮给 baton、最多 3 tasks、recent artifacts、`truthSource` 和 best-next；truth source 可来自 canonical/regex/recency | regex 会标“推断”，recency 不会；过时 artifact 可占据命令式“真相源/先看” | F296 tier mapper + navigation owner |
| N2 / F148 history transport | unseen cursor、smart window、coverage/briefing、消息 token budget | unread size 被旧逻辑当 cold proxy；history transport 与 continuity state 混在一起 | F296 W0-E + F148 transport |
| F237 trace | 持久化点只拼 `invocationContext + mode + bootstrap + MCP`，随后 prompt 仍会追加 concierge/nudges/stop-gate；invocation 层再包 staging/hint/mission/cues/transcript | trace 文案称覆盖“ALL route-level”，实际只能证明中间产物；无法回答“这轮模型究竟看到了什么” | F237 observability；不由 Standing Reflex registry 偷接管 |

## 6. Serial / parallel / provider 差异

- serial 与 parallel 都有 invocation context、bootstrap、N2、concierge、F260/F282/F281 与 F287；
  **F167 structured stop gate 是 serial-only**，因为 parallel 没有 A2A routing 语义。这是合法差异，
  不是必须“补齐”。
- static identity 在 provider session resume 时可跳过；ADR-038 staging 与 F225 hint 独立于该判断，
  因而仍能每轮到达。
- native L0、AGENTS/skills、Claude external hooks、Antigravity/Codex 等 carrier 自己生成的
  continuity/auto-resume/freshness 内容不归 route builder。W0-E 已逐 carrier 写出
  `proven | conditional | unsupported | unimplemented`；除 Claude print 的 typed boundary 与部分
  hook 外，Codex/Gemini/Kimi/ACP 等没有可路由的 authoritative compact event。`unsupported` 是
  终态能力判定，不能让中央 Clowder AI manifest 或 token-drop heuristic 冒充 provider 真相。
- `contentBlocks`、图片本地路径与 `<context_attachments>` 是原始 evidence transport；它们需要
  安全与 provenance 约束，但不该登记成“行为 reflex”。

## 7. Census 结论：统一合同，联邦 owner，生成只读视图

W0-B 的证据**不支持先造一个中央 mutable registry/service/store 来拥有所有注入**：

1. identity、history transport、state、control gate、opportunity 的权力语义不同；统一成一种 entry
   会让“提示旧记忆”和“强制完成协议”共享错误的权限。
2. 最成熟的生命周期已经分布在各 owner：F287 catalog、F254 cursor、F167 custody、F282 receipt。
   把 canonical 状态复制进中央表会制造第二真相源。
3. F237 Phase 2 已提供推荐拓扑的**部分先例**：46 个 per-hook YAML 由 HookRegistry 扫描，
   生成只读 manifest view，并为 S*/D* 记录 delivered trace。下一步是字段覆盖审计与扩面，
   不是从零发明 registry。
4. native provider、AGENTS/skills 与 external hooks 天然不受单一 route registry 完整控制。
5. 但现有统一视图仍不完整：旧 52 项 guard 和 current runtime 至少相差上述 delta；Phase 2 trace
   覆盖 S*/D*，仍早于 route/invocation/provider 的最终组装。

因此 Wave 1 的推荐拓扑是：

```text
per-lane canonical contract / producer
  → shared ContextPresentation + Opportunity invariants
  → build-time / runtime-generated READ-ONLY surface catalog
  → delivered-prompt trace + lifecycle health
```

统一的是字段、权力边界、编译检查与观测视图；不统一 canonical store。未来若运行证据证明中央
admission service 有独有 consumer，再单独立项，不能把“想看全图”偷换成“中央服务必须存在”。

## 8. Standing Reflex 与 F296 的交界

| Standing Reflex / WriteOpportunity owner | F296 presentation owner |
|---|---|
| 为什么这个 mechanical predicate 值得产生一次判断机会 | 这个已获准 typed state 在当前 epoch 应 directive/state/pointer/omit 哪一种 |
| consumer 与 eligible destination lane | cold/hot、deltaSize、contextEpoch、版本去重 |
| `propose | defer | abstain` 及 terminal destination contract | 只呈现 disposition 要求，不替猫选择 disposition |
| scene budget、re-arm、sunset 与 burden | carrier 是否支持、何时重发、何时因 compaction 重新进入 cold |

ASR/第一手人物材料因此不能写成 staging 常驻句。它必须先成为场景 detector 的机械 observation，
再由获准 Standing Reflex entry 产生 typed WriteOpportunity，最后交给 F296 按当前 epoch 呈现。

## 9. W0-B 出口与未越界事项

### W0-B 已完成

- 52 个旧 manifest segment 按真实生命周期归组；
- 识别 F237 Phase 2 的 46 个 per-hook YAML、HookRegistry、generated manifest route 与 S*/D*
  delivered trace 是 partial catalog 先例；
- 11 个 current delta surface 与 F296 目标边界逐项登记触发、权力、预算/去重/失效与 owner；
- 给出最终 prompt 组装次序、serial/parallel/provider 边界；
- 证实 manifest drift 与 route trace 的 blind spot；
- 形成 topology 证据：**per-lane contract + generated read-only catalog** 优于预设中央 mutable registry。
- W0-E 已独立关账：`providerCarrier × invocationOrigin × routeTopology` 三坐标正交；resume 可在 prompt
  组装后失败转 fresh，因此 F296 必须先做 provider-start handshake，再建 epoch 与 mapper/ledger。

### 后续 work package 状态

- W0-C：七条 destination lane 的 trigger→validation→consumption census v0.2 已完成；
- W0-D：11 类 summary/card/index/cache lineage/invalidation census v0.2 已完成；
- W0-G：outcome/attribution ceiling 已完成，单 anchor contribution 仍不可观测；
- Wave 1：Standing Reflex v1、Derived View v1 与 F296 Context Presentation / Continuity v1 三份
  逻辑合同均已冻结；F296 runtime handshake/epoch/mapper/ledger 尚未实现。

W0-B 不因后续合同存在而升级为 runtime migration 完成；未登记 entry、delivery health 与 utility
仍不能由 source map 冒充。

## 10. Verifiable anchors

- baseline / catalog / trace：`assets/prompt-injection-manifest.yaml`、`assets/prompt-hooks/*/hook.yaml`、
  `scripts/check-manifest-drift.mjs`、`HookRegistry.ts`、`PipelinePromptBuilder.ts`、
  `InjectionTraceStore.ts`、`routes/prompt-injection-manifest.ts`、
  `docs/features/F237-prompt-injection-visibility.md`
- route / transport：`route-serial.ts`、`route-parallel.ts`、`invoke-single-cat.ts`、
  `SystemPromptBuilder.ts`、`SessionBootstrap.ts`、`StagingContent.ts`、`navigation-context.ts`
- opportunity / state：`RecallOpportunityCatalog.ts`、`MemoryCuePlaneService.ts`、
  `MemoryCueInvocationPromptService.ts`、`EntityNudgeService.ts`、`ProactiveMemoryNudgeService.ts`、
  `HumanDispositionFeedbackContextService.ts`、`PersonMemoryProposalStatusContextResolver.ts`
- event/control：`FreshnessNoticeService.ts`、`FreshnessNoticeBroker.ts`、F167 route stop-gate；
  target boundary 见 `docs/features/F296-continuity-aware-context-injection.md`

[小太阳·Maine Coon/GPT-5.6 Sol🐾]
