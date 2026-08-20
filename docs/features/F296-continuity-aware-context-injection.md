---
feature_ids: [F296]
related_features: [F148, F203, F230, F237, F254, F263, F282, F287]
topics: [context-transport, prompt-injection, cold-start, continuity, grounding]
doc_kind: spec
created: 2026-08-14
description: "按真实 runtime continuity 区分冷启动与热续，并让上下文注入的内容、语气和失效条件与证据强度一致。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-15T13:07:32Z
tips_exempt: "内部 prompt/context transport 契约收敛；不新增用户可操作的独立能力入口。"
---

# F296: Continuity-Aware Context Injection — 冷启动可信定向包 + 热续增量

> **Status**: in progress / Phase A complete；Phase B foundations B0–B2 landed + live；B3/B4 pending | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **operator kickoff**: `0001786766025646-000156-269d3cfb` — F148 若已关闭则新立 related
> feature，由Maine Coon选择正确路径并执行。
>
> **Kickoff content review**: Ragdoll (@fable5) 在
> `0001786765483390-000144-af03a4c3` 放行 `contextMode / deltaSize` 骨架与五元组合同，
> 要求补上 compaction 转移边、明确无 invalidator 的 regex `openQuestions` 不得进正文，
> 并按“先确定性止血、再终态合同”落地。

Architecture cell: `identity-session` + `memory`

Map delta: **none** — F296 在现有 invocation/session continuity 与 memory source 之间增加统一的
context presentation contract，不新建第二套 Evidence Store、Session Store 或 Prompt Pipeline。
F237 继续拥有注入可见性与 trace surface；F263 继续拥有 memory lifecycle / RecallEvent；各动态
producer 继续拥有自己的 canonical 状态。

Owner split: `identity-session` owns continuity / epoch；`memory` owns recall source truth。

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

## Progress / 人话版（2026-08-17）

F296 现在不是“做完了”，也不是“还没开始”：**先止血已经完成，终态的核心零件已经造好，但还没
接进所有真实 prompt 入口。** 因此 Phase A 的四条 AC 已关闭；Phase B 虽然完成了 B0/B1/B2 的实施
步骤，却还没有任何一条端到端 AC 可以诚实打勾。

| 阶段 | 人话 | 当前状态 |
|---|---|---|
| Phase A — Stop-Bleed | 先停止把启发式 recall、已失效待决问题、过期 artifact 当成当前真相喂给猫 | **完成**：AC-A1~A4 全绿并已合入 main |
| B0 — Coordinate + Handshake | 先问清“这次是哪种 carrier、从哪里调用、是否真的续上旧 runtime” | **部分覆盖**：`codex/exec_json` 有非 heuristic handshake；其余 carrier 仍按 census 保持 `unsupported/conditional` |
| B1 — Context Epoch Owner | 给每次 fresh/replaced/unknown/权威压缩一个新“上下文世代”，只有精确 resumed 才保持 hot | **地基已落地**：Redis 持久化 owner + CAS；尚未由所有 prompt surface 消费 |
| B2 — Mapper + Ledger | 按证据强度决定 directive/state/pointer/omit，并记“这一世代是否真的送达过” | **地基已落地**：mapper + in-memory ledger；尚未接入真实 surface，Phase B AC 仍为 0 |
| B3 — Surface Convergence | 把 serial/parallel/bootstrap/briefing/provider hook 全部接到同一投影与送达合同 | **未开始**：下一阶段；开工前先关闭下方四个结构性硬门 |
| B4 — Telemetry + UAT | 观察 mode/reason/tier/tokens/latency，并在 alpha 证明真实冷/热/压缩旅程 | **未开始** |
| Live runtime | 让已经合入 main 的行为真正被在线 API 加载 | **已加载至 B2b**：live API 于 2026-08-17 17:30:40 PDT 启动，runtime HEAD=`2415bef8`，dist 含 A1/A2/B2b 标记；这只证明代码已加载，不代表 B3/B4 或端到端 UAT 完成 |

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
| `interactive-cli / -p / bg-cron` 在 staging 与 F254 descriptor 中混用了 provider carrier 与 invocation origin；其中 F254 甚至把 Claude `bg_daemon` 映成 `bg-cron` | ADR-038 staging、`RuntimeCapabilityDescriptor.ts`、scheduler queue path | 无法据此判断 provider continuity；scheduled invocation 也可能复用任意 carrier |
| `AgentContextCapability.observesCompression` 有跨 carrier 声明，但只有 Claude print parser / project hook 找到 explicit compact signal；Codex/Gemini/Kimi 的现路径是 token-drop heuristic | provider `contextCapability()`、`context-client-capabilities.test.js`、`invoke-single-cat.ts` | 能力声明被误当成事件坐标会产生伪 epoch；heuristic 还会在进程重启后丢失 |
| ACP/Kimi/OpenCode 与通用 self-heal 都可能在 prompt 已组装后才把 resume 改成 fresh；现有路径最多补静态身份，不重建 dynamic cold packet | provider resume path + `invoke-single-cat.ts` fresh retry | 新 runtime 可能收到按旧 hot 状态去重过的 prompt，正是 F296 要避免的“错误 continuity” |
| Claude 路径有 `compact_boundary` / PreCompact / PostCompact 资产，但 bg transcript 明确跳过 system entry，PTY/bg hook parity 未证实 | `session-hooks.ts`、Claude hooks、`claude-ndjson-parser.ts`、`BgTranscriptEventConsumer.ts` | 只能逐 carrier 标成 proven / conditional / unsupported，不能把“Claude”整体视作已支持 |

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

