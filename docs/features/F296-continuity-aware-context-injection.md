---
feature_ids: [F296]
related_features: [F148, F203, F237, F263, F282]
topics: [context-transport, prompt-injection, cold-start, continuity, grounding]
doc_kind: spec
created: 2026-08-14
description: "按真实 runtime continuity 区分冷启动与热续，并让上下文注入的内容、语气和失效条件与证据强度一致。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-15T03:53:00Z
tips_exempt: "内部 prompt/context transport 契约收敛；不新增用户可操作的独立能力入口。"
---

# F296: Continuity-Aware Context Injection — 冷启动可信定向包 + 热续增量

> **Status**: spec / Architecture Design Gate | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **operator kickoff**: `0001786766025646-000156-269d3cfb` — F148 若已关闭则新立 related
> feature，由Maine Coon选择正确路径并执行。
>
> **Kickoff content review**: Ragdoll (@fable5) 在
> `0001786765483390-000144-af03a4c3` 放行 `contextMode / deltaSize` 骨架与五元组合同，
> 要求补上 compaction 转移边、明确无 invalidator 的 regex `openQuestions` 不得进正文，
> 并按“先确定性止血、再终态合同”落地。

Architecture cell: `identity-session`（continuity / epoch owner）+ `memory`（recall source owner）

Map delta: **none** — F296 在现有 invocation/session continuity 与 memory source 之间增加统一的
context presentation contract，不新建第二套 Evidence Store、Session Store 或 Prompt Pipeline。
F237 继续拥有注入可见性与 trace surface；F263 继续拥有 memory lifecycle / RecallEvent；各动态
producer 继续拥有自己的 canonical 状态。

Why: “猫是否仍有连续工作记忆”属于 identity/session continuity；“历史候选是否存在、来自哪里”
属于 memory。F296 只在 route/bootstrap 组装边界决定本轮该呈现什么、以什么权威语气呈现，以及
什么时候必须失效或重发。

## Why

F148 已把超长未读历史压成 smart window，但它把“未读很多”命名为 cold，把“未读较少”命名为
warm。结果是两类相反风险同时存在：真正冷启动的猫会收到 Related Evidence、旧 openQuestions、
历史 artifact 等未经当前适用性校验的内容，并因它们处在系统注入位置而过度信任；仍有连续上下文的
热续猫则可能反复收到导航、记忆与机械统计，稀释真正的新消息。

You 的价值要求不是“候选语气更客气”，而是系统对自己知道什么保持诚实：

> “得和 Claude Code 那样克制……如果我们无法 100% 保证的，都只能说是推荐参考？”

本 Feature 把这句话再推进一层：**可验证事实可以直接呈现；已校验状态只能陈述；启发式候选不进
正文，只留检索入口。冷启动给小而可信的定向包，热续只给新发生的 delta；压缩后无条件重新进入
冷启动定向包。**

## Current State / 现状基线

截至 2026-08-14 的 main 代码实查：

| 现状 | 一手证据 | 风险 |
|---|---|---|
| `relevant.length > 15` 或估算 token `> 10_000` 即 `isColdMention` | `route-helpers.ts` 的 `assembleIncrementalContext()`；`hierarchical-context-config.ts` | 判断的是 delta 大小，不是猫是否保有连续 runtime context |
| cold packet 自动拼入 Coverage Map、Thread Memory、tombstone、最多 3 个 anchors、最多 3 条 Related Evidence 与 recent burst | `assembleSmartWindowContext()` | 候选处在系统注入位置，天然获得超过证据强度的权威感 |
| SessionBootstrap 按 thread title 自动注入最多 5 条知识标题与 snippet | `SessionBootstrap.ts` 的 `Project Knowledge Recall` | 新 session 检伪能力最低，却收到启发式正文 |
| `rankArtifactSources()` 在 canonical feature / active PR 后以 recency 补齐，top-1 一律可变成 `真相源` 与命令式“先看” | `source-ranking.ts` + `navigation-context.ts` | 已删除临时文件、旧 worktree artifact 或不再适用的历史项可冒充当前入口 |
| `ThreadMemory.openQuestions` 由 regex / summary 累积后进入 cold coverage 与 briefing | `buildThreadMemory.ts` + `route-helpers.ts` + `format-briefing.ts` | 没有 resolved/superseded 状态或 invalidator；已闭环问题仍像当前待办 |
| warm path 已按 delivery cursor 只读 unseen messages，但导航和其他动态 producer 各自决定是否重发 | `assembleIncrementalContext()` + producer-specific injection paths | “消息增量”已经存在，“所有注入源都增量化”尚不存在 |
| Claude 路径已有 `compact_boundary` / PreCompact / PostCompact 信号，其他 provider 的能力并未统一投影为 context epoch | `session-hooks.ts`、Claude hooks 与 provider parsers | session/cursor 仍在时发生压缩，系统可能误判为 hot 并继续去重 |

