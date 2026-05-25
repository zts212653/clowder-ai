---
feature_ids: [F211]
related_features: [F061, F102, F124, F194, F200, F201, F209, F210]
topics: [session-chain, antigravity, cross-runtime, memory, transparency, ide-direct]
doc_kind: spec
created: 2026-05-24
---

# F211: Cross-Runtime Session Transparency — Antigravity Session Chain + IDE Direct Registration

> **Status**: doing | **Owner**: Maine Coon（Maine Coon） | **Priority**: P1

Architecture cell: `identity-session` + `memory`
Map delta: update required — F211 adds runtime session registration / cascade visibility as a first-class session boundary. `identity-session` owns session identity and cascade/session binding; `memory` consumes the resulting transcript/digest evidence. F209 remains retrieval-only.
Why: Antigravity cascade work is currently not reliably represented as Cat Cafe session-chain evidence, so later cats cannot recover what happened even when the work visibly occurred.

## Why

team lead 2026-05-24 现场判断：“我们的这个 antigravity 真的需要接入 session chain 也好或者什么也好，就是他的 session 得是透明的。”

这不是 F201 没关干净，也不是 F209 检索能力不够。当前问题在更上游：

- Antigravity Desktop / cascade 有自己的 long-lived session state。
- Cat Cafe 有 Redis-backed SessionChainStore、transcript、digest、session drill-down tools。
- 两套系统没有统一生命周期。结果是：Antigravity 做过的工作可能在 UI 上看得见，但 `list_session_chain` / `read_session_digest` / `search_evidence` 找不到。
- IDE 直开和孟加拉猫聊天时更严重：这类 conversation 完全绕过 Cat Cafe dispatch，家里没有可追溯 session record。

F211 的目标是让跨 runtime 工作先“进家里的账本”，再交给 F209/F200 做检索和评估。换句话说：**F211 负责产生可见证据，F209 负责找证据。**

## Current Fact Baseline

| Fact | Evidence | Consequence |
|------|----------|-------------|
| F201 已关闭 | `docs/features/F201-antigravity-reliability-contract.md` status is `done`; BACKLOG 不再列 F201 | 不 reopen F201；只补 post-close split-out note |
| F201 scope 是可靠性契约 | F201 covers failure explainability, side-effect journal, durable supervisor, controlled YOLO, recovery card, alpha smoke | Session transparency 是后续发现的新架构面，不属于 F201 close gate |
| F209 是检索层 | F209 spec states: “F209 只优化‘找证据、开原文、让猫判断’” | F211 不能塞成 F209 phase；F209 只消费 F211 输出 |
| F210 是 headless CLI migration | F210 scope excludes Bengal Desktop workflows and F201 Desktop reliability reopen | F211 targets Antigravity Desktop / cascade session visibility, not AGY CLI migration |
| Antigravity currently has a JSON shadow session map | `AntigravityBridge` uses `data/antigravity-sessions.json` for `threadId:catId -> cascadeId` | Cat Cafe cannot query or seal that state through SessionChainStore |
| `ephemeralSession: true` is a compatibility patch | Antigravity `session_init` can update active `cliSessionId` without seal/create on cascade rotation | First record may still be created, but rotation history can be collapsed into one record |
| SessionChainStore already supports `cliSessionId` lookup | `getByCliSessionId(cliSessionId)` exists in memory and Redis stores | Phase A should target records by cascadeId / cliSessionId, not by active `(catId, threadId)` mismatch |
| Session record alone is not enough | Bengal review noted Antigravity trajectory / thread messages are not automatically SessionChainStore events | Phase 0 must define transcript/digest materialization before implementation |
| Antigravity model can change inside one cascade | Bengal review noted a cascadeId may stay stable while the selected model/cat surface changes | Phase A/B must specify whether model/cat switches split sessions, become sub-runs, or remain metadata on one runtime session |
| `New Cascade` can be user-initiated | Bengal review noted manual New Cascade is distinct from threshold retire | `sealReason` must include user-initiated rollover, not only failure/retire classes |

## Scope

### In Scope