> **W0-E capability census（2026-08-15）**：见
> Census 推翻了“直接按 interactive / `-p` / bg-cron 建统一状态表”的前提，并要求 Phase B 先完成
> coordinate normalization + provider-start handshake，再建 epoch 与 presentation。

#### 0. 三个输入坐标 + provider-start handshake

F296 先拆开三个输入，不再用一个 `runtimeMode` 兼任三种语义：

```ts
type ProviderCarrier =
  | { provider: 'claude'; carrier: 'print_sdk' | 'bg_daemon' | 'interactive_pty' | 'api_key' }
  | { provider: 'codex'; carrier: 'exec_json' | 'app_server' }
  | { provider: 'gemini'; carrier: 'gemini_cli' | 'antigravity_adapter' }
  | { provider: 'antigravity'; carrier: 'cdp_bridge' }
  | { provider: 'kimi'; carrier: 'stream_json' }
  | { provider: 'opencode'; carrier: 'run_json' }
  | { provider: 'acp'; carrier: 'acp'; backend: 'opencode' | 'unknown' }
  | { provider: 'catagent'; carrier: 'direct_api' }
  | { provider: 'a2a'; carrier: 'remote' }
  | { provider: 'unknown'; carrier: 'unknown'; rawProvider?: string; rawCarrier?: string };

type InvocationOrigin = 'interactive' | 'headless' | 'scheduled' | 'connector' | 'cloud' | 'unknown';
type RouteTopology = 'serial' | 'parallel' | 'independent';

type ContextCoordinate = Readonly<{
  providerCarrier: ProviderCarrier;
  invocationOrigin: InvocationOrigin;
  routeTopology: RouteTopology;
}>;

type FreshReason =
  | 'no_prior_session'
  | 'resume_rejected'
  | 'resume_failed'
  | 'carrier_forces_fresh';

type UnknownReason = 'carrier_unsupported' | 'signal_unavailable' | 'binding_mismatch';

type ContinuityDisposition =
  | { state: 'fresh'; reason: FreshReason; evidenceRef: string; runtimeSessionId?: string }
  | { state: 'resumed'; reason: 'resume_confirmed'; evidenceRef: string; runtimeSessionId: string }
  | {
      state: 'replaced';
      reason: 'runtime_replaced';
      evidenceRef: string;
      previousRuntimeSessionId?: string;
      runtimeSessionId: string;
    }
  | { state: 'unknown'; reason: UnknownReason; evidenceRef: string };
```

- `providerCarrier` 决定 session/resume/event 能力；`invocationOrigin` 只表达交互/授权语境；
  `routeTopology` 只决定 packet 消费面。三者都不能单独证明 hot。
- 已知 carrier 只能落入自己的 discriminated branch；未登记或无法识别的 transport 必须显式落入
  `unknown`，不能借最相近的 provider 名称获得 continuity 权力。新增 production carrier 先更新 census
  与这一 union，再实现 adapter。
- provider adapter 必须在消费用户 prompt 前返回带 content-free `evidenceRef` 的
  `ContinuityDisposition`。route 可以先收集 raw material，但不得提前冻结或发送 hot projection；
  `fresh / replaced / unknown` 触发 cold rebuild，只有 `resumed` 才允许保留当前 epoch 的 hot 投影。
- carrier 若无法在发送用户内容前完成 resume preflight，合法结果是 `unknown` 并发送 cold packet；不能先
  发送 hot prompt，再在 resume 失败后只补静态身份。若 provider API 只有“发 prompt 才知道”的接口，
  adapter 必须选择 cold-first，而不是伪造 `resumed`。
