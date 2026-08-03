# K-1 R2 Emission Fencing Implementation Plan

**Feature:** F288 — `docs/features/F288-plugin-messaging-domain.md`
**Goal:** Close Terra's two P1 and one P2 findings by making append authority, output ordering, and stored-envelope validation share explicit persistent truth sources.
**Acceptance Criteria:** (1) a send-only parent handle cannot append; (2) after a successor emits revision 3, a stale revision-2 emitter cannot append a new event even when revision 2 has left retention; (3) stored plugin payload hydration rejects every closed-schema/bounds violation named by C-1; (4) existing send, replay, snapshot, whisper, memory, and Redis paths remain green.
**Architecture cell:** `plugin-messaging` (proposed by F288; not yet present in the upstream ownership map)
**Map delta:** none
**Map delta why:** This repair stays inside F288's already-proposed messaging cell and does not add a new cross-domain owner.
**Architecture:** The message store remains the canonical content/outbox state, while the event log remains the canonical sequence log. A host-issued append lease becomes an explicit capability passed to event insertion; the event store validates that lease atomically with insertion, so an expired holder cannot mutate the log. Hydration uses the same closed-object and bound invariants as the C-1 contract mirror.
**Tech Stack:** TypeScript, Node test runner, in-memory stores, Redis Lua, `IMessageStore` revision CAS.
**前端验证:** No — domain-only change.

---

## Straight-line finish

**B definition:** A public plugin message has one ordered revision history: append authority derives from a live subscribable parent grant, every emitted append is atomically fenced by the current lease, and every hydrated canonical payload is schema-valid.

**Not building:** cross-store distributed transactions, permanent event retention, a new broker transport, cryptographic handle tokens, or changes to C-1's published value decisions.

**Terminal schema:**

- `AppendLock.acquire()` returns an opaque `AppendLease` containing the message id and owner token.
- `EventLogStore.append(..., lease?)` atomically validates an append lease when supplied and reports `fencedOut` without inserting when ownership is stale.
- `PluginMessageExtra.outputRevision/outputSequence` denotes the highest contiguous public output revision represented in the event log; it may lag `revision` during recovery.
- `parsePluginMessageExtra()` is the only memory/Redis hydration parser and rejects unknown closed-object keys, duplicate/oversized elements, invalid references, and invalid append-op state.

## Truth-source matrix

| Data | Truth source (writer) | Consumers (reader) | Derivation | Cascade rule |
|---|---|---|---|---|
| Parent append grant | `HandleStore` record written by `HandleService` | `resolveForAppend()` | MessageHandle → live parent AddressHandle | Parent revoke or `canSubscribe=false` makes append unreachable before ledger claim |
| Current append ownership | `AppendLock` token/TTL | `EventLogStore.append(..., lease)` | Lease is an opaque capability, not a copied boolean | Expiry/takeover invalidates the old token; event insertion checks token atomically with the write |
| Canonical message revision and operations | `StoredMessage.extra.pluginMessage` written by Send/Append services via revision CAS | append replay, envelope projection, snapshot, hydration | `revision = appendOps.length + 1` | Content revision advances only after predecessor output reconciliation |
| Contiguous output progress | `outputRevision/outputSequence` in canonical plugin extra | append recovery and snapshot fence | Highest contiguous revision whose public output event was accepted | May advance monotonically to `revision`; must never regress or skip a revision |
| Per-thread event sequence | `EventLogStore` | subscriptions, ack, snapshot head | store-assigned monotonic sequence | Retention trims payloads, never the sequence head; a fenced-out append does not consume sequence |
| Append idempotency settlement | `LedgerStore` owned by `MessagingLedger` | append entrypoint | `(instance,message,operation)` state | A fenced holder settles only if persisted output already covers its revision; otherwise release and retry |
| Stored payload validity | C-1 candidate schema + local `MESSAGING_BOUNDS`; enforced by `parsePluginMessageExtra()` | memory projection and Redis hydration | Parsed value is the canonical typed payload | Any malformed independent Redis field fails closed; no fallback to legacy embedded payload |

## Stateful-object census and transitions

### 1. Parent address handle and message handle — owner: `HandleService`

| State | Event | Next state / result |
|---|---|---|
| address active + `canSubscribe=true`; message handle active | append resolve | authorized message target |
| address active + `canSubscribe=false`; message handle active | append resolve | `PERMISSION`; no ledger claim |
| address revoked or message handle revoked | append resolve | `PERMISSION`; no ledger claim |