- Make Cat-Cafe-dispatched Antigravity cascades visible in Session Chain.
- Define the Antigravity transcript/digest source, not just the session record.
- Preserve cascade rotation history: old cascade gets sealed, new cascade gets a new session record.
- Register IDE-direct Antigravity conversations back into Cat Cafe so they are visible to session drill-down and future recall.
- Classify Antigravity cascade reset / retire reasons instead of flattening all resets into normal rollover.
- Define how model/cat identity changes inside one cascade are represented.
- Bootstrap the new Antigravity session after error/automatic rotation so Bengal Cat does not cold-start after a runtime reset.
- Define a noise policy for repeated `context canceled` / refused / canceled tool events before they enter digest-level memory.
- Retire `data/antigravity-sessions.json` as a shadow source once Redis SessionChainStore can own the binding.
- Define a reusable cross-runtime registration protocol for future runtimes such as Hub direct chat and F124 Apple surfaces.

### Out of Scope

- Reopening F201 reliability unless a reliability AC regresses.
- Rewriting F209 retrieval, entity registry, Perspective, or eval ownership.
- Migrating Gemini/AGY carrier behavior from F210.
- Solving concurrent same-thread same-cat multi-cascade fully in Phase A; Phase A must avoid corrupting data and document the limitation.
- Treating F209 `entity_id` as roster/session truth. Identity truth remains `identity-session`.

## What

### Phase 0: Design Memo + Current-State Audit

Produce a design memo before implementation. It must cover:

- Current Antigravity session sources: JSON map, cascadeId, SessionChainStore, transcript writer, digest/seal hooks.
- Current code paths for Cat-Cafe-dispatched Antigravity vs IDE-direct Antigravity.
- Exact lifecycle transitions: new cascade, repeated same cascade, retire, error reset, manual reset, IDE direct registration.
- Transcript and digest materialization path: which trajectory/thread/callback artifacts become session events, which become debug detail, and how `read_session_digest/events` proves non-empty useful content.
- Model/cat identity semantics when one cascade changes model without changing cascadeId.
- Drain / flush mechanism: how Bridge/AgentService knows old cascade tool results, pushToolResult calls, trajectory updates, and in-flight RPCs have settled enough to seal.
- Phase B registration mechanism without invocation-scoped callback credentials.
- Boundary with F210 AGY CLI cascade/session handling.
- Architecture cell decision: whether `identity-session` gets a new `identity-runtime-session` subcell or a narrower extension note.

### Phase A: Cat-Cafe-Dispatched Cascade Session Chain Bridge

Phase A is split into three implementation slices:

- **A1: Runtime metadata foundation** — add the runtime-session sidecar, lifecycle states, identity history, and read-only legacy JSON import prep. A1 does not flip live Antigravity lifecycle behavior and must not claim session continuity.
- **A2a: Lifecycle / seal / drain / reaper** — make Cat-Cafe-dispatched Antigravity sessions non-ephemeral, detect cascade rotation, seal by old cascade id, drain/flush old materialized events, and recover `runtime_seal_pending` records.
- **A2b: Cross-session continuity bootstrap** — when automatic/error-induced rotation creates a new session, prepend a Cat Cafe control block to the new session's first effective prompt so the cat receives the previous session digest, runtime metadata, and unfinished-work summary before continuing.

A2a and A2b both count toward F211 closure. A2b is not a new F212: the user-visible bug is that Antigravity session rotation currently drops working context even if F211 makes the old session searchable later.

Make the normal Cat Cafe -> Antigravity invocation path preserve cascade history.

Candidate minimal hook:

- `AntigravityAgentService` emits non-ephemeral `session_init` for cascade-backed invocations.
- Repeated `session_init` with the same cascadeId is a no-op.
- Cascade rotation seals the old record and creates a new record.
- User-triggered `New Cascade` seals the old record with a user-initiated reason, distinct from automatic retire/failure reasons.
- Seal target is located by cascadeId / `cliSessionId`, not by “active `(catId, threadId)` changed”.
- Seal occurs after old cascade flush / in-flight RPC settle, never on a read-path mismatch.
- Transcript/digest events are written from the agreed materialization path so the session is not an empty shell.
- For automatic/error-induced rotation, the new session receives a continuity bootstrap before the first planner response. The bootstrap body comes from the old session digest/events, runtime metadata, task snapshot, and side-effect journal summary; route continuity capsules are only a control envelope, not the content source.
- Antigravity does not currently expose a privileged system-context injection API. A2b must therefore define injection as a Cat Cafe control block prepended to the first effective prompt sent through the existing `sendMessage` path. If Antigravity later exposes system-context injection, the transport can change without changing the continuity contract.

Phase A is allowed to use existing session-chain semantics as a compatibility hook, but it must not claim this is the final long-lived-session model.

### Phase B: IDE-Direct Reverse Registration

When a user talks directly to Antigravity IDE / Bengal Cat outside a Cat Cafe dispatch, the cascade must register itself back into Cat Cafe.

Expected output:

- A session-chain record exists with `catId`, cascadeId / conversation id, runtime kind, and a recoverable thread/conversation anchor.
- Registration uses an explicit persistent-auth surface, for example `register_external_session({ runtime, cascadeId, conversationId, catId, model, title, startedAt })`; it must not assume invocation callback credentials exist.
- The user can later ask “孟加拉猫上次在 IDE 里聊的那个是什么” and Cat Cafe has a traceable starting point.
- Direct conversations are not confused with Cat-Cafe-dispatched thread messages unless an explicit binding exists.

This phase is high priority because IDE-direct work is part of the daily product surface, not a rare debug path.

### Phase C: Retire JSON Shadow State

Replace `data/antigravity-sessions.json` with SessionChainStore-backed lookup and migration.

- Bridge reads active cascade binding from SessionChainStore or a scoped runtime-session binding derived from it.
- Existing JSON entries are migrated once, with an audit trail.
- `resetSession()` / retire semantics write through the canonical store.
- JSON is deleted or retained only as read-only migration input until migration is complete.

### Phase D: Long-Lived Session Kind + Cross-Runtime Protocol

Generalize the model after Antigravity proves the path.

Candidate direction:

```ts
Session.kind = 'cli-invocation' | 'long-lived-cascade' | 'external-runtime-conversation'
```

The design must remain useful for:

- F210 AGY CLI runs if they produce cascade-like resumable conversations.
- Hub direct chat.
- F124 Apple / watchOS / AirPods conversations.
- Future IDE integrations beyond Antigravity.

### Phase E: Hub / In-Context Visibility

Expose runtime session state where users and cats notice it:

- Session Chain panel shows Antigravity cascade sessions and retire reason.
- Thread / handoff context can show “this cat has an external runtime session you can open/drill into.”
- Deep-dive view links cascadeId, conversation id, model/cat identity history, digest, transcript, and recovery metadata.
- Repeated cancellation/tool noise is folded into debug detail, not promoted into high-level digest unless it changes user-visible outcome.

## Acceptance Criteria

### Phase 0（Design Memo + Audit）
- [x] AC-0C: Design memo explicitly separates F211 from F201, F209, and F210 ownership.
- [x] AC-0D: Review request asks Bengal Cat to summarize F211 goals and list only problems / missed constraints. Bengal Cat confirmed the 7 kickoff review constraints are fully covered on 2026-05-24.
- [x] AC-0E: Design memo defines transcript/digest materialization with at least one proof that `read_session_digest` and `read_session_events` return meaningful Antigravity content, not just a session shell.
- [x] AC-0F: Design memo defines same-cascade model/cat identity changes and the storage shape for identity history.
- [x] AC-0G: Design memo defines the drain/flush mechanism or fail-closed policy for sealing after in-flight RPC / tool result settlement.
- [x] AC-0H: Design memo defines the F210 AGY CLI boundary: whether AGY uses F211 registration, its own session path, or an explicit adapter bridge.