- 当前 active SessionRecord、请求携带的 sessionId、delivery cursor、seen cursor 都不能代替这次 handshake。
- F254 `RuntimeCapabilityDescriptor` 与 ADR-038 静态运行模式文字继续服务原 consumer，不作为 F296 真相源。

#### 1. 两个正交输出变量

```ts
type ContextMode = 'cold' | 'hot';
type DeltaSize = 'small' | 'large';
```

- `contextMode` 只由 handshake + epoch 决定：首次进入、fresh session、runtime rebind、明确
  compaction event 或 continuity 无法证明 → `cold`；同一 cat + thread + context epoch 且 provider 确认
  resumed → `hot`。seen cursor 只界定消息 freshness，不参与 continuity 证明。
- `deltaSize` 只决定本次 unread 区间如何裁剪。热续即使一次新增 100 条也仍是 hot；它只压缩这
  100 条，不重新召回旧 thread memory。
- 不新增“半冷”“可能压缩”等幽灵态。无法证明 continuity 时 fail closed 为 cold。

#### 2. Epoch owner 与确定转移表

`contextEpoch` 归 `identity-session` owner，scope 固定为 `user × cat × thread`；F296 只消费它，不新建
第二份 session store：

```ts
type ContextEpochState = Readonly<{
  scopeKey: string;
  contextEpoch: number;
  boundRuntimeSessionId?: string;
  contextMode: 'cold' | 'hot';
  lastTransitionRef: string;
}>;
```

| 输入 | 前置校验 | epoch / binding | 输出 mode |
|---|---|---|---|
| scope 首次出现 | 无旧 record | 建 `epoch=1`；按 disposition 绑定可用 runtime ID | `cold` |
| `fresh` | handshake 已完成 | `epoch+1`；替换或清空 binding | `cold` |
| `replaced` | 新 runtime ID 存在 | `epoch+1`；绑定新 ID | `cold` |
| `unknown` | 证据不足或 carrier 不支持 | `epoch+1`；清空 binding | `cold` |
| `resumed` | runtime ID 与 binding 精确一致 | epoch 与 binding 不变 | `hot` |
| `resumed` 但 binding 缺失/不一致 | 不得采信 resumed | 规范化为 `unknown(binding_mismatch)`，`epoch+1` | `cold` |
| authoritative `context_compacted` | event ID + runtime binding 校验通过 | **有界重放抑制**：最近 64 个已消费 event ID 内，同一 ID 只推进一次 `epoch+1`；binding 保持 | `cold` |
| token/message drop、scratchpad signature、auto-continue breaker | heuristic，不是 epoch event | 不改变 epoch | 保持原 mode；另记 health telemetry |

epoch 单调递增且不复用。任何 epoch 转移都不重置 message delivery cursor 或 seen cursor；它只使旧
presentation ledger key 失效。

> **Compaction 去重的认知天花板（B2a 实测边界，勿再表述为 exact-once）**：实现保留最近 64 个已消费
> compaction event ID 并逐出更旧的。因此保证是**有界重放抑制**，不是 lifecycle 级 exact-once——
> 一个在 64 个不同的后续 compaction 之后才重放的 event，**会**再推进一次 epoch（多一个 cold 世代，
> 方向安全但不是零成本）。真正的全局 exact-once 需要 lifecycle/retirement ownership 或无界持久状态；
> Wave 1 明确不买这个开销。任何 AC（含 AC-B7）不得引用比这更强的承诺。cold rebuild 必须重新向 canonical producer 取当前 revision，不能重放旧
prompt bytes 或仅清 dedupe 后复活已过期对象。

#### 3. 统一 presentation mapper + ledger

每个准备进入 prompt 的动态候选先投影为：

```ts
type SourceRevision =
  | { kind: 'version'; value: string }
  | { kind: 'as_of'; value: number };

type InvalidatorRef = Readonly<{
  owner: string;
  ref: string;
}>;

type PresentationIdentity = Readonly<{
  subjectKey: string;
  asOf: SourceRevision;
}>;

type ContextPresentation =
  | (PresentationIdentity & {
      sourceTier: 'T0';
      invalidator?: InvalidatorRef;
      presentation: 'directive' | 'state' | 'pointer' | 'omit';
    })
  | (PresentationIdentity & {
      sourceTier: 'T1';
      invalidator: InvalidatorRef;
      presentation: 'state' | 'pointer' | 'omit';
    })
  | (PresentationIdentity & {
      sourceTier: 'T2';
      invalidator?: InvalidatorRef;
      presentation: 'pointer' | 'omit';
    })
  | (PresentationIdentity & {
      sourceTier: 'invalid';
      invalidator?: InvalidatorRef;
      presentation: 'omit';
    });

type PresentationLedgerKey = Readonly<{
  scopeKey: string;
  contextEpoch: number;
  subjectKey: string;
  asOf: SourceRevision;
  presentation: ContextPresentation['presentation'];
}>;
```