本次立项的活体样本：Ragdoll冷启动时收到与任务无关的 F091/F040/F195 Related Evidence，以及一个
PR 已于两个月前合入却仍被注入的 `openQuestion`；热续下一轮只新增 1 条对话，却又收到机械重复
统计。证据见本 Feature 的 Discussion。

## What

### Phase A: Epistemic Stop-Bleed — 三刀确定性止血

Phase A 不等待完整 continuity 架构，先把已经证明会冒充权威的内容从 model-facing prompt 收缩掉：

1. **启发式 recall 正文 → 指针**：cold-context Related Evidence 与 SessionBootstrap title-based
   auto recall 都不再注入候选标题、snippet 或正文；只保留“有历史可检索”的 content-free 入口、
   omitted range 与 exact drill 工具。F263 trace 若记录该呈现，必须标成 `pointer`，不能算候选正文
   `presented`。
2. **无生命周期 openQuestions → 永久不进正文**：现有 regex/summary 产出的 `openQuestions` 没有
   invalidator，不为它们补假的状态字段，不建待办脚手架；它们退出 model prompt。未来只有 canonical
   owner 提供 `asOf + unresolved state + invalidator` 的新来源才可重新获得 T1 资格。
3. **历史 artifact 不得冒充真相源**：`canonical` 仍须验证当前 subject 与可达性；active PR 使用
   exact task/callback 状态；`regex` / `recency` 只可作为历史参考或检索入口，不得生成命令式
   `真相源 / 先看`。缺少合格项时明确 `真相源: 未定位`。

Phase A 的稀疏输出是预期结果，不用新的 heuristic fallback 把版面重新填满。

### Phase B: Continuity-Aware Context Contract — 终态状态机

#### 1. 两个正交变量

```ts
type ContextMode = 'cold' | 'hot';
type DeltaSize = 'small' | 'large';
```

- `contextMode` 只由可验证 continuity 决定：首次进入、新 runtime/session、runtime rebind、明确
  compaction event 或 continuity 无法证明 → `cold`；同一 cat + thread + context epoch 且有已知
  seen cursor → `hot`。
- `deltaSize` 只决定本次 unread 区间如何裁剪。热续即使一次新增 100 条也仍是 hot；它只压缩这
  100 条，不重新召回旧 thread memory。
- 不新增“半冷”“可能压缩”等幽灵态。无法证明 continuity 时 fail closed 为 cold。

#### 2. 统一 presentation contract

每个准备进入 prompt 的动态候选先投影为：

```ts
type ContextPresentation = {
  sourceTier: 'T0' | 'T1' | 'T2';
  subjectKey: string;
  asOf: number;
  invalidator?: string;
  presentation: 'directive' | 'state' | 'pointer' | 'omit';
};
```

| Tier | 资格 | 可用呈现 |
|---|---|---|
| T0 | 当前传球原文、用户显式锚点、typed callback、canonical subject 的当前 revision | `directive`：允许“先看 / 下一步” |
| T1 | 已重新校验存在性与当前状态，且有明确 invalidator | `state`：只陈述，不替猫下行动结论 |
| T2 | Related Evidence、memory summary、历史 anchors、regex/recency 猜测 | `pointer`：只说有检索入口，不推候选名或内容 |
| 校验失败 | subject 不可达、已删除、已 supersede、状态未知或缺失必要 invalidator | `omit` 或 `未定位` |