### Phase A（Cat-Cafe-dispatched cascade bridge）
- [ ] AC-A1: Same cascadeId repeated `session_init` does not create a new session.
- [ ] AC-A2: CascadeId rotation seals the old session and creates a new session.
- [ ] AC-A3: Seal targets the old cascade by `cliSessionId` / cascadeId lookup, never by active `(catId, threadId)` mismatch alone.
- [ ] AC-A4: Seal happens after old cascade flush / in-flight RPC settle; read paths cannot trigger seal. If Antigravity does not expose an authoritative drain RPC, Phase A uses a documented quiet-window best-effort drain and records `drainResult`, while known in-flight work remains `runtime_seal_pending`.
- [ ] AC-A5: Resets/rollovers carry classified `sealReason` such as `oversized_retire`, `user_initiated`, `model_capacity`, `empty_response`, `tool_conflict`, `unsafe_side_effect`, or `runtime_disconnected`.
- [ ] AC-A6: Multi-cat single-thread cascades do not interfere with each other.
- [ ] AC-A7: Same-thread same-cat concurrent cascades are either safely supported or explicitly fail-closed with a documented limitation and no mis-seal.
- [ ] AC-A8: Cat-Cafe-dispatched Antigravity session records have non-empty session events/digest content from the agreed materialization path.
- [ ] AC-A9: Same cascadeId with changed model/cat identity is represented according to Phase 0 design and does not silently overwrite prior identity metadata.
- [ ] AC-A10: Pending seals have a concrete recovery path: a reaper/sweeper or documented manual recovery action retries `runtime_seal_pending` records and keeps them visible until resolved.
- [ ] AC-A11: `runtime_conflict_pending` is represented as runtime sidecar lifecycle state with an explicit transition path, not as an ad hoc `SessionRecord.status` value.
- [ ] AC-A12: Phase A treats `data/antigravity-sessions.json` as read-only legacy import only; no new cascade binding or reset path dual-writes JSON.
- [ ] AC-A13: Automatic/error-induced Antigravity session rotation creates a continuity bootstrap for the new session before the first planner response; the cat must not cold-start after `empty_response`, `stream_error`, `model_capacity`, `oversized_retire`, `tool_conflict`, `runtime_disconnected`, or similar non-user-initiated rotation.
- [ ] AC-A14: Continuity bootstrap content is built from sealed or best-available old-session evidence: digest/recent events, runtime metadata, unfinished task snapshot, and side-effect journal summary. A route continuity capsule may wrap/control the handoff, but it is not accepted as the actual evidence payload.
- [ ] AC-A15: The Antigravity injection contract is explicit: current implementation prepends a Cat Cafe control block to the first effective prompt sent via `sendMessage`; it must not claim privileged system-context injection unless Antigravity exposes and tests such an API.
- [ ] AC-A16: User-initiated `New Cascade` is classified separately and does not silently auto-inject prior-session continuity unless an explicit resume/bind action requests it. If old-session sealing is pending or incomplete, the bootstrap must carry a visible degraded/pending marker instead of pretending the prior session was fully sealed.

### Phase B（IDE-direct reverse registration）
- [ ] AC-B1: Antigravity IDE-direct conversation can create or update a Cat Cafe session-chain record without a prior Cat Cafe dispatch.
- [ ] AC-B2: IDE-direct record includes cascade/conversation id, cat id, runtime surface, timestamps, and enough provenance to drill down.
- [ ] AC-B3: IDE-direct sessions are searchable/drillable through existing session-chain tools or a documented extension.
- [ ] AC-B4: Direct IDE sessions do not pollute normal thread transcript unless explicitly bound.
- [ ] AC-B5: Registration contract does not require invocation callback credentials; it uses a persistent-agent or explicit external-session auth path with audit.
- [ ] AC-B6: Orphan IDE-direct runtime sessions are discoverable through an MCP/UI list/read surface by runtime, cat, and recent activity even before they are bound to a normal thread.

### Phase C（JSON shadow state retirement）
- [ ] AC-C1: `data/antigravity-sessions.json` is no longer the canonical source for cascade reuse.
- [ ] AC-C2: Existing JSON state has a one-time migration path or an explicit safe discard decision.
- [ ] AC-C3: Bridge reset / retire writes through canonical session binding state.
- [ ] AC-C4: Tests prove SessionChainStore is the single source of truth for cascade binding after migration.