| Tier | 资格 | 最高呈现 ceiling |
|---|---|---|
| T0 | 当前传球原文、用户显式锚点、typed callback、canonical subject 的当前 revision | `directive`：允许“先看 / 下一步” |
| T1 | 已重新校验存在性与当前状态，且有明确 invalidator | `state`：只陈述，不替猫下行动结论 |
| T2 | Related Evidence、memory summary、历史 anchors、regex/recency 猜测 | `pointer`：只说有检索入口，不推候选名或内容 |
| 校验失败 | subject 不可达、已删除、已 supersede、状态未知或缺失必要 invalidator | `omit` 或 `未定位` |

`sourceTier` 表达**当前被呈现 claim** 的证据与适用性，不是搜索排名或 transport 权威。typed
opportunity/callback 的 envelope 可以是 T0，但它携带的历史候选不会因此自动升级；不同权威的 claim 必须
拆成不同 projection。`presentation` 由 tier、current mode 与 source eligibility 的穷尽映射派生，producer
不能自己把 T2 文案塞进 prompt 绕过合同。

ledger 只存 content-free key + delivered timestamp，不复制 payload、canonical state 或 opportunity
disposition。只有 provider 已实际接收该 projection 后才能记 `presented`；render 失败、invoke-start 失败或
cold rebuild 都不能提前消费 dedupe。`omit` 可记 reason telemetry，但不得作为“内容已送达”阻止 future
valid revision。

#### 4. Cold：小而可信的定向包

Cold packet 只包含：

1. 显式 `contextMode=cold` 与 transition reason；
2. 当前传球原文 + `sourceMessageId`；
3. 通过 T0/T1 校验的 canonical feature / PR / callback / task subject；
4. 最近一个真实 unread burst；
5. 被省略区间的 count/time range 与 exact retrieval entry；
6. 只有仍被结构化 scope binding 证明适用时才包含 thread opener。

不包含 Related Evidence 候选正文、无状态 openQuestions、仅按 recency 排序的 artifact，或为了让
packet 看起来丰富而补的自动摘要。

#### 5. Hot：只投新消息与状态 delta

- 新消息继续由 delivery cursor 负责；动态状态按 `subjectKey + asOf + contextEpoch + presentation` 记录本 epoch
  已呈现版本，相同版本不重复。
- 大 delta 只对本次 unread 区间做 burst/tombstone shaping，不触发 cold recall。
- 没有新结构化状态时不重发导航旧数据；当前直接传球等 T0 事件仍按新事件呈现。
- cold rebuild 与 hot delta 都先 revalidate invalidator / expiry；新 epoch 允许重发仍有效状态，但不会让
  expired / superseded / forgotten 对象复活。

#### 6. Opportunity producer boundary

`WriteOpportunity` 与 `RecallOpportunity` 到达 F296 前必须已经由各自 owner 完成 admission。两者只共享
source coordinate、consumer scope、revision、expiry/invalidator 与 content-free receipt 等不变量，不合并
catalog 或权力语义：

```ts
type PresentationSurface = 'native_l0' | 'dynamic_context' | 'pointer' | 'deferred_queue';

type OpportunityEpistemicCeiling = 'mechanical_observation' | 'state' | 'pointer';

type OpportunityPresentationDecision =
  | {
      epistemicCeiling: 'mechanical_observation';
      presentation: 'state';
      claimKind: 'mechanical_observation';
    }
  | { epistemicCeiling: 'mechanical_observation'; presentation: 'pointer' | 'omit' }
  | { epistemicCeiling: 'state'; presentation: 'state' | 'pointer' | 'omit' }
  | { epistemicCeiling: 'pointer'; presentation: 'pointer' | 'omit' };

type AdmittedOpportunityPresentationV1 = Readonly<{
  opportunityId: string;
  opportunityKind: 'write' | 'recall';
  producerOwner: string;
  consumerScope: string;
  entryVersion: string;
  subjectKey: string;
  asOf: SourceRevision;
  sourceRefs: readonly string[];
  eligibleSurfaces: readonly PresentationSurface[];
  presentationPolicyRef: string;
  tokenBudget: number;
  dedupeKey: string;
  expiresAt: number;
  invalidators: readonly InvalidatorRef[];
  epistemicCeiling: OpportunityEpistemicCeiling;
}>;
```