`sourceTier` 表达证据与适用性，不是搜索排名；`presentation` 由 tier 和当前 mode 的穷尽映射派生，
producer 不能自己把 T2 文案塞进 prompt 绕过合同。

#### 3. Cold：小而可信的定向包

Cold packet 只包含：

1. 显式 `contextMode=cold` 与 transition reason；
2. 当前传球原文 + `sourceMessageId`；
3. 通过 T0/T1 校验的 canonical feature / PR / callback / task subject；
4. 最近一个真实 unread burst；
5. 被省略区间的 count/time range 与 exact retrieval entry；
6. 只有仍被结构化 scope binding 证明适用时才包含 thread opener。

不包含 Related Evidence 候选正文、无状态 openQuestions、仅按 recency 排序的 artifact，或为了让
packet 看起来丰富而补的自动摘要。

#### 4. Hot：只投新消息与状态 delta

- 新消息继续由 delivery cursor 负责；动态状态按 `subjectKey + version/asOf + contextEpoch` 记录本 epoch
  已呈现版本，相同版本不重复。
- 大 delta 只对本次 unread 区间做 burst/tombstone shaping，不触发 cold recall。
- 没有新结构化状态时不重发导航旧数据；当前直接传球等 T0 事件仍按新事件呈现。
- F282 等 producer 保留候选检测 ownership，但必须交 typed presentation 给本合同；热续重复统计不是
  新 delta，不能再次占据 prompt。

#### 5. Compaction：明确转移边，不猜工作记忆

```text
hot(epoch=N) -- context_compacted --> cold(epoch=N+1)
```

- 收到 provider-authoritative compaction event 后无条件推进 `contextEpoch`，清空 presentation dedupe，
  重发可信定向包；不尝试推断模型“到底忘了多少”。
- **不重置 message delivery cursor**：压缩后重发的是定向状态，不是把全部已读消息再喂一遍。
- provider 无权威 compaction signal 时，明确记录 capability；session/runtime 重建仍进入 cold，禁止用
  token 用量猜一次 compaction。实现前完成 carrier signal matrix，unsupported 是诚实状态，不用
  provider-specific heuristic fallback 假装覆盖。

## User Journey

### Primary Journey: 把一只新猫拉进 100 条上下文的活跃 Thread

- **Scope unit**: cat × thread × context epoch
- **Actor**: You + 被 @ 的猫
- **Entry**: You 在一个已有大量历史的 Thread 中 @ 一只没有连续 runtime context 的猫。
- **Flow**:
  1. 系统以可验证 continuity 判为 cold，并在 packet 首行明确告诉猫。
  2. 猫只收到当前传球原文、canonical subject、最近 unread burst 和省略区间检索入口。
  3. 系统无法确认的历史候选不出现在正文；没有合格真相源时明确写“未定位”。
  4. 猫需要更多历史时主动 drill，而不是带着系统猜测直接行动。
- **Success evidence**: prompt fixture + route integration test，证明 100 条历史场景中 T2 候选正文为 0，
  T0/T1 provenance、mode reason 与 drill pointer 完整。
- **Non-goals**: 不自动总结整条 Thread；不让 backend classifier 替猫判断 intent；不保证无需检索即可
  完成所有历史任务。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|---|---|---|---|---|
| S1 | hot epoch | 同一只猫 | 上轮 context 仍在 → 新增 1 条消息 → 只收到 1 条消息与真正变化的状态 | repeated-version negative fixture |
| S2 | hot epoch + large delta | 同一只猫 | 一次新增 100 条 → 只压缩这 100 条 → 不重载旧 memory/Related Evidence | large-delta route fixture |
| S3 | compacted epoch | 同一只猫 | provider 发出 compaction → epoch+1 → 重发可信定向包但不重放已读消息 | compaction transition fixture |
| S4 | missing truth source | 新猫 | artifact 已删除或 subject 已 supersede → 导航显示未定位 + drill 入口 | stale artifact fixture |