### Phase D（Long-lived session kind / cross-runtime protocol）
- [ ] AC-D1: Spec defines the long-lived session kind or explains why existing session records are sufficient.
- [ ] AC-D2: Cross-runtime registration contract is generic enough for Antigravity, Hub direct chat, and F124-style external surfaces.
- [ ] AC-D3: Backward compatibility with CLI invocation sessions is tested.
- [ ] AC-D4: F210 AGY CLI runs either reuse F211 registration or explicitly document why their session lifecycle remains separate.

### Phase E（Visibility）
- [ ] AC-E1: Hub/session-chain UI can display Antigravity cascade sessions with status and retire reason.
- [ ] AC-E2: In-context thread/handoff surface can point cats to external runtime session evidence when relevant.
- [ ] AC-E3: Deep-dive view links session record, cascadeId/conversation id, transcript/digest, and recovery metadata.
- [ ] AC-E4: Digest-level views fold repeated `context canceled` / MCP refused / canceled step noise into summarized diagnostics unless it changes the user-visible outcome.

## Dependencies

- **Evolved from**: F201（Antigravity reliability closed; F211 is a post-close session transparency split-out, not a reopen）
- **Related**: F061（original Antigravity Desktop / Bengal Cat integration）
- **Related**: F102（memory architecture and evidence store; F211 feeds evidence into that ecosystem）
- **Related**: F124（future Apple / external runtime surfaces need the same registration protocol）
- **Related**: F194（invocation liveness read model; useful precedent for canonical runtime state）
- **Related**: F200（retrieval eval can later measure whether F211 sessions become discoverable）
- **Related**: F209（retrieval consumer; F209 finds evidence after F211 registers sessions）
- **Related**: F210（headless AGY migration; separate Antigravity surface, not the same Desktop/cascade problem）

## Risk