`epistemicCeiling` 与 source tier 是两道同时生效的上限，mapper 必须取更低者；它不是另一套 tier：

| `epistemicCeiling` | Opportunity 允许的最高呈现 | 必须保留的语义边界 |
|---|---|---|
| `mechanical_observation` | `state`，也可降为 `pointer / omit` | `state` 只能陈述“系统按 predicate revision 观察到 X”，并携带 source/asOf；不得声称 intent、importance、truth，也不得把 candidate payload 一起升为 state |
| `state` | `state`，也可降为 `pointer / omit` | 仍受 source tier、invalidator、expiry 与当前 applicability 约束 |
| `pointer` | `pointer`，也可降为 `omit` | 不得内联候选正文或变成行动指令 |

任何 Opportunity 都不能由 ceiling 产生 `directive`。`OpportunityPresentationDecision` 的 exhaustive guard
必须与通用 `ContextPresentation` 一起校验：例如 T2 payload 即使来自
`mechanical_observation` envelope，最终也只能是 `pointer / omit`。

| 上游 owner 保留 | F296 接收并负责 | F296 明确禁止 |
|---|---|---|
| mechanical predicate、why-now、consumer、eligible lane/surface、scene/token budget、dedupe、expiry/re-arm、disposition taxonomy、canonical state | 验证 admitted envelope 的 consumer/surface/expiry/invalidator；执行上游 ceiling 与 token budget；据 coordinate/mode/epoch 做 mapper 和 presentation ledger | 生成 opportunity、判断“是否重要”、扩大 eligible surface/budget、选择 destination lane、替猫作 `propose/defer/abstain`、materialize truth、复制 opportunity store |

- WriteOpportunity 的 typed admission event 可以指令猫**完成一次 disposition**，但 observation/candidate
  内容仍按自己的 tier 呈现；directive 不能偷写成“这一定值得记”。
- RecallOpportunity 的 admitted envelope 不会把 recalled memory 洗成 directive；默认只呈现 bounded cue /
  pointer，并保留 exact drill。
- F296 写 content-free `presented | omitted` receipt；它不把 receipt 当作 opportunity 的业务终态。
- compaction/new epoch 后，只有 producer revalidation 仍返回 active 的 opportunity 才可再次呈现；清空
  presentation dedupe 不是 replay authorization，也不满足上游 re-arm predicate。

#### 7. Compaction：明确转移边，不猜工作记忆

```text
hot(epoch=N) -- context_compacted --> cold(epoch=N+1)
```

- 收到 provider-authoritative compaction event 后无条件推进 `contextEpoch`，清空 presentation dedupe，
  重发可信定向包；不尝试推断模型“到底忘了多少”。
- **不重置 message delivery cursor**：压缩后重发的是定向状态，不是把全部已读消息再喂一遍。
- provider 无权威 compaction signal 时，明确记录 capability；session/runtime 重建仍进入 cold，禁止用
  token 用量猜一次 compaction。实现前完成 carrier signal matrix，unsupported 是诚实状态，不用
  provider-specific heuristic fallback 假装覆盖。

#### 8. Phase B 实施顺序（Wave 1 冻结）

1. **B0 Coordinate + handshake**：三坐标 typed projection、scheduler origin 保真、provider-start
   `ContinuityDisposition`；
2. **B1 Context epoch owner**：复用 identity/session 真相源；fresh/replaced/authoritative compact 推进 epoch，
   resumed 保持，unknown fail closed；
3. **B2 Presentation mapper + ledger**：五元组穷尽映射、Opportunity producer adapter、同 epoch 去重与
   post-delivery receipt；
4. **B3 Surface convergence**：serial/parallel/bootstrap/briefing/Claude post-compact hook 同源消费；
5. **B4 Telemetry + UAT**：mode reason、coordinate、tier counts、payload tokens/latency；不记录候选正文。

**B3 接线前四个结构性硬门（2026-08-17 vision guard）**：

1. **ledger key 必须无碰撞**：当前 `\u001f` join 没有编码或拒绝 field 内分隔符；例如
   `subjectKey="x\u001fv:y", asOf="z"` 与 `subjectKey="x", asOf="y\u001fv:z"` 会得到同一个 key。
   B3 不得拿该字符串当五元组唯一性证据，须改为 canonical tuple / length-prefix 等无歧义编码并加对抗测试。
2. **receipt 必须由 provider adapter 铸造**：普通 `{ promptGenerationId, providerReceivedAt }` struct 谁都能伪造，
   无法结构性证明 provider 真收到了最终 prompt。B3 必须用 branded type 或 adapter-only factory 封住入口。