## Acceptance Criteria

<!-- 每条 AC trace 回 Why：冷启动防假权威、热续防重复、压缩后防错误去重；均须由非作者通过测试输出或 prompt snapshot 复核。 -->

### Phase A（Epistemic Stop-Bleed）

- [ ] AC-A1: cold-context 与 SessionBootstrap 两条 auto recall 路径都不再把启发式候选的标题、snippet
  或正文注入模型；只保留 content-free retrieval pointer。测试同时断言 route-serial / route-parallel
  与 session bootstrap 无旁路。
- [ ] AC-A2: 没有 canonical lifecycle state + invalidator 的 `ThreadMemory.openQuestions` 不进入任何
  model-facing cold packet；已关闭问题 fixture 证明它不会以 Coverage Map、Thread Memory 或其他
  fallback 形式重新出现。
- [ ] AC-A3: source ranking 在 stale #1108 artifact + 当前 #1128、已删除临时文件 + 当前 typed PR
  callback 两组 fixture 中只允许当前 subject 获得 T0/T1；纯 regex/recency 项不能生成命令式
  `真相源 / 下一步`。
- [ ] AC-A4: Phase A 删除候选正文后不新增 summary/classifier/fallback 补空；prompt snapshot 明确接受
  稀疏输出，并保留 `未定位 + exact drill`。

### Phase B（Continuity-Aware Contract）

- [ ] AC-B1: `contextMode` 与 `deltaSize` 为正交 typed contract；首次进入、runtime/session rebuild、
  explicit compaction、continuous small delta、continuous large delta 的表驱动测试逐项证明转移结果。
- [ ] AC-B2: `ContextPresentation` 五字段与 T0/T1/T2/invalid 穷尽映射有 schema + exhaustive guard；
  任一 producer 不能绕过 mapper 直接注入动态正文。
- [ ] AC-B3: cold packet snapshot 只含 mode/reason、exact baton、合格 canonical subject、recent burst、
  omitted range 与 drill pointer；不含启发式候选正文或无状态历史。
- [ ] AC-B4: hot small/large delta 均只呈现 unseen messages 与新版本状态；相同
  `subjectKey + version/asOf + contextEpoch` 不重复，大 delta 不触发 cold recall。
- [ ] AC-B5: authoritative compaction event 令 `contextEpoch` 前进、presentation dedupe 重置并重发 cold
  packet，同时保持 message delivery cursor；压缩前已读消息不得被整体重放。
- [ ] AC-B6: provider signal matrix 覆盖当前生产 carrier；支持的 carrier 使用 authoritative event，
  不支持的 carrier 显式 `unsupported`，不得以 token/message heuristic 冒充 compaction detection。
- [ ] AC-B7: route-serial、route-parallel、SessionBootstrap 与 Context Briefing 消费同一 mode/presentation
  projection；人类卡片显示 mode + reason + 各 tier 呈现数量，不建立第二份判断真相。
- [ ] AC-B8: 五个对抗 fixture 全绿：旧 artifact vs 当前 subject、删除文件 vs typed callback、closed
  openQuestion、hot large delta 不 recall、compaction 后重发定向包但不重放已读消息。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “得和 Claude Code 那样克制” | AC-A1, AC-A4, AC-B2, AC-B3 | prompt snapshots + integration tests | [ ] |
| R2 | 无法完全保证的内容不能冒充权威 | AC-A2, AC-A3, AC-B2 | adversarial fixtures | [ ] |
| R3 | 冷启动与不在冷启动必须不同 | AC-B1, AC-B3, AC-B4 | state-table tests | [ ] |
| R4 | 压缩后不能被误当成仍有完整 context 的 hot | AC-B5, AC-B6 | provider compaction fixture | [ ] |
| R5 | 先止血，不让终态架构阻塞已知错误 | AC-A1~A4 | Phase A targeted gate | [ ] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC
- [x] 每个 AC 都有非作者可复核的测试或 snapshot
- [x] 用户旅程覆盖 cold / hot-small / hot-large / compact 四条路径

## Mechanism Selection（ADR-031 / ADR-038）