| 风险 | 缓解 |
|------|------|
| 把 F211 错塞进 F209，混淆“产生证据”和“找证据” | KD-1/KD-6 固化边界；F209 只作为 consumer |
| Phase A 直接 flip `ephemeralSession` 导致误 seal 活跃 cascade | AC-A3/A4：只按 cascadeId 反查 seal target，flush 后 seal，禁止 read-path seal |
| 只建 session record，transcript/digest 仍为空 | AC-0E/A8：实现前定义 materialization path，并用 session readers 证明有意义内容 |
| 同一 cascade 内切模型导致 catId/session attribution 错乱 | AC-0F/A9：明确 identity history 或 split-session 规则 |
| 手动 New Cascade 被误记成异常 retire | AC-A5：`user_initiated` sealReason 单列 |
| “flush 完成”不可观测导致 seal 丢尾 | AC-0G/A4：实现 drain/settle 机制；做不到则 fail-closed 延迟 seal，不在 read path 猜 |
| Antigravity 没有权威 drain RPC，Phase A 实现卡住或自由发挥 | AC-A4：先 probe runtime drain capability；无 RPC 时用 quiet-window best-effort + `drainResult` 标记，已知 in-flight 仍 pending |
| `runtime_seal_pending` 没有 reaper，永远悬空 | AC-A10：Phase A 必须交付 reaper/sweeper 或 manual recovery，并保持 pending visible |
| 同 thread 同 cat 并发 cascade 被错误当成轮换 | AC-A7：Phase A 不支持也必须 fail-closed，不能误 seal |
| 并发冲突状态被随手塞进 SessionRecord.status，破坏 session-chain enum | AC-A11：冲突是 runtime sidecar lifecycle state，SessionRecord 状态保持现有语义 |
| Session rotation 后只把旧 session 存起来，但新 session 仍冷启动 | AC-A13/A14：A2b 必须把 digest/runtime/task/side-effect 摘要注入新 session 的首个 effective prompt |
| Continuity bootstrap 被伪装成用户消息，污染语义或诱发 prompt-injection 混淆 | AC-A15/A16：control block 标明是 Cat Cafe control-flow data；manual New Cascade 不默认续接；pending/incomplete evidence 必须显式降级 |
| Phase B 没有 threadId/callbackToken，注册路径空转 | AC-B5：定义 persistent external-session registration auth，不假设 invocation 凭证 |
| Orphan runtime session 创建了但没人找得到 | AC-B6/E1~E3：必须有 list/read surface；搜索索引可后续增强，但近期 orphan 可列出 |
| F210 AGY CLI 也产生 cascade-like session，和 F211 打架 | AC-0H/D4：Design Memo 先定 owner/bridge，不让两个 feature 各管一半 |
| `context canceled` 等平台噪音污染 digest | AC-E4：高层 digest 聚合，debug detail 保留原始事件 |
| JSON 退役过早导致现有 cascade 丢失 | AC-A12 + Phase C：Phase A 只读导入，不 dual-write；Phase C 再删除 import |
| JSON 与 SessionChainStore dual-write 形成新 split-brain | AC-A12/KD-8：运行期只写 runtime-session binding |
| IDE-direct 反向注册把私聊污染进正常 thread | AC-B4：直接对话默认独立，显式绑定才进 thread transcript |
| 长期模型仍被 CLI-session 词汇绑住 | Phase D 明确 long-lived session kind / cross-runtime protocol，不让 Phase A 兼容 hook 变终态 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F211 独立立项，不挂 F209 phase | F209 是 retrieval/read layer；F211 是 source registration/session lifecycle layer | 2026-05-24 |
| KD-2 | F201 保持 done，只加 post-close split-out note | F201 reliability close gate 已完成；session transparency 是新发现的架构面 | 2026-05-24 |
| KD-3 | Phase A 可用 `cliSessionId=cascadeId` 作为兼容 hook，但不声明为终态模型 | 先接入现有 SessionChainStore；保留未来 `Session.kind=long-lived-cascade` 升级空间 | 2026-05-24 |
| KD-4 | Seal target 必须按 cascadeId / `cliSessionId` 反查，不能按 active mismatch 一刀切 | 防止同 thread 同 cat 或多窗口并发导致误 seal 仍活 cascade | 2026-05-24 |
| KD-5 | IDE-direct reverse registration 升为 Phase B 高优先级 | team lead日常会直接在 Antigravity IDE 和 Bengal Cat 工作；这不是低频调试路径 | 2026-05-24 |
| KD-6 | F209 是 F211 的 downstream consumer | F211 让 session/transcript/digest 进入系统，F209/F200 后续负责召回和评估 | 2026-05-24 |
| KD-7 | Bengal kickoff review 的 7 条问题升级为 Phase 0/AC 门禁 | 这些不是实现细节：transcript source、cat identity、manual New Cascade、drain、registration auth、F210 boundary、noise policy 都会决定 F211 是否真的解决失忆 | 2026-05-24 |
| KD-8 | Phase A 不 dual-write JSON 和 SessionChainStore | `data/antigravity-sessions.json` 只作为 read-only legacy import；新 cascade binding 只写 runtime-session state，避免制造第二代影子状态 | 2026-05-24 |
| KD-9 | Pending seal 必须有 reaper 或 manual recovery | fail-closed 不能等价于永久悬空；pending session 要可见、可重试、可收口 | 2026-05-24 |
| KD-10 | Continuity break 是 F211 内 bug，不另开 F212 | F211 的目标从“session 透明/可检索”收口为“session 透明 + session rotation 后连续”；只存旧 session 但让新 session 失忆仍未解决用户现场问题 | 2026-05-24 |
| KD-11 | A2 拆为 A2a lifecycle 和 A2b continuity bootstrap | A1 storage、A2a lifecycle、A2b continuity 是同一终态的可 review 切片；A2b 不承诺 privileged system context，当前走 first effective prompt control block | 2026-05-24 |

## Eval / Tracking Contract