Bypass rule: raw message ids and message-handle-local copied scope cannot replace the live parent lookup.

### 2. Append lease — owner: `AppendLock`

| State | Event | Next state / result |
|---|---|---|
| absent/expired | acquire | live owner token |
| live | competing acquire | rejected |
| live owner | release with same token | absent |
| expired/superseded owner | event append | atomically fenced out; zero event mutation |

Bypass rule: no unfenced `events.append()` is allowed for append events; checking ownership before a separate write is forbidden because it creates a TOCTOU window.

### 3. Plugin message output state — owner: `AppendService` over `IMessageStore`

| Canonical state | Event | Next canonical state |
|---|---|---|
| `revision=N, outputRevision=N` | new append persists | `revision=N+1, outputRevision=N` |
| `revision=N, outputRevision=K<N` | current lease emits revision `K+1` | `outputRevision=K+1`, sequence recorded |
| pending predecessor(s) | successor append | emit/persist each predecessor in order, then persist/emit successor |
| stale holder is fenced out | current state already covers its revision | return persisted result without log mutation |
| stale holder is fenced out | current state does not cover its revision | `RETRYABLE_INFLIGHT`; ledger claim released |

Bypass rule: `outputRevision` cannot be set directly to `revision` after a partial reconciliation loop.

### 4. Event-log entry — owner: `EventLogStore`

| State | Event | Next state / result |
|---|---|---|
| event key retained | retry | dedupe to original sequence |
| key trimmed, current lease valid | recovery append | new at-least-once insertion with same deterministic event id |
| key trimmed, lease stale | recovery append | fenced out; head unchanged |

Bypass rule: append events require a lease; publish events remain unfenced because send has no per-message append lease.

### 5. Stored plugin payload — owner: Send/Append services; parser owner: `envelope.ts`

| State | Event | Next state / result |
|---|---|---|
| valid canonical payload | memory/Redis hydrate | typed `PluginMessageExtra` |
| unknown key, invalid nested closed object, duplicate id, bad reference, or bound violation | hydrate | `null`/`undefined`; envelope omitted fail-closed |
| malformed independent Redis payload + valid legacy embedded payload | hydrate | reject independent payload; no downgrade fallback |

Bypass rule: Redis-specific parsers may delegate to, but may not weaken, `parsePluginMessageExtra()`.

## Core invariants and test matrix

- **INV-13:** append requires the live parent address handle to grant `canSubscribe`. Test: send-only handle sends successfully, then append returns `PERMISSION` with revision unchanged.
- **INV-14:** append event insertion and lease validation are one atomic store operation. Tests: memory controlled takeover and Redis stale-token insertion both leave the event head unchanged.
- **INV-15:** `outputRevision` is the highest contiguous emitted revision and never exceeds `revision`. Test: gated predecessor repair observes `1 → 2 → 3`, never `1 → 3`.
- **INV-16:** a successor emits every persisted predecessor before its own revision. Existing takeover ordering regression remains green.
- **INV-17:** after snapshot resumes at revision 3, unblocking the old revision-2 emitter cannot create a later revision-2 event, including `retentionCount=1`. New end-to-end controlled race.
- **INV-18:** a fenced holder cannot settle missing output. Test: lease expires without successor output → `RETRYABLE_INFLIGHT`, then retry repairs and settles.
- **INV-19:** canonical hydration is closed and bounded. Table tests cover root/provenance/origin/sourceAddress/element/text-payload/append-op unknown keys, 33 elements, duplicate ids, invalid references, and invalid revision/op cardinality.
- **INV-20:** valid media/rich payload objects remain open per C-1. Existing/new positive regression guard.

## Existing behavior protection

| Existing behavior | Protection |
|---|---|
| Public send emits revision 1 and persists output watermark | `plugin-messaging-send.test.js` |
| Whisper send/append emits no public event | append/send suites |
| Crash replay reconstructs immutable event payload | `plugin-messaging-append-replay.test.js` |
| Successor repairs predecessor before its own append | existing lease-takeover regression |
| Snapshot excludes pending/deleted output and resumes at a stable head | snapshot and snapshot-deletion suites |
| Event retention still trims payloads and exposes stale cursor semantics | event-log/event-stream suites |
| Redis lock release is owner-token guarded | Redis store suite |
| Valid canonical plugin payload survives memory/Redis round-trip | envelope and Redis message-store suites |