| Claim | 机制 | 证据 / consumer |
|---|---|---|
| mode 转移、tier 映射、禁止旁路、cursor 不重置属于确定契约 | test / schema / exhaustive guard | AC-A1~A4、AC-B1~B8 的 table-driven 与 prompt fixtures |
| 各 mode 的 payload 体积、组装耗时、provider signal coverage 属于运行健康 | F153 logs / metrics / traces | `contextMode`、reason、deltaSize、tier counts、tokens、latency；不记录候选正文 |
| 当前没有“哪个策略更有用”的 keep/tune/sunset 不确定效用决策 | 不创建 Eval Contract | 若未来要比较 cold packet 变体或 tune 阈值，必须先加载 `eval-design` 出生证 |

F263 的 RecallEvent 继续记录 memory pointer/content 的呈现与消费；F296 不复制一份 memory eval 账本。

## Dependencies

- **Evolved from**: F148（保留其 smart window、baton、coverage 与 briefing 资产；不重开已关闭历史）
- **Related**: F203（native L0 压缩免疫，不拥有本 Feature 的 per-turn continuity packet）
- **Related**: F237（注入可见性 / trace surface，不决定候选能否进 prompt）
- **Related**: F263（memory injection lifecycle / RecallEvent 与 provenance contract）
- **Related**: F282（proactive candidate producer；F296 只约束 presentation/delta，不接管检测与判断）
- **Blocked by**: none；Phase B 先做 provider signal capability census，unsupported 结果不会阻塞 Phase A

## Risk

| 风险 | 缓解 |
|---|---|
| 收缩后导航看起来更空，被误报为退化 | spec 与 briefing 明示“稀疏是 fail-closed 结果”；禁止 heuristic fallback 补空 |
| presentation dedupe 在压缩后饿死猫 | explicit compaction → epoch+1 + reset presentation ledger；message cursor 保持独立 |
| provider 没有 compaction event | capability matrix 显式 unsupported；session/runtime rebuild 仍 cold，不用 token 猜 |
| 新合同变成所有 producer 的又一层包装 | mapper 只承载五字段与穷尽映射；canonical 状态仍由各 producer owner 提供，不复制 store |
| T0 被误解为“内容永远正确” | T0 要求当前 subject + revision/coordinate；truth 与 current applicability 两项都过才成立 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | F148 保持 done，新立 F296 作为后继 | F148 的原始愿景和 Close 证据已成立；新问题是运行两个月后出现的 source trust + continuity 新合同，复活会改写历史 |
| KD-2 | 同一 Feature 两阶段：先止血、再终态 | Phase A 是可立即红绿的确定契约；Phase B 需要跨 provider continuity 设计，但不应阻塞已知假权威退出 |
| KD-3 | `contextMode` 与 `deltaSize` 正交 | 未读量不能证明模型是否保有工作记忆 |
| KD-4 | T0 directive / T1 state / T2 pointer / invalid omit | 系统注入的位置本身就是权威信号，仅语气降级不足以约束启发式内容 |
| KD-5 | compaction 无条件进入新 cold epoch | 不猜模型忘了多少；重置 presentation dedupe 才不会饿死压缩后的猫 |
| KD-6 | 无 invalidator 的 regex openQuestion 不进正文，不补字段脚手架 | 现有 producer 无法证明生命周期；宁空勿假 |
| KD-7 | 确定契约走 tests，健康走 F153；暂不建 Eval | 机制按 claim 选，不把每个 harness 改动都机械挂到 Eval Hub |

## Review Gate

- Kickoff content: 复用 Fable 5 对骨架、五元组、五个 fixture 与两阶段顺序的同 thread verdict；本 spec
  已逐项吸收其三个修正，不因落盘 SHA 变化重演同一轮内容 review。
- Phase A code: TDD + 非作者 targeted review；重点核对两条 recall 路径与 serial/parallel 旁路。
- Phase B design: provider signal matrix + state table 先过 architecture review，再进 worktree；实现走 TDD +
  非作者 review。是否 full gate 由最终行为/契约 diff 按 SOP 五轴决定。