| 项 | 内容 |
|----|------|
| **Primary Users** | 需要恢复 Antigravity/Bengal Cat 工作上下文的猫和team lead；Activation Signal：`list_session_chain` / `read_session_digest` / `search_evidence` 查询 Antigravity 旧工作 |
| **Friction Metric** | Antigravity 相关工作在 UI 可见但 session-chain 查不到的次数；IDE-direct conversation 事后无法定位的次数；cascade rotation 后 digest/transcript 被覆盖或丢尾的次数 |
| **Regression Fixture** | ① 同 cascadeId 重复 init 不新建 session ② cascadeId 轮换 seal+create ③ retire 中途切换后两个 digest 分开 ④ error reset / user New Cascade 分类写入 sealReason ⑤ IDE-direct registration 后 session-chain 可列出 ⑥ materialized Antigravity session events/digest 非空且降噪 ⑦ automatic/error-induced rotation 后新 session 首个 effective prompt 含 continuity bootstrap |
| **Sunset Signal** | 6 个月后 Antigravity 工作仍主要靠人工截图/口述恢复，或 F211 产出的 records 从未被 session-chain / search_evidence 消费 → 重新评估 registration model |

## In-context Observability Decision

```yaml
in_context_observability:
  primary_surface: "Session Chain panel + thread/handoff context pointer for external runtime sessions"
  why_not_dashboard_only: "失忆发生在猫接球和用户追问旧事的现场；dashboard 只能事后审计，不能替代接球时的上下文恢复。"
  deep_dive_surface: "Hub session-chain detail / runtime session debug view with cascadeId, transcript, digest, retire reason"
  noise_dedup_policy: "Only lifecycle edges register/retire/error-reset emit visible state; per-step churn is folded into digest/debug detail by cascadeId+catId."
```

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “Antigravity 的 session 得是透明的” | AC-A1~A9, AC-E1~E4 | SessionChainStore tests + session reader proof + Hub/session-chain display | [ ] |
| R2 | “先把 F201 关闭，然后剩下的记录到 F211” | KD-2, F201 post-close note | F201 timeline note + BACKLOG F211 row | [x] |
| R3 | “这个和 F209 啥关系？F209 不是检索的吗？” | KD-1, KD-6, AC-0C | Spec ownership boundary review | [x] |
| R4 | “可以找 antig-opus，让他只需要讲出来问题；顺便总结 F211 想做什么” | AC-0D | Review request message to `@antig-opus` | [x] |
| R5 | IDE 直开和孟加拉猫聊天也要能找回 | AC-B1~B6 | IDE-direct registration fixture / list/read discoverability validation | [ ] |
| R6 | JSON shadow state 不该继续当真相源 | AC-A12, AC-C1~C4 | Read-only import + migration test + removal/audit diff | [ ] |
| R7 | Bengal review: “session chain 里有记录但 digest/events 为空仍然没用” | AC-0E, AC-A8 | `read_session_digest/events` proof fixture | [ ] |
| R8 | Bengal review: “同一 cascade 可换 model/catId，manual New Cascade 也常见” | AC-0F, AC-A5, AC-A9 | identity-history + sealReason tests | [ ] |
| R9 | Bengal review: “IDE-direct 没 threadId/callbackToken，Phase B 注册机制要具体” | AC-B5, OQ-10 | external-session registration contract | [ ] |
| R10 | Bengal review: “context canceled 噪音不要污染 digest” | AC-E4, OQ-11 | noisy trajectory fixture | [ ] |
| R11 | team lead现场反馈：session 指 Antigravity cascade；错误/轮换后新 session 不能断记忆 | AC-A13~A16, KD-10, KD-11 | A2b continuity bootstrap fixture + manual New Cascade non-injection fixture | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 可观测性入口不是 dashboard-only

## Review Gate

- Kickoff docs: Bengal Cat (`@antig-opus`) review for lived Antigravity constraints; request style = summarize F211 goal + list problems only.
- Design Memo: Ragdoll Opus 4.7 architecture review + Bengal Cat Antigravity surface review.
- Phase A1 plan: Opus 4.7 architecture review + Bengal Cat Antigravity surface review before worktree/TDD.
- Phase A2a/A2b plan: Opus 4.7 architecture review for lifecycle/bootstrap contract + Bengal Cat Antigravity surface review for Desktop UX and injection semantics.
- Implementation: cross-family review before PR; no self-review.