## Adversarial scenarios

1. Crash after revision persistence but before event insertion: retry/new lease repairs from `appendOps`.
2. Old holder resumes after successor emitted revision 3 and trimmed revision 2: atomic lease fence rejects the old insertion.
3. Lease expires with no successor: old holder is fenced, does not settle, and a later retry repairs.
4. Successor crashes after one predecessor event but before watermark persistence: deterministic event id dedupes while retained; otherwise at-least-once reinsertion occurs before any higher revision.
5. Redis independent payload contains valid-looking core fields plus unknown nested fields: hydration fails closed and does not fall back.
6. Parent handle can send but cannot subscribe: send succeeds; append fails before mutation.

## Tasks

### Task 1: Add authority and parser RED tests

**Files:**
- Modify: `packages/api/test/plugin-messaging-handles.test.js`
- Modify: `packages/api/test/plugin-messaging-envelope.test.js`

1. Add the send-only parent append rejection regression.
2. Add the closed-schema/bounds hydration table and positive open-payload guards.
3. Build API and run the two files; require failures for the named old behavior.

### Task 2: Add stale-emitter RED tests

**Files:**
- Create: `packages/api/test/plugin-messaging-append-fencing.test.js`
- Create: `packages/api/test/plugin-messaging-event-log-fencing.test.js`
- Modify: `packages/api/test/plugin-messaging-redis-stores.test.js`

1. Add the retention-1 `snapshot rev3 → unblock rev2 → no event` race.
2. Add memory and Redis store-level stale lease tests proving no sequence is consumed.
3. Add the expiry-without-successor retry regression.
4. Run focused tests and require exact RED failures.

### Task 3: Implement terminal lease fencing and contiguous watermarks

**Files:**
- Modify: `packages/api/src/domains/messaging/stores/ports.ts`
- Modify: `packages/api/src/domains/messaging/stores/memory.ts`
- Modify: `packages/api/src/domains/messaging/stores/redis-append-lock.ts`
- Modify: `packages/api/src/domains/messaging/stores/redis.ts`
- Modify: `packages/api/src/domains/messaging/stores/redis-keys.ts`
- Modify: `packages/api/src/domains/messaging/append-service.ts`
- Modify: `packages/api/src/domains/messaging/stores/factory.ts`

1. Introduce opaque `AppendLease` and atomic fenced event-append result.
2. Thread the lease through append reconciliation and event insertion.
3. Advance output watermarks one contiguous revision at a time.
4. Treat fenced output as repaired only when current canonical state already covers the target revision; otherwise return retryable.
5. Run focused memory/non-Redis tests to GREEN.

### Task 4: Implement strict canonical hydration

**Files:**
- Modify: `packages/api/src/domains/messaging/envelope.ts`
- Modify: `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts` only if structural types need the new stored fields
- Modify: `packages/api/src/domains/cats/services/stores/redis/redis-message-parsers.ts` only to retain single-parser delegation

1. Add exact-key, string bound, element uniqueness/reference, payload byte, append-op, and revision-cardinality checks.
2. Keep `media_ref` and `rich_block` payload objects open.
3. Run parser, envelope, Redis hydration, and append suites to GREEN.

### Task 5: Full verification, documentation, and peer re-review

**Files:**
- Modify: `docs/bug-report/append-event-order-after-lock-expiry/bug-report.md`
- Modify: `docs/bug-report/redis-plugin-message-array-collapse/bug-report.md`
- Modify: `docs/features/F288-plugin-messaging-domain.md`
- Modify: `review-notes/2026-07-15-k1-plugin-messaging-review-request.md`

1. Run K-1 non-Redis, isolated Redis, build/check/lint, architecture/fallback scans, and `git diff --check`.
2. Rebase/merge the two `upstream/main` deltas only after focused GREEN; rerun the same gate if the delta touches the slice.
3. Commit with Why + thread provenance footer.
4. Send the new SHA, state model, Red→Green evidence, and failure-mode sweep to Terra for full re-review.
5. Do not create a PR or emit `shape-approved` before Terra's explicit APPROVE.

[砚砚/GPT-5.6 Sol🐾]