3. **并发 admission 与 delivery 必须形成诚实状态机**：`has() → put()` 会双投；但在 `admit()` 直接
   `SETNX` 又会在 render/launch 失败时永久压制猫从未看到的内容。B3 必须选择并验证
   `pending reservation → delivered`（含 generation/token、失败释放/过期与 crash recovery），或明确接受
   at-least-once 投递；不能一边保留两步语义，一边声称原子 exactly-once。
4. **AC-B6 的作用域必须覆盖重启与多实例**：当前只有 in-memory ledger，进程重启或另一 API 实例会忘记
   已送达记录。要保持“同 epoch 同 revision 不重复”的现有 AC，就需要共享持久化 ledger；若不购买该能力，
   必须先缩窄 AC，而不是把 process-local 行为写成全局保证。producer 还必须对内容变化推进 revision，
   否则任何 ledger 都会把新内容误判成旧版本。

Phase A 已完成，B0/B1/B2 地基已按冻结顺序落地；后续只能沿 B3 → B4 收口，仍禁止为 unsupported
carrier 补 heuristic。provider 在 launch 时由 resume 转 fresh 会让预先计算的 hot projection 失真；
Opportunity owner 与 F296 若互相复制 store，则会让 presentation receipt 错变成第二份 truth。

**B0 首个 carrier slice（2026-08-15）**：`codex / exec_json` 已接入 provider-start handshake。无请求
session 时为 `fresh(no_prior_session)`；携带 session 时因 provider 无 prompt-preflight 确认能力而为
`unknown(signal_unavailable)`，必须先走 cold rebuild，缺少 rebuild port 时在 provider 启动前 fail closed。
当前 ingress 只把可证明的 `direct_owner → interactive`、`connector → connector` 映射为具体 origin，其他来源
保持 `unknown`；serial / parallel topology 由 route 明确传入。Memory Cue 的 `presented` 已从 render 时写入改为
首个 substantive provider output 前写入，并绑定最终 prompt generation；self-heal 替换的旧 generation 不得领
receipt，`presented / omitted` trace 均只携带 ID、generation 与 evidence ref，不携带候选正文。

这只是 B0 的首个可举证 carrier，不把其他 carrier 冒充完成：Codex app-server 及 Claude、Gemini、
Antigravity、Kimi、OpenCode、ACP、CatAgent、A2A 仍为 `unsupported`，各自 adapter 必须按 W0-E census
逐项接入后才能更新支持矩阵。B1 epoch owner 与 B2 通用 mapper/ledger 已作为**零 consumer 地基**落地；
它们尚未接入 route/bootstrap/briefing/provider surface，因此不能据此关闭 Phase B AC。

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

- [x] AC-A1: cold-context 与 SessionBootstrap 两条 auto recall 路径都不再把启发式候选的标题、snippet
  或正文注入模型；只保留 content-free retrieval pointer。测试同时断言 route-serial / route-parallel
  与 session bootstrap 无旁路。
- [x] AC-A2: 没有 canonical lifecycle state + invalidator 的 `ThreadMemory.openQuestions` 不进入任何
  model-facing cold packet；已关闭问题 fixture 证明它不会以 Coverage Map、Thread Memory 或其他
  fallback 形式重新出现。
- [x] AC-A3: source ranking 在 stale #1108 artifact + 当前 #1128、已删除临时文件 + 当前 typed PR
  callback 两组 fixture 中只允许当前 subject 获得 T0/T1；纯 regex/recency 项不能生成命令式
  `真相源 / 下一步`。
- [x] AC-A4: Phase A 删除候选正文后不新增 summary/classifier/fallback 补空；prompt snapshot 明确接受
  稀疏输出，并保留 `未定位 + exact drill`。

### Phase B（Continuity-Aware Contract）

- [ ] AC-B1: `providerCarrier × invocationOrigin × routeTopology` 为三个独立 typed coordinate；测试证明
  Claude bg daemon 不等于 scheduled origin，任意 scheduled invocation 可以选择自己的 provider carrier。
- [ ] AC-B2: 每个生产 carrier 在消费用户 prompt 前给出 `ContinuityDisposition`；fresh/replaced/unknown 会
  重建 cold packet，resumed 才允许 hot。通用 stale retry、ACP load failure、Kimi fingerprint rejection 与
  OpenCode workspace guard 都不能只补静态身份后沿用旧 hot prompt。
- [ ] AC-B3: `contextMode` 与 `deltaSize` 为正交 typed output；首次进入、fresh/replaced/unknown、explicit
  compaction、resumed small delta、resumed large delta 的表驱动测试逐项证明转移结果。active SessionRecord、
  requested sessionId、delivery cursor、seen cursor 均不得单独证明 hot。
