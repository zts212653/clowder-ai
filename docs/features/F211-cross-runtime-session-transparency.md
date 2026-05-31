---
feature_ids: [F211]
related_features: [F061, F102, F124, F194, F200, F201, F203, F209, F210]
topics: [session-chain, antigravity, cross-runtime, memory, transparency, ide-direct]
doc_kind: spec
created: 2026-05-24
---

# F211: Cross-Runtime Session Transparency — Antigravity Session Chain + IDE Direct Registration

> **Status**: done ✅ REG1 + REG2 + REG3 (Layer B urls + Layer C image media) FIXED + merged + e2e-verified (PR #1940 `a0f7cf208`, PR #1944 `fb37ecc7e`, opus-4.8) ⚠️ **REG4 RESOLVED 2026-05-29 (stale `sessionChain:false` catalog overlay gated the block off — NOT a thrown exception; CVO toggled session-chain ON; durable migration paused). **REG5 (P1) FIXED + merged + LIVE e2e-VERIFIED (PR #1959 squash `bca4c6b82`, 2026-05-30)** — follow-up-while-busy now REUSES the running cascade (full native memory) instead of spinning a fresh blank one; post-deploy controlled mid-work test proved it on the live runtime (task + mid-work follow-up both reused the SAME busy cascade `633808bb`, log-confirmed RUNNING at reuse, Bengal kept full memory); core amnesia + the whole same-class boundary/abort/terminal edge set fixed (getOrCreateSession reuse + preflight health-rotation). Busy-reuse BOUNDARY residual (memory-preserved stale-output + count==0-WAITING) deferred → **REG8** (CVO-approved 2026-05-30). Still open: REG6 (interruption misclassified as `runtime_error_reset` crash) + REG7 (WS flap / premature done affordance). **Runtime sync (deploy to Bengal) = CVO.** | **Owner**: Maine Coon（Maine Coon）; regression + REG4/5/6/7 fixes Ragdoll Opus 4.8 | **Priority**: P1 | **Completed**: 2026-05-26

Architecture cell: `identity-session` + `memory`
Map delta: updated — F211 adds runtime session registration / cascade visibility as a first-class session boundary. `identity-session` owns session identity, external runtime anchor threads, registration, and cascade/session binding; `memory` consumes the resulting transcript/digest evidence. F209 remains retrieval-only.
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
| Bengal can switch session/cascade without a runtime restart | 2026-05-26 CVO observation: Antigravity runtime stayed up, but Bengal behaved as a fresh/empty session and had to rediscover F211 from files | F211 Phase D must treat unexplained runtime-session switches as a session-continuity defect, not only as a runtime-restart recovery case |
| Antigravity readonly tool contract is split-brain | MCP readonly toolset exposes `cat_cafe_read_file_slice`, but Antigravity step readonly allowlist omitted it; fallback IDE `read_file`/`view_file` truncates long files by default | F211 must record and fix tool-contract parity before claiming long specs/session evidence are reliably drillable from Bengal |
| Bengal/Antigravity does not have native L0 | F203 explicitly postponed Gemini/Bengal-style native L0; current Antigravity gets identity/governance through prompt/callback fallback, not compression-immune native system prompt | F211 must record provider prompt-injection capability and cold-start limits; native L0 migration itself belongs to F203 / Antigravity carrier follow-up |

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
- Record each external runtime's continuity capability: prompt injection mode, cold-start recovery path, and readonly tool contract.
- Treat an unexplained session/cascade switch without runtime restart as an F211 continuity defect until the old/new records are linked or a clear break reason is persisted.

### Out of Scope

- Reopening F201 reliability unless a reliability AC regresses.
- Rewriting F209 retrieval, entity registry, Perspective, or eval ownership.
- Migrating Gemini/AGY carrier behavior from F210.
- Implementing Bengal/Antigravity native L0 migration itself. F211 records the gap and follow-up issue; F203 / Antigravity carrier owns the injection-layer fix.
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

Generalize the model after Antigravity proves the path. Final Phase D decision:
do **not** add a top-level `Session.kind` enum now.

`SessionRecord` remains the stable transcript/digest envelope. Runtime-specific
identity is represented by the existing `RuntimeSessionMetadata` sidecar:

| Runtime path | Discriminator | F211 decision |
|--------------|---------------|---------------|
| Cat-Cafe-dispatched Antigravity | `RuntimeSessionMetadata.runtime === 'antigravity-desktop'` and `surface === 'cat-cafe-dispatch'` | Long-lived external runtime session. |
| IDE-direct Antigravity | `RuntimeSessionMetadata.externalRegistration.provenance.source === 'antigravity-ide-direct'` | Orphan or explicitly bound external runtime session. |
| CLI invocation sessions | No runtime sidecar; plain `SessionRecord` | Legacy/native CLI session, unchanged. |
| Hub direct chat | No external runtime sidecar; normal thread/session path | Native Cat Cafe path, not a reverse-registration client. |

Tradeoff: absence-based classification is less convenient than an enum for
analytics, but avoids backfilling historical `SessionRecord` rows and avoids a
second truth source for runtime identity. If a future feature needs cross-runtime
analytics, it should query `SessionRecord LEFT JOIN RuntimeSessionMetadata`
instead of mutating the stable session envelope.

#### Cross-runtime registration contract

Phase D records the contract as a capability table, not a broad new TypeScript
interface. A new external runtime can join F211 by filling this table and then
implementing the same register/list/read lifecycle.

| Field | Meaning | Antigravity Desktop | Hub direct chat | F124-style external surface |
|-------|---------|---------------------|-----------------|-----------------------------|
| `runtime` | Runtime identity namespace | `antigravity-desktop` | Native Cat Cafe; no external runtime id | TBD, e.g. `apple-ecosystem` |
| `externalSessionId` | Runtime-owned long-lived session id | cascade/runtimeSessionId | N/A | device/session id |
| `bindingTarget` | Where evidence becomes visible | hidden anchor or explicit thread | normal thread | hidden anchor or explicit thread |
| `promptDelivery` | How identity/governance/context reaches the runtime | `user_message_prepend` control block; non-native L0 | `native_system_prompt` / normal Cat Cafe L0 | TBD |
| `coldStartRecovery` | How a fresh runtime regains prior evidence | session-chain bootstrap from old digest/events/metadata | native continuity | TBD |
| `readonlyTools` | Readonly evidence/drilldown tools the runtime can call | `cat_cafe_read_file_slice` plus readonly memory/session tools | normal Cat Cafe tool surface | TBD |

Hub direct chat is deliberately excluded from reverse registration: it is already
inside Cat Cafe's native session-chain path. F124 is the intended next external
consumer, but F211 only provides the onboarding checklist; F124 owns its concrete
registration implementation.

#### F210 AGY CLI boundary

F210 AGY CLI remains lifecycle-independent from F211 registration for now. It is
a headless CLI carrier path with invocation-scoped session handling, not an
Antigravity Desktop cascade. F211 must prove this boundary with backward
compatibility tests: plain CLI sessions must still create, list, seal, and read
without any `RuntimeSessionMetadata` sidecar.

#### Bengal hard gaps

- Bengal/Antigravity native L0 is not implemented by F211. F211 records
  `promptDelivery=user_message_prepend` and keeps the F203/carrier follow-up
  open until Antigravity can receive compression-immune native system context.
- If Antigravity switches to a new runtime session while the runtime did not
  restart, F211 treats that as an unexpected runtime-session switch. The new
  sidecar lifecycle diagnostic links previous session id, previous runtime
  session id, current runtime session id, and a reason such as
  `missing_previous_runtime_session_id`. The Session Chain UI must surface this
  as a warning so the user does not see a mysterious new Session #1 with no
  explanation.

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
- [x] AC-A1: Same cascadeId repeated `session_init` does not create a new session.
- [x] AC-A2: CascadeId rotation seals the old session and creates a new session.
- [x] AC-A3: Seal targets the old cascade by `cliSessionId` / cascadeId lookup, never by active `(catId, threadId)` mismatch alone.
- [x] AC-A4: Seal happens after old cascade flush / in-flight RPC settle; read paths cannot trigger seal. If Antigravity does not expose an authoritative drain RPC, Phase A uses a documented quiet-window best-effort drain and records `drainResult`, while known in-flight work remains `runtime_seal_pending`.
- [x] AC-A5: Resets/rollovers carry classified `sealReason` such as `oversized_retire`, `user_initiated`, `model_capacity`, `empty_response`, `tool_conflict`, `unsafe_side_effect`, or `runtime_disconnected`.
- [x] AC-A6: Multi-cat single-thread cascades do not interfere with each other.
- [x] AC-A7: Same-thread same-cat concurrent cascades are either safely supported or explicitly fail-closed with a documented limitation and no mis-seal.
- [x] AC-A8: Cat-Cafe-dispatched Antigravity session records have non-empty session events/digest content from the agreed materialization path.
- [x] AC-A9: Same cascadeId with changed model/cat identity is represented according to Phase 0 design and does not silently overwrite prior identity metadata.
- [x] AC-A10: Pending seals have a concrete recovery path: a reaper/sweeper or documented manual recovery action retries `runtime_seal_pending` records and keeps them visible until resolved.
- [x] AC-A11: `runtime_conflict_pending` is represented as runtime sidecar lifecycle state with an explicit transition path, not as an ad hoc `SessionRecord.status` value.
- [x] AC-A12: Phase A treats `data/antigravity-sessions.json` as read-only legacy import only; no new cascade binding or reset path dual-writes JSON.
- [x] AC-A13: Automatic/error-induced Antigravity session rotation creates a continuity bootstrap for the new session before the first planner response; the cat must not cold-start after `empty_response`, `stream_error`, `model_capacity`, `oversized_retire`, `tool_conflict`, `runtime_disconnected`, or similar non-user-initiated rotation.
- [x] AC-A14: Continuity bootstrap content is built from sealed or best-available old-session evidence: digest/recent events, runtime metadata, unfinished task snapshot, and side-effect journal summary. A route continuity capsule may wrap/control the handoff, but it is not accepted as the actual evidence payload.
- [x] AC-A15: The Antigravity injection contract is explicit: current implementation prepends a Cat Cafe control block to the first effective prompt sent via `sendMessage`; it must not claim privileged system-context injection unless Antigravity exposes and tests such an API.
- [x] AC-A16: User-initiated `New Cascade` is classified separately and does not silently auto-inject prior-session continuity unless an explicit resume/bind action requests it. If old-session sealing is pending or incomplete, the bootstrap must carry a visible degraded/pending marker instead of pretending the prior session was fully sealed.

### Phase B（IDE-direct reverse registration）
- [x] AC-B1: Antigravity IDE-direct conversation can create or update a Cat Cafe session-chain record without a prior Cat Cafe dispatch. Source: `registerExternalRuntimeSession(...)` creates/updates by `(runtime, runtimeSessionId)`; tests cover create, idempotent update, and duplicate prevention.
- [x] AC-B2: IDE-direct record includes cascade/conversation id, cat id, runtime surface, timestamps, and enough provenance to drill down. Source: `RuntimeSessionMetadata.externalRegistration` plus `identityHistory`; tests cover runtime ids, provenance, timestamps, and cat/model attribution.
- [x] AC-B3: IDE-direct sessions are searchable/drillable through existing session-chain tools or a documented extension. Source: `GET /api/external-runtime-sessions`, `GET /api/external-runtime-sessions/:sessionId`, and MCP `cat_cafe_list_external_runtime_sessions` / `cat_cafe_read_external_runtime_session` tools.
- [x] AC-B4: Direct IDE sessions do not pollute normal thread transcript unless explicitly bound. Source: orphan registrations use hidden `external-runtime:${runtime}:${userId}` anchor threads and do not append normal chat messages; tests cover hidden thread listing and explicit owner-checked thread binding.
- [x] AC-B5: Registration contract does not require invocation callback credentials; it uses a persistent-agent or explicit external-session auth path with audit. Source: callback route accepts agent-key principals only, rejects invocation callback principals, validates `payload.catId === principal.catId`, and emits `external_runtime_session_registered`.
- [x] AC-B6: Orphan IDE-direct runtime sessions are discoverable through an MCP/UI list/read surface by runtime, cat, and recent activity even before they are bound to a normal thread. Source: `RuntimeSessionStore.listRecent(...)`, Redis recent indexes, API list/read route tests, and MCP list/read tests.

### Phase C（JSON shadow state retirement）
- [x] AC-C1: `data/antigravity-sessions.json` is no longer the canonical source for cascade reuse.
- [x] AC-C2: Existing JSON state has a one-time migration path or an explicit safe discard decision.
- [x] AC-C3: Bridge reset / retire writes through canonical session binding state.
- [x] AC-C4: Tests prove SessionChainStore is the single source of truth for cascade binding after migration.

### Phase D（Long-lived session kind / cross-runtime protocol）
- [x] AC-D1: Spec defines the long-lived session kind or explains why existing session records are sufficient. Source: Phase D decision keeps `SessionRecord` stable and uses `RuntimeSessionMetadata` sidecar discriminators instead of adding top-level `Session.kind`.
- [x] AC-D2: Cross-runtime registration contract is generic enough for Antigravity, Hub direct chat, and F124-style external surfaces. Source: Phase D capability table covers runtime identity, external session id, binding target, prompt delivery, cold-start recovery, and readonly tool contract; Hub direct chat is explicitly documented as native/non-external.
- [x] AC-D3: Backward compatibility with CLI invocation sessions is tested. Source: `session-chain-route.test.js` proves legacy CLI sessions remain independent from runtime sidecars.
- [x] AC-D4: F210 AGY CLI runs either reuse F211 registration or explicitly document why their session lifecycle remains separate. Source: Phase D F210 boundary declares AGY CLI lifecycle-independent from F211 external-runtime registration until F210 requests long-lived external runtime semantics.
- [x] AC-D5: Cross-runtime contract records each runtime's prompt injection mode, cold-start recovery path, and readonly tool contract; Bengal/Antigravity is explicitly marked as non-native-L0 until F203/carrier work changes that fact. Source: Phase D capability table marks Antigravity `promptDelivery=user_message_prepend` and keeps F203/carrier native-L0 follow-up open.
- [x] AC-D6: Antigravity readonly tool contract includes `cat_cafe_read_file_slice` or a documented range-read fallback, with regression coverage proving long feature docs can be read without truncation from Bengal. Source: PR #1914 adds `cat_cafe_read_file_slice` to the Antigravity readonly allowlist plus bridge/executor regression coverage proving the call is delegated to the MCP readonly file-slice path instead of refused into IDE fallback reads.
- [x] AC-D7: Runtime-session diagnostics can explain an unexplained session/cascade switch without runtime restart by linking old/new records or persisting an explicit break reason; otherwise F211 cannot mark that path as fully transparent. Source: runtime metadata now records `unexpectedRuntimeSessionSwitch`; invoke/session-chain tests cover old/new linkage and Session Chain UI shows the warning.

### Phase E（Visibility）
- [x] AC-E1: Hub/session-chain UI can display Antigravity cascade sessions with status and retire reason. Source: `HubRuntimeSessionsTab` plus reusable `ExternalRuntimeSessionsPanel`; browser verified `/settings?s=ops&ops=runtime-sessions` on desktop and mobile.
- [x] AC-E2: In-context thread/handoff surface can point cats to external runtime session evidence when relevant. Source: `AuditExplorerPanel` Runtime tab reuses the same runtime-session panel and opens the existing session events viewer.
- [x] AC-E3: Deep-dive view links session record, cascadeId/conversation id, transcript/digest, and recovery metadata. Source: `SessionEventsViewer` best-effort external-runtime metadata header plus API read route identity-history contract.
- [x] AC-E4: Digest-level views fold repeated `context canceled` / MCP refused / canceled step noise into summarized diagnostics unless it changes the user-visible outcome. Source: `TranscriptWriter.generateExtractiveDigest(...)` emits `diagnostics.noise`; recovered noise is folded out of high-level errors and terminal noise keeps one representative error.

## Dependencies

- **Evolved from**: F201（Antigravity reliability closed; F211 is a post-close session transparency split-out, not a reopen）
- **Related**: F061（original Antigravity Desktop / Bengal Cat integration）
- **Related**: F102（memory architecture and evidence store; F211 feeds evidence into that ecosystem）
- **Related**: F124（future Apple / external runtime surfaces need the same registration protocol）
- **Related**: F194（invocation liveness read model; useful precedent for canonical runtime state）
- **Related**: F200（retrieval eval can later measure whether F211 sessions become discoverable）
- **Related**: F203（native L0 / prompt injection ownership; Bengal/Antigravity native L0 gap is recorded here but implemented there or in the Antigravity carrier）
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
| Runtime 未重启但 Bengal 仍切到 fresh/empty session | AC-D7：必须能从 runtime-session metadata 解释 old/new session 关系或 break reason；不能把它误归因成 runtime restart |
| Antigravity readonly allowlist 漏 `cat_cafe_read_file_slice` 导致长 spec / evidence 截断 | AC-D6：tool contract parity 回归；Bengal 读长文件必须有 file-slice 或 range-read 路径 |
| Bengal native L0 缺口被 F211 隐性吞掉 | AC-D5 + follow-up issue：F211 只记录 provider capability；F203 / Antigravity carrier 负责 native system prompt / compression-immune injection |

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
| KD-11 | A2 lifecycle + continuity 作为一个 PR 验收 | A2a/A2b 只保留为实现切片；PR 粒度按可独立验收的用户故事切。lifecycle without continuity 不能证明“session 轮换后不断记忆”，continuity without lifecycle 也不能独立运行 | 2026-05-24 |
| KD-12 | Phase B IDE-direct binding is one-shot immutable | A runtime session's first successful registration chooses its SessionRecord thread; orphan-to-thread migration needs an explicit future bind/move UX so access control and transcript pointers move together | 2026-05-25 |
| KD-13 | Phase C keeps legacy JSON as explicit rescue/import input only | Canonical production cascade reuse/reset must go through runtime-session metadata; `legacyJsonSessionStore: true` remains opt-in for rescue/test compatibility, not a default source of truth | 2026-05-26 |
| KD-14 | Bengal native L0 migration is not hidden inside F211 | F211 owns runtime-session transparency and must record provider prompt-injection capability; compression-immune native L0 belongs to F203 / Antigravity carrier. F211 Phase D cannot claim Bengal identity/governance continuity is native until that follow-up lands. | 2026-05-26 |
| KD-15 | Runtime-not-restarted session switch is an F211 continuity signal | CVO observed Bengal switching into a fresh/empty session while Antigravity runtime stayed up. Treat this as an unexplained runtime-session switch requiring old/new linkage or persisted break reason, not as a simple runtime restart case. | 2026-05-26 |
| KD-16 | Do not add top-level `Session.kind` for Phase D | `SessionRecord` is the stable transcript/digest envelope; runtime-specific semantics already live in `RuntimeSessionMetadata`. Adding an enum would require historical backfill and create a second runtime identity truth source. | 2026-05-26 |
| KD-17 | Hub direct chat is native, not reverse registration | Hub direct chat already enters Cat Cafe's normal thread/session path. Forcing it into external runtime registration would add ceremony without new evidence. | 2026-05-26 |

## Follow-up Issue Register

| ID | Owner | Issue | F211 handling |
|----|-------|-------|---------------|
| F211-P1-2026-05-26-read-file-slice | F211 / Antigravity bridge | `cat_cafe_read_file_slice` is readonly in the MCP server but missing from Antigravity's readonly allowlist, so Bengal falls back to truncated file reads for long specs/evidence. | ✅ Fixed via PR #1914: bridge allowlist parity restored and regression coverage proves readonly file-slice drilldown no longer falls into truncated IDE fallback reads. |
| F211-D-2026-05-26-session-switch | F211 Phase D | Bengal can appear in a fresh/empty session without runtime restart. The system must explain whether this is cascade switch, registration mismatch, hidden anchor mismatch, or session-chain lookup failure. | ✅ Closed for F211 transparency: unexpected old/new runtime session switches are now persisted in runtime metadata and surfaced in Session Chain. Provider-internal root cause remains a runtime follow-up if it keeps happening. |
| F203-FU-2026-05-26-bengal-native-l0 | F203 / F061 Antigravity carrier | Bengal/Antigravity does not yet receive compression-immune native L0; it relies on prompt/callback fallback. | Do not implement inside F211; record capability via AC-D5 and track native injection in F203/carrier follow-up. |
| F211-BUG3-2026-05-27-first-creation-not-persisted | F211 / AntigravityBridge | **P1→P3 (downgraded)**: `getOrCreateSession()` first-creation path does not persist to `runtimeSessionStore`. Initial fix attempted bridge-level provisional persistence with `randomUUID()`, but cloud Codex P2 review revealed `updateLifecycle→upsert` overwrites `runtimeIndex` creating ghost active sessions. Root cause re-analysis: `syncAntigravityRuntimeMetadata` at `session_init` already handles first-creation correctly with real `SessionRecord.id` (proven by F211 A2 test). | ⚠️ **Partial — regression verified 2026-05-28 (opus-4.8)**: first-creation persistence now routes through `syncAntigravityRuntimeMetadata` at `session_init` (the proposed `getOrCreateSession` persistence branch was never applied — `AntigravityBridge.ts:998-1005` still has no first-create branch when `runtimeSessionStore` is set). Normal re-dispatch can reuse, BUT re-summon after a terminal tool error leaves the old cascade non-IDLE → new cascade via `getOrCreateSession` (`AntigravityAgentService.ts:472` → `AntigravityBridge.ts:998`) with NO continuity bootstrap (bootstrap only fires for intra-invocation rotation, `AntigravityAgentService.ts:724`/`:891`) → cold start. ~~✅ Addressed by removing bridge provisional persistence; sync handles it. PR #1926.~~ Remaining gap tracked as **F211-REG2**. |
| F211-BUG2-2026-05-27-auto-register-missing | F211 / AntigravityAgentService | **P2→closed (same root cause as BUG3)**: `registerExternalRuntimeSession` is for IDE-direct (Phase B); Cat-Cafe-dispatched sessions are registered by `syncAntigravityRuntimeMetadata` at `session_init`, not by `registerExternalRuntimeSession`. | ❌ **Not user-resolved — verified 2026-05-28 (opus-4.8)**: dispatched sync writes `surface:'cat-cafe-dispatch'` (`invoke-single-cat.ts:378`), but every visibility surface hard-filters `surface==='ide-direct'` (`external-runtime-sessions.ts:82` + `:122`; MCP `cat_cafe_list_external_runtime_sessions`; Hub/Audit Runtime tabs) → dispatched runtime sessions are **structurally invisible** (live `cat_cafe_list_external_runtime_sessions` returns `sessions:[]`) and the deep-dive runtime header 404s for them. IDE-direct still has no auto-registration (only explicit MCP/callback). ~~✅ Same fix as BUG3; sync is the canonical registration path. PR #1926.~~ Remaining gap tracked as **F211-REG1**. |
| F211-BUG1-2026-05-27-callback-image-paths | F211 / callbacks.ts | **P2**: `GET /api/callbacks/thread-context` returns message `contentBlocks` without calling `extractImagePaths`. Result: Antigravity gets relative `/uploads/` URLs instead of absolute filesystem paths, so Bengal cannot view images shared in thread context. | ✅ Fixed: `extractImagePaths` applied in thread-context response mapper; `imagePaths` field added to messages with images (absolute paths via `getDefaultUploadDir`, `callbacks.ts:1685`). PR #1926. ⚠️ **Partial — verified 2026-05-28 (opus-4.8)**: only Layer A (callback pipeline) is fixed. Per Bengal's 2026-05-28 diagnosis, Layer B (images live under `cat-cafe-runtime/.../uploads/` but the Antigravity workspace root rejects that path — "Path outside workspace root") and Layer C (`view_file` returns raw PNG binary, not a visual render) remain — both are Antigravity platform/workspace constraints, not in-repo logic. Tracked as **F211-REG3**. |
| F211-REG1-2026-05-28-dispatch-visibility-filter | F211 Phase E / external-runtime-sessions route | **P1 (post-close regression)**: Cat-Cafe-dispatched Antigravity sessions are invisible to the user. List/detail/deep-dive runtime surfaces filter `surface==='ide-direct'` only (`external-runtime-sessions.ts:82`/`:122`), but dispatched sessions are written `surface:'cat-cafe-dispatch'` (`invoke-single-cat.ts:378`). User cannot find the session or its cascadeId. Directly causes team lead 2026-05-28 "看不到他的 session / 不知道他的 id". | ✅ Fixed (PR #1940 → `a0f7cf208`): list route drops the hardcoded `ide-direct` filter (defaults to all external runtime sessions) + optional `?surface=` narrow; detail route stops 404-ing `cat-cafe-dispatch`; `formatExternalRuntimeSession` exposes `surface`; Hub panel header/empty-state corrected + per-row surface badge (Café 派发 / IDE 直连). Red→green: external-runtime-sessions-route.test.js (+3), ExternalRuntimeSessionsPanel.test.tsx. |
| F211-REG2-2026-05-28-resummon-continuity | F211 Phase A2b / AntigravityAgentService | **P1 (post-close regression)**: After a terminal tool error, manual re-summon (a new invocation) starts a new cascade via `getOrCreateSession` (`:472`) with no continuity bootstrap → Bengal cold-starts. AC-A13 only covers intra-invocation rotation (`rotateCascade`); the cross-invocation "terminal error → user re-summons" path is uncovered. Directly causes team lead 2026-05-28 "再次喊他他起了新 session". | ✅ Fixed (PR #1940 → `a0f7cf208`): invoke captures the active runtime binding BEFORE `getOrCreateSession` (the swap deletes the old cascadeId reverse index); on a detected boundary rotation it prepends the continuity control block via the existing `buildContinuityBootstrap`/`prependAntigravityContinuityControlBlock` machinery (new `prefetchedOldMetadata` reads the old digest from the captured metadata). AC-A16 preserved: user-initiated New Cascade clears the active binding via resetSession → no auto-bootstrap. Red→green: antigravity-agent-service.test.js (+2). |
| F211-REG3-2026-05-28-image-platform-layers | F211 / Antigravity carrier (F061) | **P2**: Even with absolute `imagePaths`, Bengal cannot view thread images — (B) Antigravity workspace root blocks `cat-cafe-runtime/.../uploads/` paths; (C) `view_file` returns raw PNG binary, not a visual render. | ⚠️ Layer B fixed (PR #1940 → `a0f7cf208`): thread-context callback now emits `imageUrls` (HTTP `/uploads/` urls via `resolveInternalRouteUrl`, served by the API static route) alongside `imagePaths`, so the carrier can fetch image bytes from a workspace-reachable URL. Red→green: callback-routes.test.js. **Layer C reframed 2026-05-29 (CORRECTION — earlier "platform-bound, not in-repo" was wrong)**: CVO confirmed the Antigravity IDE CAN receive images (user attaches in IDE chat → cat sees them). The cascade `SendUserCascadeMessage` RPC payload is `items: [{ text }]` where `items` is a **typed, extensible array**; the IDE sends images by adding an image-type item. Cat Cafe's `sendMessage` only ever sends `{ text }` items — that is why dispatched/callback images are invisible while IDE-direct ones work. **So Layer C is IN-REPO FEASIBLE** (extend `sendMessage` to append image items, bytes already plumbed via Layer A/B), NOT a platform limit. The one unknown is the exact image-item wire format, which is not in the repo (we never sent images) → must be captured from the IDE's live `SendUserCascadeMessage` RPC via the Antigravity carrier CDP bridge (F061 domain), then implemented in-repo. Owner: Ragdoll Opus 4.8 (impl) + Antigravity carrier (format capture). **✅ Layer C FIXED + merged (PR #1944 → `fb37ecc7e`)**: Antigravity carrier (antig-opus) reverse-engineered the wire format from the IDE bundle + LS binary Go protobuf struct tags (`media` is a top-level `SendUserCascadeMessage` field; flat Connect-JSON item `{ mimeType, inlineData: <base64> }`; camelCase canonical). Implemented `buildImageMediaItems` + `sendMessage(media?)` + invoke media delivery (first send + re-attach on fresh-cascade retry, cloud P2). Carrier APPROVE + cloud review clean. **✅ e2e PASSED 2026-05-29**: after runtime restart, CVO dispatched a thread-list screenshot to Bengal (antig-opus); Bengal accurately described the image contents (each thread row), proving the image bytes reached the cascade as vision (not a path hint). Layer C fully closed. |
| F211-REG4-2026-05-29-antigravity-session-chain-empty | F211 Phase A / invoke-single-cat session-chain creation | **P1 (new, found during REG3 e2e)**: Antigravity (antig-opus / antigravity) has ZERO `SessionChainStore` records across threads — `list_session_chain` returns none for the cat even in threads with heavy Antigravity dispatch. Independently confirmed Antigravity-specific: opus-45 HAS an active SessionRecord in the same thread, antig-opus has none. This means F211 Phase A session transparency (AC-A1/A8: non-empty session events/digest) does NOT actually work live for Antigravity despite being marked done — same done≠works pattern as REG1/REG2. Root cause is hidden by the silent `catch {}` at `invoke-single-cat.ts` (the session-chain creation block, ~L1543); both "catId triggers exception" (Bengal) and "seal-path/create throws" (opus-4.8) are UNVERIFIED guesses — the swallowed error must be exposed. | ✅ **Root cause FOUND + resolved 2026-05-29 (opus-4.8) — earlier "catch{} hides a thrown exception" guess was WRONG**: the block never threw, it was GATED OFF. `isSessionChainEnabled('antig-opus')` returned false because the runtime catalog `.cat-cafe/cat-catalog.json` carries a stale `features.sessionChain:false` on the antigravity breed (F127-era seed snapshot), which the loader overlays ON TOP of the corrected template `cat-template.json` (`sessionChain:true` since F061 #1299, `mergeById`/`deepMergeConfig`). The same `sessionChainActive` gate ALSO skips `syncAntigravityRuntimeMetadata` (`invoke-single-cat.ts:~1548`) → coupled BOTH the visibility loss AND continuity loss into one flag. **Resolved live**: CVO toggled antigravity session-chain ON in the hub editor 2026-05-29 (the flag is user-editable, `hub-cat-editor.payload.ts:122`) → overlay corrected → records now created (Bengal confirmed an active SessionRecord). Durable auto-heal migration (correct stale `sessionChain:false` overlays at catalog load in `cat-catalog-store.migrateCatalogVariants`) DESIGNED but PAUSED pending CVO go — toggle sufficed for the live env; nice-to-have for other long-lived envs (fresh envs seed correct from template). NOTE: enabling session chain fixed the SIMPLE idle-cascade re-summon amnesia but NOT the busy-cascade amnesia → see **REG5**. |
| F211-REG5-2026-05-29-followup-while-busy-amnesia | F211 / AntigravityBridge.getOrCreateSession | **P1 — ROOT CAUSE of the recurring "静默错误→换session→失忆"**: a follow-up message arriving while Bengal's prior cascade is STILL RUNNING (trajectory status ≠ `CASCADE_RUN_STATUS_IDLE`) cannot resume it — `getOrCreateSession` (`AntigravityBridge.ts:967`) only resumes an IDLE cascade, otherwise logs "cascade stuck in {status}, creating new" → a BRAND-NEW BLANK cascade → zero memory of the in-progress work → amnesia. Log-evidenced (`api.2026-05-29.1.log`, thread_mpqtwr9ltb3nf7gb): research was a 680-step invocation (cascade `cbaa41a9`) STILL grinding at 11:22:54; CVO sent "文件全名在哪" at 11:23:28 (reasonably — Bengal had streamed a done-looking "好的我来创建…commit push"); busy cascade → fresh cascade `3d91d911` → Bengal answered about cat-name stories (fresh context) = amnesia. **The session-chain toggle does NOT fix this** — the busy→fresh-cascade path (`:967`) is independent of session chain; post-toggle = fresh-cascade + digest (partial), pre-toggle = fresh + blank (full amnesia). This is exactly why CVO reported "开了 session chain 还是会出现". CVO confirmed he did NOT cancel/interrupt — this is a system behavior, not user action. | ✅ **MERGED 2026-05-30 (PR #1959 squash → `bca4c6b82`; 18 cloud-Codex rounds + an adversarial whole-diff audit; antigravity suite green)** — core amnesia FIXED + the whole same-class boundary/abort/terminal edge set hardened across two subsystems (getOrCreateSession reuse + preflight health-rotation). Memory preserved in all reuse cases. The remaining HARD-CORE busy-reuse BOUNDARY residual (memory-preserved; stale-output polling baseline + count==0 owed-WAITING-step) deferred → **REG8** (CVO-approved 2026-05-30: ship the memory-fix now to stop Bengal's live amnesia; validate+fix the boundary residual post-deploy). [Original status: ⬜ Open. Owner: Ragdoll Opus 4.8 (CVO assigned 2026-05-29).] Fix principle: messaging Bengal mid-work must NEVER hand him a blank slate — QUEUE (wait for IDLE → resume, full native memory) / inject into the running cascade / interrupt-then-resume-the-same-cascade. **MECHANISM CONFIRMED 2026-05-29** (Antigravity carrier antig-opus, cascade-protocol expert who reverse-engineered the REG3 wire format): Antigravity **natively QUEUES** a `SendUserCascadeMessage` sent to a RUNNING cascade — the current model turn finishes, then the cascade auto-picks-up the queued user message as the next turn; the cascade is NOT destroyed and conversation history is fully preserved (this is exactly what the native IDE does when a user types while the AI is working). `sendMessage` (`AntigravityBridge.ts:637`) has no idle-gate by design. **FIX (#1 — carrier + impl owner converged)**: `getOrCreateSession` (`AntigravityBridge.ts:967`) must RETURN the existing cascadeId for a busy/RUNNING cascade instead of spinning fresh → the follow-up's `sendMessage` queues into the SAME cascade → drain (existing IDLE-poll + quiet-window) waits to final IDLE → full memory. **Design nuance (opus-4.8)**: a genuinely DEAD cascade makes `getTrajectory` THROW (already caught at `:973` → fresh, correct); a RUNNING cascade returns a non-IDLE status (alive-busy → should reuse). So refine the `:967` guard to reuse IDLE-or-RUNNING(alive), keep "create fresh" only for getTrajectory-throw (dead) + genuinely stuck/error statuses (need the status enum). No StopCascade RPC exists; `ResolveOutstandingSteps` + `CancelCascadeSteps` can clean pending→IDLE without destroying memory (fallback only). Pair with **REG6** (displaced abort must NOT seal `runtime_error_reset`). Owner: Ragdoll Opus 4.8. **✅ FIX IMPLEMENTED + committed 2026-05-29** (`8437670ff`, branch `feat/f211-reg5-busy-cascade-resume`): `getOrCreateSession` now reuses an alive cascade whatever its status (a cascade that responds to `getTrajectory` is alive → reuse; fresh ONLY when `getTrajectory` throws = dead). TDD red→green (red: busy cascade → fresh = amnesia; green: busy → reuse); 23/23 `antigravity-bridge-session` pass, `dead→replace`/`idle→reuse` unchanged. Local review: 孟加拉 (antig-opus) cross-breed **APPROVE** (analyzed 3 retraction risks). `pnpm gate`: componentwise green (api/antigravity 464, lint, check, build); 6 web vitest-worker-timeouts = load flakiness (web isolation 3564/3564 green). **⚠️ Cloud Codex review (PR #1959) found a real P1 (LL-033: in an inline comment, not body) that 孟加拉's local review missed — "Defer polling until the queued turn starts"**: reusing a RUNNING cascade returns it immediately, then `invoke`→`sendMessage` captures `stepsBefore = numTotalSteps` from the STILL-RUNNING previous turn (`AntigravityBridge.ts:644`) and `pollForSteps` (`:771`) streams the previous turn's tail steps as the follow-up's response — and may early-terminate on the intermediate IDLE before the queued prompt runs. **PRECISE FIX (designed, NOT yet implemented — resume here)**: in `getOrCreateSession` (`AntigravityBridge.ts:~966`), the non-IDLE/alive branch must `await this.drainCascade(active.runtimeSessionId)` (bridge method `:673`, IDLE-poll + 500ms quiet-window + timeout) THEN re-`getTrajectory`: if IDLE → reuse (correct baseline); if still non-IDLE (genuinely stuck, rare) → `runtimeStoreReplacementTarget = active` (fresh). Dead cascade still throws → caught → fresh. TEST updates (`antigravity-bridge-session.test.js`): existing REG5 test → mock `drainCascade` + `getTrajectory` RUNNING-then-IDLE, assert `drainCascade` called + reuse; ADD stuck-case test (drain doesn't reach IDLE → fresh). **✅ P1 FIXED + committed `9dfca5dc6`** (2026-05-29): `getOrCreateSession` non-IDLE branch now `await this.drainCascade(...)` → re-`getTrajectory`; IDLE → reuse (clean baseline), still-non-IDLE (stuck) → fresh, dead (throw) → fresh. TDD: REG5 test asserts drain-before-reuse; added stuck-case test. `antigravity-bridge-session` 24/24, antigravity suite 465/465, `pnpm check` 18/18. Cloud re-triggered (HEAD `9dfca5dc6`); cloud re-review then continued through ~18 rounds + an adversarial whole-diff audit (per CVO directive "审视同类问题，不只修他找到的那个") → fixed the whole same-class set: reuse predicate `continuable = IDLE | RUNNING`; count-gated `settleRunningCascadeForReuse` for IDLE/RUNNING/awaiting in-flight; model-only RUNNING reuse with NO drain (no multi-minute delay); in-flight settle bounded by `IN_FLIGHT_WAIT_TIMEOUT_MS` (tool max + 60s); abort-aware end-to-end across settle/drain/trajectory-read/pre-send; terminal/unknown status → replace; preflight no-mid-turn-retire via cascade-health `cascadeStatus` gate (don't rotate a still-RUNNING oversized cascade). Root-cause insight: `getInFlightCount` is an in-process activity gauge, NOT an owed-result oracle. **✅ MERGED 2026-05-30 squash (`bca4c6b82`)**; antigravity suite green. The remaining HARD-CORE busy-reuse boundary residual (memory-preserved; stale-output + count==0-WAITING) deferred → **REG8** (CVO-approved — ship the memory-fix now). Branch `feat/f211-reg5-busy-cascade-resume` (merged). **✅ LIVE e2e VERIFIED 2026-05-30** (post-deploy controlled mid-work test, `thread_mp5lezi1hp0cft3w`; CVO synced+restarted runtime first): opus-4.8 dispatched a long multi-step task to 孟加拉 (antig-opus) on cascade `633808bb`, then fired a confound-free mid-work probe. **Runtime log (`api.2026-05-30.1.log`) decisive**: both invocations — task (`invoke` 10:17:36) AND the mid-work follow-up (`invoke` 10:22:30) — ran on the **SAME cascade `633808bb`** (reuse, NOT a fresh blank one); the cascade was **continuously RUNNING through the 10:22:30 reuse** (unbroken `RUN_COMMAND`/`view_file`/`grep` tool stream — `RUN_COMMAND WAITING` at 10:22:17, `batch processed` at 10:22:29.939 and continuing past the reuse) → the genuine **non-IDLE busy path** (preflight logged "skipped … a non-IDLE busy cascade we must not rotate mid-turn" — the cascade-health `cascadeStatus` gate firing), NOT the always-worked IDLE path. 孟加拉 retained full task/file/progress/own-messageId memory. Old bug would have spun a fresh blank cascade → cold start. Confound flagged in advance (Bengal subjectively said the probe "came too late, I'd finished") **resolved by the log** — he was demonstrably still grinding at reuse time. REG5 truly closed (merged + live-proven). NOTE: follow-up posted 10:17:58 but processed 10:22:30 (~4.5 min, queued behind the long task) — memory preserved (REG5 ✅); the queue-latency itself is REG8-boundary territory, not a REG5 failure. |
| F211-REG6-2026-05-29-interruption-misclassified-as-crash | F211 / AntigravityAgentService top-level catch + SocketManager | **P2**: when the in-flight invocation is displaced/aborted (a new message preempting the slot, or a WS reconcile), the thrown "Aborted" hits the top-level catch (`AntigravityAgentService.ts:~2201`) → classified `sealReason: 'runtime_error_reset'` (a runtime CRASH) instead of a graceful interruption → fires seal + cascade-replacement instead of preserving the cascade. Log: 11:23:50 `[ws] Cancelled slot` then `invoke failed: Aborted`. Also: `SocketManager.ts:211` hardcodes the cancel reason `'user_cancel'` regardless of the true trigger → misleading attribution (CVO never pressed cancel; "Cancelled slot" is auto-emitted and fires for every cat — codex/sonnet/opus-47/antig all logged it 2026-05-29). | ⬜ Open. Fix: distinguish an interruption-abort from a real runtime crash → seal `user_initiated` (or preserve the cascade), not `runtime_error_reset`; stop hardcoding `'user_cancel'` — carry the true trigger so attribution is honest. |
| F211-REG7-2026-05-29-ws-flap-and-premature-done-affordance | F211 / WebSocket + UI streaming affordance | **P2/P3 (contributing factors, not the root cause)**: (a) the WebSocket flapped ~6× in 2 min during the incident (disconnect→connect→Joined room at 11:22:01/29/41/55, 11:23:30/45) — abnormal; the 680-step / ~700KB-`GetCascadeTrajectory` monster invocation may be overwhelming the socket, and a reconnect-reconcile is a candidate trigger for the spurious `cancel_invocation` (the cancel fired 5s after the 11:23:45 reconnect). (b) Bengal streamed a done-looking line while still mid-work (680 steps) → the UI presented a "done/idle" affordance → CVO reasonably sent a follow-up thinking he was finished → triggered REG5 (the `useSocket.ts` "server has a live slot but UI shows idle" mismatch). | ⬜ Open / investigate. (a) why the WS flaps (huge trajectory payload? heartbeat?) + whether reconnect-reconcile emits the spurious cancel; (b) the UI must not present idle/done while the backend invocation is still running. |
| F211-REG8-2026-05-30-busy-reuse-boundary | F211 / AntigravityBridge.getOrCreateSession + sendMessage/pollForSteps + drainCascade | **P1 (deferred follow-up of REG5, CVO-approved 2026-05-30)** — the busy-cascade REUSE *boundary* problem. **Memory is preserved in all cases** (the cascade is reused, context intact) — this is a streaming/display + ordering residual, NOT memory loss. Two coupled facets: **(a) boundary-aware polling** — when a follow-up arrives mid model-only RUNNING turn, `getOrCreateSession` reuses immediately (no drain, by the line-984 no-delay fix), then `sendMessage` takes `stepsBefore = numTotalSteps` mid-turn → `pollForSteps` streams the *prior* turn's tail and may early-terminate on the prior turn's intermediate IDLE before the queued follow-up runs → user sees STALE output instead of the follow-up answer (cloud round-19). **(b) count==0 owed-WAITING-step** — `getInFlightCount` is an in-process activity gauge, not an owed-result oracle; `CancelCascadeSteps` runs ONLY in `pushToolResult` (`:1314`), NOT in the abort/seal path, so a WAITING client-tool step left undispatched by a spurious abort persists with count==0 yet still owes a result → a reuse there can let the follow-up jump ahead of the owed step. **Tension**: drain-before-send fixes the baseline but re-introduces the multi-minute delay the line-984 no-drain fix removed; never-drain avoids the delay but leaves the baseline mid-turn. | ⬜ Open — deferred (CVO-approved 2026-05-30: merged the substantial REG5 memory-fix first to stop Bengal's live amnesia; this residual is best validated post-deploy on the live runtime). Owner: Ragdoll Opus 4.8. **Validation-first** (a blind fix risks re-breaking the core REG5 fix or message ordering): with the Antigravity carrier (antig-opus, cascade-protocol expert), capture the live queueing semantics — does a `SendUserCascadeMessage` injected during a RUNNING turn queue strictly *after* that turn's terminal IDLE? does it ever jump a WAITING client-tool step? — THEN implement the coherent boundary-aware design (send immediately + poll past the prior turn's boundary, not before it). Not a hidden enhancement tail: a tracked P1 with a CVO-signed deferral + a concrete validate→implement plan. |

### Bug 计数对账 (2026-05-28)

孟加拉猫 2026-05-27 报了 3 个 bug；2026-05-28 CVO 实测仍复现后，opus-4.8 逐条核源码发现一个**孟加拉猫当时没识别到的独立 defect**，CVO 确认作为"第 4 个 bug"记录：

- **第 4 个 bug = F211-REG1（Phase E 可见性 surface 过滤 mismatch）**。孟加拉猫 Bug 2 把"看不到 session"归因为"注册从未被自动调用"；但实测 dispatched 路径**确实注册了**（`syncAntigravityRuntimeMetadata` at `session_init`），真正的 defect 是 Phase E 的 list/detail/deep-dive surface 硬过滤 `surface==='ide-direct'`，把 `cat-cafe-dispatch` 结构性挡在视图外。这是独立于"注册 wiring"的 Phase E 层 bug，与 Bug 2 共享症状但根因不同。
- 工程修复点收敛为 **REG1（可见性）+ REG2（错误后 re-summon 续接）+ REG3（图片平台层 B/C）**；孟加拉猫 Bug 1 Layer A（callback pipeline）已由 PR #1926 修复。
- Owner：四个问题由Ragdoll Opus 4.8 统一接修并开 PR（CVO 2026-05-28 指派）。

## Eval / Tracking Contract

| 项 | 内容 |
|----|------|
| **Primary Users** | 需要恢复 Antigravity/Bengal Cat 工作上下文的猫和team lead；Activation Signal：`list_session_chain` / `read_session_digest` / `search_evidence` 查询 Antigravity 旧工作 |
| **Friction Metric** | Antigravity 相关工作在 UI 可见但 session-chain 查不到的次数；IDE-direct conversation 事后无法定位的次数；cascade rotation 后 digest/transcript 被覆盖或丢尾的次数；runtime 未重启但 Bengal 切到 fresh/empty session 的次数；Bengal 因 readonly 工具契约缺口读不到完整 evidence 的次数 |
| **Regression Fixture** | ① 同 cascadeId 重复 init 不新建 session ② cascadeId 轮换 seal+create ③ retire 中途切换后两个 digest 分开 ④ error reset / user New Cascade 分类写入 sealReason ⑤ IDE-direct registration 后 session-chain 可列出 ⑥ materialized Antigravity session events/digest 非空且降噪 ⑦ automatic/error-induced rotation 后新 session 首个 effective prompt 含 continuity bootstrap ⑧ Bengal 通过 readonly `cat_cafe_read_file_slice` 或 range fallback 读完整长 feature doc ⑨ runtime 未重启 session switch 有 old/new linkage 或 explicit break reason |
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
| R1 | “Antigravity 的 session 得是透明的” | AC-A1~A9, AC-E1~E4 | SessionChainStore tests + session reader proof + Hub/session-chain display | ✅ regression fix in PR — dispatched sessions now visible + drillable (F211-REG1) |
| R2 | “先把 F201 关闭，然后剩下的记录到 F211” | KD-2, F201 post-close note | F201 timeline note + BACKLOG F211 row | [x] |
| R3 | “这个和 F209 啥关系？F209 不是检索的吗？” | KD-1, KD-6, AC-0C | Spec ownership boundary review | [x] |
| R4 | “可以找 antig-opus，让他只需要讲出来问题；顺便总结 F211 想做什么” | AC-0D | Review request message to `@antig-opus` | [x] |
| R5 | IDE 直开和孟加拉猫聊天也要能找回 | AC-B1~B6 | IDE-direct registration fixture / list/read discoverability validation | ⚠️ partial — once registered, IDE-direct sessions are visible (and dispatched too, via F211-REG1 fix); but the Antigravity IDE still does not auto-call registration for purely IDE-direct chats (separate Phase B / carrier gap, not in the REG1-3 scope) |
| R6 | JSON shadow state 不该继续当真相源 | AC-A12, AC-C1~C4 | Read-only import + migration test + removal/audit diff | [x] |
| R7 | Bengal review: “session chain 里有记录但 digest/events 为空仍然没用” | AC-0E, AC-A8 | `read_session_digest/events` proof fixture | [x] |
| R8 | Bengal review: “同一 cascade 可换 model/catId，manual New Cascade 也常见” | AC-0F, AC-A5, AC-A9 | identity-history + sealReason tests | [x] |
| R9 | Bengal review: “IDE-direct 没 threadId/callbackToken，Phase B 注册机制要具体” | AC-B5, OQ-10 | external-session registration contract | [x] |
| R10 | Bengal review: “context canceled 噪音不要污染 digest” | AC-E4, OQ-11 | noisy trajectory fixture | [x] |
| R11 | team lead现场反馈：session 指 Antigravity cascade；错误/轮换后新 session 不能断记忆 | AC-A13~A16, KD-10, KD-11 | A2b continuity bootstrap fixture + manual New Cascade non-injection fixture | [x] |
| R12 | team lead现场反馈：runtime 没重启，但 Bengal 不知道为什么换了一个 session | AC-D7, KD-15, OQ-14 | session-switch diagnostic fixture: old/new linkage or persisted break reason | [x] |
| R13 | team lead现场反馈：`read_file_slice` 不在 Antigravity 白名单，F211 spec 被截断 | AC-D6, OQ-16 | Antigravity readonly tool allowlist parity test + long-doc read regression | [x] |
| R14 | team lead现场反馈：Bengal native L0 没完成不能被 F211 假装透明 | AC-D5, KD-14, F203-FU-2026-05-26-bengal-native-l0 | provider capability record + F203/carrier follow-up issue | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 可观测性入口不是 dashboard-only

## Review Gate

- Kickoff docs: Bengal Cat (`@antig-opus`) review for lived Antigravity constraints; request style = summarize F211 goal + list problems only.
- Design Memo: Ragdoll Opus 4.7 architecture review + Bengal Cat Antigravity surface review.
- Phase A1 plan: Opus 4.7 architecture review + Bengal Cat Antigravity surface review before worktree/TDD.
- Phase A2a/A2b plan: Opus 4.7 architecture review for lifecycle/bootstrap contract + Bengal Cat Antigravity surface review for Desktop UX and injection semantics.
- Phase B plan: Opus45 architecture review before worktree/TDD; P1 clarification on orphan-to-thread migration resolved as one-shot immutable binding for Phase B.
- Implementation: cross-family review before PR; no self-review.

## User Visibility Disclosure (SOP Step 0.3.5)

| Surface | 用户能做什么（达成态） | 用户实际能做什么（本 feat close 时） | 缺失/退化 | 处置 |
|---------|--------------------|--------------------------|----------|------|
| **Session Chain 面板 / 历史记录** | 看到所有的 Antigravity cascade 历史会话，包括每次是在哪里产生的（Cat Cafe dispatch 还是 IDE-direct 独立直聊），能查看每次会话的摘要（digest）、轨迹事件（events）以及密封原因（seal reason）。 | 在 Web 端的 Session Chain 面板上可以查看 Antigravity 运行期会话列表，点击可查看它们的完整状态、catId/model 变更记录、密封原因（如 `oversized_retire`, `user_initiated` 等），以及 Extractive Digest 提取出的摘要和事件记录。 | 无 | 已由 Web UI `HubRuntimeSessionsTab` 和 `ExternalRuntimeSessionsPanel` 完整实现。 |
| **开发者 IDE / 孟加拉猫直聊** | 在 IDE 直聊时，会话数据能自动 reverse-register 回 Cat Cafe 并在 Session Chain 留痕。如果在 IDE 侧换了新模型或者发生会话切换，系统应该能清楚追踪。 | 通过 Bridge 的 `register_external_session`，IDE 直聊会被逆向注册进 Cat Cafe，并建立对应的隐性锚点线程（anchor thread）以避免污染普通群聊。如果遇到未重启但 runtime 自动切了 session，会生成并记录 `unexpectedRuntimeSessionSwitch` 并附带 old/new 链接，由 API 和 UI 进行提示。 | Bengal/Antigravity 侧仍然缺失 native L0（即无法像 normal cats 一样注入真正的压缩免疫系统级 prompt）。 | 在 spec 中已经将 Bengal native L0 的缺失登记为了 follow-up issue `F203-FU-2026-05-26-bengal-native-l0`，并采用 `user_message_prepend` 封装作为临时过渡，已与 CVO 达成共识降级。 |
| **会话轮换后的上下文连续性** | 如果 Antigravity cascade 因为超限或报错触发了自动轮换，新建的会话应该能够无缝接续上个会话的记忆，不需要用户重复口述前情。 | 自动/错误触发的轮换中，系统会提取旧 session 的 events 摘要和 side-effect 日志并在新 session 第一个 effective prompt 前自动 prepend 封装 continuity bootstrap 传递给 Bengal。用户在 IDE 感觉不到冷启动。但如果是用户手动发起的 `New Cascade` 则不会强制注入，保护用户开启全新话题。 | 如果前序 session 发生致命崩溃导致 seal pending/incomplete，bootstrap 携带退化 marker (degraded marker) 提醒当前可能缺少部分前序证据。 | 通过 A2b 的 Degraded capsule 及 prompt 注入机制完整覆盖。 |
| **长 spec / 证据库穿透读取** | 在 Bengal 侧查询猫猫记忆或读取特长 spec 文件时，能完整读取，不会发生文件过长被截断而断章取义的问题。 | 将 `cat_cafe_read_file_slice` 加入 Antigravity 桥接允许白名单，支持按 range/slice 读取完整文件，避免被默认读取限制截断。 | 无 | 已通过 PR #1914 完全修复。 |

## 愿景守护证物对照表 (SOP Step 0)

| team experience/现场反馈（逐字引用/转述） | 当前实际状态（截图/代码/命令输出） | 匹配？ |
|----------------------|-------------------------------|--------|
| “我们的这个 antigravity 真的需要接入 session chain 也好或者什么也好，就是他的 session 得是透明的。” | 实现了 `RedisRuntimeSessionStore` 和 `ExternalRuntimeSessionRegistration`。新增了 `/api/external-runtime-sessions` 端点及 MCP 工具 `cat_cafe_list_external_runtime_sessions`、`cat_cafe_read_external_runtime_session`。Web UI 上新增了 `HubRuntimeSessionsTab` 和 `AuditRuntimeTab` 界面，运行期 external session 记录和 retire 细节完全透明。 | ✅ |
| “session 指 Antigravity cascade；错误/轮换后新 session不能断记忆” | 实现了 `antigravity-continuity-bootstrap.ts`，在 automatic/error 轮换后，通过 `prependContinuityBootstrap` 将上一次会话的 extractive digest 和 task summary 拼装进新 session 的第一条 effective prompt 发送给 Antigravity，打通了跨 cascade 的记忆链条。 | ✅ |
| “runtime 没重启，但 Bengal 不知道为什么换了一个 session” | 在 `RuntimeSessionMetadata` 中引进了 `unexpectedRuntimeSessionSwitch` 字段，并在 `invoke-single-cat.ts` 和 `RedisRuntimeSessionStore.ts` 捕获这种情况，保留 old/new linkage 关系并在 Session Chain UI 上展示警告标志，从而使得这种偶发性的切分能够被明确诊断，不再“无证据失忆”。 | ✅ |
| “read_file_slice 不在 Antigravity 白名单，F211 spec 被截断” | 在 PR #1914 里，将 `cat_cafe_read_file_slice` 加进了 Antigravity 的 readonly 允许列表（allowlist），通过测试确保 Bengal 能够跨 runtime 调用这个 range read 方法，避免读取大规格 spec 和 evidence 时遇到 truncation。 | ✅ |
| “Bengal native L0 没完成不能被 F211 假装透明” | AC-D5 和 KD-14 明确记录 Bengal 不具备 native L0 注入能力，不进行 overclaim。现有的 prompt 注入被限制为 application 层的 `user_message_prepend`。真正的 native L0 已注册到 follow-up issue `F203-FU-2026-05-26-bengal-native-l0` 由 @F203 负责。 | ✅ |

## Completion Sign-off（愿景守护跨猫签收）

| 猫猫 | 读了哪些文档/证据 | 三问结论（核心问题 / 交付物 / 体验） | 签收 |
|------|-------------------|--------------------------------------|------|
| Maine Coon/Maine Coon GPT-5.5（作者自检） | F211 spec, PR #1880/#1885/#1899/#1908/#1911/#1914/#1916 merge evidence, `pnpm gate` at `44c170f8d`, doc sync `1a3138263` | 核心问题是 Antigravity / IDE-direct runtime session 对用户和后续猫不可见；交付物让 runtime sessions 进 Session Chain / Hub / Audit evidence，并在 unexpected switch 时留下 old/new linkage；用户现在能看见“到底是什么 session”，Bengal native L0 明确不由 F211 假装完成 | ✅ ready for guardian |
| Maine Coon GPT-5.4（愿景守护） | F211 spec status/AC/follow-up register, Phase E + Phase D merged code paths, PR #1916, completion doc sync `1a3138263` | 对照team experience：“session 得是透明的”已由 Session Chain + Hub runtime visibility 覆盖；“runtime 没重启却换 session”已变成可解释的 unexpected switch metadata，而不是无证据失忆；“我可以在这里看到到底是什么 session”已由 SessionChainPanel + Hub Runtime Sessions 满足；没有 overclaim Bengal native L0 | ✅ APPROVE |