- [ ] AC-B4: `ContextPresentation` 五字段与 T0/T1/T2/invalid 穷尽映射有 schema + exhaustive guard；
  任一 producer 不能绕过 mapper 直接注入动态正文。
- [ ] AC-B5: cold packet snapshot 只含 mode/reason、exact baton、合格 canonical subject、recent burst、
  omitted range 与 drill pointer；不含启发式候选正文或无状态历史。
- [ ] AC-B6: hot small/large delta 均只呈现 unseen messages 与新版本状态；相同
  `subjectKey + version/asOf + contextEpoch` 不重复，大 delta 不触发 cold recall。
- [ ] AC-B7: authoritative compaction event 令 `contextEpoch` 前进、presentation dedupe 重置并重发 cold
  packet，同时保持 message delivery cursor 与 seen cursor；压缩前已读消息不得被整体重放。
- [ ] AC-B8: provider signal matrix 覆盖当前生产 carrier，并区分 capability declaration 与可路由 event；
  支持的 carrier 使用 authoritative event，不支持的 carrier 显式 `unsupported`。`observesCompression=true`
  但无 typed event 必须仍判 unsupported；token/message drop 与 ACP/OpenCode scratchpad 文本签名/auto-continue
  熔断均不得冒充 compaction detection 或推进 epoch。
- [ ] AC-B9: route-serial、route-parallel、SessionBootstrap、Context Briefing 与 Claude post-compact hook 消费
  同一 mode/presentation projection；人类卡片显示 coordinate + mode/reason + 各 tier 呈现数量，不建立第二份
  判断真相。十个对抗 fixture 全绿：旧 artifact vs 当前 subject、删除文件 vs typed callback、closed
  openQuestion、hot large delta 不 recall、compaction 后重发但不重放、bg daemon vs scheduled、声明无事件、
  stale-resume fresh rebuild、scratchpad heuristic 不推进 epoch、无 continuity carrier fail-closed。
- [ ] AC-B10: WriteOpportunity / RecallOpportunity adapter 只接收已 admitted 的 typed envelope，并保留
  producer owner、consumer scope、source revision、expiry/invalidator 与 epistemic ceiling。fixture 证明
  T0 opportunity envelope 不提升内嵌 T1/T2 claim、epoch reset 不复活 expired opportunity、presentation receipt
  不写业务 disposition 或 canonical truth；ceiling→presentation table fixture 证明 `mechanical_observation`
  只能成为带 `claimKind=mechanical_observation` 的 qualified `state` 或降为 `pointer/omit`，`pointer` ceiling
  只能成为 `pointer/omit`，所有 Opportunity 分支都不能成为 `directive`。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “得和 Claude Code 那样克制” | AC-A1, AC-A4, AC-B4, AC-B5 | prompt snapshots + integration tests | [ ] |
| R2 | 无法完全保证的内容不能冒充权威 | AC-A2, AC-A3, AC-B4, AC-B8, AC-B10 | adversarial fixtures | [ ] |
| R3 | 冷启动与不在冷启动必须不同 | AC-B1, AC-B2, AC-B3, AC-B5, AC-B6, AC-B7 | handshake + state-table tests | [ ] |
| R4 | 压缩后不能被误当成仍有完整 context 的 hot | AC-B7, AC-B8 | provider compaction fixture | [ ] |
| R5 | 先止血，不让终态架构阻塞已知错误 | AC-A1~A4 | Phase A targeted gate | [x] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC
- [x] 每个 AC 都有非作者可复核的测试或 snapshot
- [x] 用户旅程覆盖 cold / hot-small / hot-large / compact 四条路径，并补 provider-start fresh-rebuild 边

## Mechanism Selection（ADR-031 / ADR-038）

| Claim | 机制 | 证据 / consumer |
|---|---|---|
| coordinate/handshake、mode 转移、tier 映射、Opportunity boundary、禁止旁路、cursor 不重置属于确定契约 | test / schema / exhaustive guard | AC-A1~A4、AC-B1~B10 的 table-driven 与 prompt fixtures |
| 各 mode 的 payload 体积、组装耗时、provider signal coverage 属于运行健康 | F153 logs / metrics / traces | `contextMode`、reason、deltaSize、tier counts、tokens、latency；不记录候选正文 |
| 当前没有“哪个策略更有用”的 keep/tune/sunset 不确定效用决策 | 不创建 Eval Contract | 若未来要比较 cold packet 变体或 tune 阈值，必须先加载 `eval-design` 出生证 |

F263 的 RecallEvent 继续记录 memory pointer/content 的呈现与消费；F296 不复制一份 memory eval 账本。

## Dependencies

- **Evolved from**: F148（保留其 smart window、baton、coverage 与 briefing 资产；不重开已关闭历史）
- **Related**: F203（native L0 压缩免疫，不拥有本 Feature 的 per-turn continuity packet）
- **Related**: F230（Claude interactive PTY carrier；提供 resume/hook 事实，不拥有 F296 epoch）
- **Related**: F237（注入可见性 / trace surface，不决定候选能否进 prompt）
- **Related**: F254（freshness seen cursor / runtime descriptor；不能被复用成 continuity truth）
- **Related**: F263（memory injection lifecycle / RecallEvent 与 provenance contract）
- **Related**: F282（WriteOpportunity 局部先例；F296 只消费 admitted typed state，不接管检测与 disposition）
- **Related**: F287（RecallOpportunity closed catalog；F296 不复制 catalog，只约束当前 epoch 的呈现与去重）
- **Blocked by**: none；W0-E census 已完成 baseline 改判，Phase A 可先行；Phase B 必须从 B0 coordinate +
  provider-start handshake 开始，unsupported 结果不阻塞 fail-closed 实现

## Risk

| 风险 | 缓解 |
|---|---|
| 收缩后导航看起来更空，被误报为退化 | spec 与 briefing 明示“稀疏是 fail-closed 结果”；禁止 heuristic fallback 补空 |
| presentation dedupe 在压缩后饿死猫 | explicit compaction → epoch+1 + reset presentation ledger；message cursor 保持独立 |
| provider 没有 compaction event | capability matrix 显式 unsupported；session/runtime rebuild 仍 cold，不用 token 猜 |
| resume requested 被误当成 resume succeeded | provider-start handshake 在消费 prompt 前返回 disposition；fresh/replaced/unknown 强制重建 cold packet |
| scheduled origin 与 Claude bg transport 混淆 | 三坐标正交；F254 descriptor 不作为 F296 输入，scheduler sourceCategory 端到端保真 |
| 新合同变成所有 producer 的又一层包装 | mapper 只承载五字段与穷尽映射；canonical 状态仍由各 producer owner 提供，不复制 store |
| T0 被误解为“内容永远正确” | T0 要求当前 subject + revision/coordinate；truth 与 current applicability 两项都过才成立 |
| typed opportunity envelope 给内嵌候选洗权威 | envelope 与 payload claim 分开映射；T0 admission 只证明“这次判断机会当前存在” |
| render 即记 presented，失败重试时饿死 projection | ledger 只在 provider 实际接收后写 content-free receipt |

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
| KD-8 | provider carrier、invocation origin、route topology 三坐标正交 | `interactive/-p/bg-cron` 混合了 transport 与调用来源；尤其 bg daemon 不等于 scheduled invocation |
| KD-9 | `observesCompression` 声明不等于 F296 event | 多个 carrier 声明 true 却只有 token-drop heuristic；epoch 只能消费 typed authoritative event |
| KD-10 | provider-start handshake 先于 mapper/ledger | resume 可在 prompt 组装后失败并转 fresh；不先确认 disposition，任何 hot projection 都可能建立在错 epoch 上 |
| KD-11 | provider/carrier 使用 closed discriminated union；未知值显式 unknown | 防止相近名称或旧 runtimeMode 获得未经 census 的 continuity 权力 |
| KD-12 | epoch 归 identity-session；ledger 只在实际送达后记 content-free key | 不复制 session/truth store，也不让失败 render 提前消费 dedupe |
| KD-13 | Opportunity envelope 与其 payload claim 分层映射 | typed admission 只证明机会存在，不能把“需要判断”洗成“候选已经正确/重要” |
| KD-14 | mechanical observation 的 presentation ceiling 明确为 qualified state | 允许陈述可追溯的 predicate 命中，但禁止借 observation 声称 intent/importance/truth；source tier 更低时继续降档 |

## Review Gate

- Kickoff content: 复用 Fable 5 对骨架、五元组、五个 fixture 与两阶段顺序的同 thread verdict；本 spec
  已逐项吸收其三个修正，不因落盘 SHA 变化重演同一轮内容 review。
- Phase A code: TDD + 非作者 targeted review；重点核对两条 recall 路径与 serial/parallel 旁路。
- Phase B design: W0-E census + Wave 1 state/producer contract 由非作者做内容 review；实现必须从 B0 handshake
  开始，走 TDD + 非作者 review。是否 full gate 由最终行为/契约 diff 按 SOP 五轴决定。
