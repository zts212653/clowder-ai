# K-1 Producer Attestation Implementation Plan

**Tracking issue:** #1200 — invalid stored-message timestamp admission
**Goal:** Establish testable source-side guarantees for message identifiers, thread identifiers, actor identifiers, and message timestamps without inventing an unreviewed wire bound or silently excluding stored messages.
**Acceptance Criteria:** Until D2 decouples cursor order from ID text, future message writes admit only non-negative integral JavaScript `Date` timestamps and reject all other values before persistence; `append()` may initialize only legacy-immediate or queued delivery state and cannot seed transition-owned `deliveredAt`/terminal status; `markCanceled()` may transition only queued records and is a no-op for legacy-immediate, delivered, or already-canceled records; every proposed identifier bound is traced to a producer or admission source; memory and Redis stores share one admission rule; legacy stored data has an explicit read-only audit and reconciliation decision before any bound is claimed compatible; #1200 receives only claims backed by tests and an exact core commit. #1165 remains M7 reservation provenance only and does not authorize this implementation.
**Architecture cell:** `dispatch` (F117 message-delivery lifecycle), with `bubble-pipeline` as an adjacent projection consumer
**Map delta:** none
**Map delta why:** The current ownership map has no dedicated message-timeline storage cell. This hotfix hardens the existing F117 delivery lifecycle at its store boundary under the nearest canonical owner, `dispatch`; it does not move ownership, add a runtime component, or make `bubble-pipeline` the persistence authority.
**Architecture:** A pure admission helper is the single write-side policy consumed by both message stores. It temporarily matches the domain that the current lexical sortable-ID/cursor encoding can preserve; D2 will replace that coupling before the full valid-Date domain can be restored. F117's delivery lifecycle owns queued/terminal transition semantics under `dispatch`; `bubble-pipeline` is adjacent only because history and delivery events project stored state into rendered bubbles. A separate read-only audit reports legacy violations; it does not mutate persistent data. K-1 projection remains fail-closed and may rely on a bound only after admission and legacy compatibility are reviewed. Any later wire-shape delta requires independent authorization; #1165 is cited here only for its M7 reservation record.
**Tech Stack:** TypeScript, Node test runner, in-memory message store, Redis message store
**前端验证:** No

---

## Grounding verdict

The work is valid, but the original task summary is not sufficient authorization to choose public maxima.

- #1165 revision 6 is related provenance that explicitly leaves `messageId`, `threadId`, and `actor.id` reserved pending a K-1 attested bound or admission gate; it is not the accepted issue for this patch.
- The same revision says that the resulting wire bound enters as a reviewed shape delta.
- `occurredAt` additionally requires valid-Date admission and stored-data attestation/migration.
- The roadmap identifies the work but supplies no exact identifier maxima or legacy-data disposition.

Therefore Phase A below is executable now. Phase B must not begin until the decision packet is resolved.

## Finish line and non-goals

Terminal state:

1. all new messages satisfy one source-owned identity/timestamp policy before any storage side effect, and generic append cannot bypass delivery-transition ownership;
2. memory and Redis stores behave identically;
3. a read-only legacy audit can prove whether persisted values fit the proposed policy;
4. #1200 can cite exact tests and a commit for this source-side fix; any later K-1 wire-shape proposal remains a separately reviewed change.

Not in scope:

- changing the frozen plugin wire schema in this branch;
- publishing beta.3 or re-pinning K-1;
- silently dropping or rewriting legacy messages;
- treating a target-side validator as proof of source compatibility;
- scanning the operator's live Redis from tests or development tooling.

## Truth-source matrix

| Data | Producer / write truth | Consumers | Current invariant | Gap |
|---|---|---|---|---|
| `messageId` | `generateSortableId()` in `MessageStore.ts`; both stores call it | message lookup, cursors, later K-1 envelope/event IDs | timestamp prefix + process-global sequence + UUID suffix | sequence has no explicit safe bound; no exported maximum or proof test |
| `threadId` | `generateThreadId()` for normal creation; `ensureThread()` and message append also accept strings | thread/message indexes and K-1 envelope | several HTTP surfaces cap at 100 | no canonical store-level admission; alternate producers can bypass route caps |
| user `actor.id` | resolved request identity copied to `StoredMessage.userId` | ownership filters and K-1 user actor | some routes cap legacy `userId` at 100 | session/header paths and stores lack one canonical admission rule |
| cat `actor.id` | cat catalog/registry copied to `StoredMessage.catId` | routing and K-1 cat actor | cat-management route uses 64 + grammar | shared registry schema and message stores do not enforce the same maximum |
| plugin `actor.id` | K-1 `PluginCallContext.pluginInstanceId` | K-1 plugin actor | plugin payload parser caps at 256 | producer context must reject before persistence, not fail during projection |
| `occurredAt` | `StoredMessage.timestamp` projected through `new Date(timestamp).toISOString()` | K-1 envelope/event readers | ordinary producers use `Date.now()` | stores accept `NaN`, infinities, and out-of-Date-range numbers; projection can throw |
| append-time delivery metadata | `IMessageStore.append` owns record creation; it may initialize `deliveryStatus` only as `queued` or leave it absent for legacy-immediate messages | visibility filters, queue reconciliation, effective history order | terminal `deliveredAt`/`deliveryStatus` must be written only by transition owners | `AppendMessageInput` currently inherits `deliveredAt` and all terminal statuses from `StoredMessage`; memory spreads them verbatim while Redis returns but does not persist/score `deliveredAt` |
| delivery transition time | `IMessageStore.markDelivered(id, deliveredAt)` | `StoredMessage.deliveredAt`; Redis global/user/thread ZSET scores; history pagination cursors | production callers use `Date.now()`, but the store contract accepts every JavaScript `number` | Redis hydration truncates fractions and turns infinities into `NaN`, diverging from memory and from the persisted score |
| delivery terminal state | `IMessageStore.markDelivered` owns queued → delivered; `IMessageStore.markCanceled` owns queued → canceled | visibility filters, queue reconciliation, effective history order | terminal transitions must be source-state guarded and preserve existing terminal metadata/indexes on a no-op | both stores currently let `markCanceled` rewrite legacy-immediate or delivered records to canceled; Redis retains delivered hash/index order while hiding the rewritten record |
| effective history order | pure projection `deliveredAt ?? timestamp` | Redis global/user/thread ordering; memory/Redis before-cursor comparison; bounded thread collectors | one logical value must survive admission → hash/ZSET persistence → hydration → cursor reuse while message ownership is stable | the original projection audit omitted `deliveredAt`; a later systematic scan separately found that concurrent delivery and user reassignment are not one atomic transition |

### Redis persisted-number representation and admission audit

The executable hash-value versus `ZSCORE` wire matrix, `markDelivered` admission matrix, and complete eight-call-site `zscore` consumer audit are recorded in the [bug capsule](../docs/bug-report/k1-invalid-message-timestamp/bug-report.md#persisted-number-representation-and-admission-matrix). They are acceptance evidence for INV-6, INV-8, and INV-9: blank/missing legacy `timestamp` semantics stay distinct; legacy finite fractions and Redis's canonical `inf` / `-inf` spellings decode into the same numeric domain used by hydrated timestamp cursors; future `deliveredAt` writes are rejected unless they are safe order timestamps.

## Core invariants

- **INV-1 — pre-write admission:** Invalid identity/timestamp input is rejected before idempotency claims, Redis commands, in-memory append, indexes, or append listeners change.
- **INV-2 — store parity:** Memory and Redis stores call the same pure policy and return the same error class for the same invalid input.
- **INV-3 — sortable valid-Date domain:** Every newly persisted timestamp is a non-negative integer inside ECMAScript `Date` TimeClip, so both `toISOString()` and the current timestamp-prefixed ID ordering remain valid. Full valid-Date admission waits for D2 explicit cursor order.
- **INV-4 — generated-id bound:** Every newly minted message ID satisfies a documented finite maximum; generator state cannot silently escape that maximum.
- **INV-5 — scalar compatibility:** A bound is not called wire-compatible unless the admitted string domain also excludes isolated UTF-16 surrogates required by the compact wire profile.
- **INV-6 — legacy honesty:** New-write admission does not prove historical compatibility. Hydration preserves present-but-blank timestamps as invalid evidence rather than fabricating epoch zero, and Redis numeric aliases retain their original finite/non-finite values; legacy closure still requires a read-only audit result or an explicit migration/reconciliation policy.
- **INV-7 — no silent skip:** A legacy incompatibility is a Host fault with a reconciliation path; it cannot advance a delivery cursor, callback lease, or settlement state.
- **INV-8 — legacy cursor exclusivity:** Redis before-cursor pagination parses canonical sorted-set score spellings into the same numeric domain as hydrated timestamps, so preserved fractional and infinity cursors are excluded rather than replayed and bounded multi-page consumers always make progress.
- **INV-9 — delivery-order admission and ownership:** `append` accepts no `deliveredAt` and no terminal `deliveryStatus`; it may create only legacy-immediate (`deliveryStatus` absent) or queued records. `markDelivered` accepts only non-negative integral ECMAScript Date values and exclusively owns queued → delivered plus `deliveredAt`; `markCanceled` exclusively owns queued → canceled. Both transition owners are fail-closed on source state: missing returns `null`, while legacy-immediate, delivered, canceled, or otherwise non-queued records are returned unchanged. Memory and Redis reject ownership bypasses and invalid transition times before ID generation, idempotency claims, listeners, message/hash mutation, or ordering-index writes; a later valid append/transition remains possible.
- **INV-10 — single-writer effective-order parity:** For an admitted delivery transition that does not overlap another terminal transition or user-ownership reassignment, memory `StoredMessage.deliveredAt`, Redis hash `deliveredAt`, Redis global/user/thread scores, hydrated `deliveredAt`, and every before-cursor consumer represent the same exact number. The mention index intentionally retains append-time ordering. Linearizability across concurrent `markDelivered()` × `markCanceled()` or `markDelivered()` × `reassignUserId()`, and exact zero-presence through HTTP/Web projection, are not claimed by Phase A1. Terminal-transition CAS and no-op `message_deleted` suppression are explicitly RESERVED to PR #1193; reassignment atomicity and zero-presence remain RESERVED to the effective-order follow-up proposed as `proposal_mrt0j01zvz1mopnq`.

## Existing behavior protection

| Existing behavior | Protection |
|---|---|
| message IDs remain lexicographically sortable for admitted timestamps | paired boundary classes plus delivery-cursor and memory/Redis expired-cursor tests |
| idempotent append returns the original message | retain existing memory and Redis idempotency tests |
| Redis and memory stores persist the same canonical fields | paired admission cases in `message-store.test.js` and `redis-message-store.test.js` |
| Redis legacy fractional timestamps remain exact and before cursors remain exclusive | direct legacy hash/zset fixture exercises both before-cursor APIs plus a bounded real-store multi-page collector |
| Redis blank timestamp evidence is not normalized into valid data | direct empty/whitespace fixtures exercise single and batch hydration while preserving fractional and missing-field compatibility |
| Redis canonical `inf` / `-inf` scores remain equivalent to hydrated `Infinity` / `-Infinity` | direct positive/negative infinity fixtures exercise both before-cursor APIs; the bounded collector covers positive-infinity progress |
| valid queued → delivered transitions with stable ownership remain ordered by delivery time | paired memory/Redis boundary-success cases hydrate the exact `deliveredAt` and collect all messages with a one-record page |
| generic append cannot seed terminal delivery state | the public input type excludes `deliveredAt` and narrows `deliveryStatus` to `queued`; paired runtime tests reject JS callers that bypass types, then prove a valid queued retry persists with no `deliveredAt` and timestamp-based indexes |
| invalid delivery times cannot create split hash/ZSET state | paired memory/Redis invalid-domain cases assert `RangeError`, unchanged queued state, unchanged Redis scores/hash, and successful retry with a valid value |
| cancellation cannot rewrite legacy or delivered state | paired memory/Redis cases prove queued → canceled succeeds, while legacy-immediate and delivered records—including `deliveredAt`, raw Redis hash, and global/user/thread scores—remain byte/value identical |
| mention scans retain their established append-time order | audit documents that `markDelivered` re-scores only global/user/thread indexes; existing mention cursor tests remain regression guards |
| existing route-generated thread/user/cat identifiers continue to append | boundary-success fixtures at the selected maxima |
| no production data is touched by audit tests | audit accepts an injected iterator/snapshot and defaults to report-only |

## Stateful-object census

| Object | Lifecycle owner | Relevant transitions | Adversarial cases |
|---|---|---|---|
| message record | `IMessageStore.append` implementation | candidate → admitted as legacy-immediate or queued → persisted/indexed | invalid timestamp, terminal delivery-metadata bypass, idempotency replay, Redis contention, listener side effects |
| queued-message delivery state | selected `IMessageStore.markDelivered` / `markCanceled` implementation | queued → delivery-time admitted → delivered; queued → canceled; non-queued → unchanged | fractional/non-finite/out-of-Date-range time, repeated transition, legacy-immediate or delivered cancellation, missing ID, valid retry after rejection; concurrent terminal transitions RESERVED |
| effective history-order projection | derived only as `deliveredAt ?? timestamp`; Redis store owns materialized global/user/thread ZSET scores | append score=`timestamp` → successful delivery score=`deliveredAt` → sequential user reassignment forwards that score → hydration → before-cursor reuse | hash/ZSET representation drift, partial mutation, one-record pages, Redis canonical number spellings; concurrent delivery × reassignment RESERVED |
| sortable-id generator state | `generateSortableId` module | sequence read → increment → encoded | same millisecond burst, maximum safe sequence, non-monotonic timestamp |
| persisted legacy message | existing store data | hydrated → audited → compatible/finding | malformed timestamp, oversized/non-scalar identity, missing field |
| cat registry identity | catalog loader/registry | configured → registered → referenced by message | route-created vs file-configured IDs, registry reload |

### Stateful Object Gate — append and delivery transitions

Lifecycle ownership is split by transition, not by storage implementation. `IMessageStore.append` owns record creation and may initialize only legacy-immediate state (status absent) or `queued`; it cannot accept `deliveredAt`, `delivered`, or `canceled`. The selected `IMessageStore.markDelivered` implementation exclusively owns queued → delivered, `deliveredAt`, and delivery-time index re-scoring; `markCanceled` exclusively owns queued → canceled. Each owner must observe `queued` before mutating and otherwise return the existing record unchanged. Callers request transitions but do not write terminal delivery metadata or ordering indexes directly. Redis currently implements both terminal methods as read→write sequences without a shared compare-and-set, so Phase A1 makes no concurrency claim for overlapping delivery/cancellation. `RedisMessageStore.reassignUserId` is a separate owner/index mutation path; Phase A1 proves sequential forwarding only and does not claim that it is linearizable with delivery. Raw Redis mutation is reserved for isolated legacy fixtures and future operator-reviewed repair tooling; it is not a runtime bypass API.

| Current state | Event | Admission / transition | Memory representation | Redis representation | Required result |
|---|---|---|---|---|---|
| candidate | `append` with `deliveredAt` present or terminal status | reject ownership bypass | no object, idempotency claim, or listener | no ID/idempotency/hash/index write | throw `TypeError`; retry without terminal metadata remains possible |
| candidate | `append` with status absent | admit legacy-immediate creation | no `deliveredAt`; status absent | no `deliveredAt`; status absent; indexes scored by `timestamp` | stores return/rehydrate the same record |
| candidate | `append` with status=`queued` | admit queued creation | no `deliveredAt`; status=`queued` | no `deliveredAt`; status=`queued`; indexes scored by `timestamp` | stores return/rehydrate the same queued record |
| missing | `markDelivered(id, valid)` | no transition | no object | no hash/index write | return `null` |
| queued | `markDelivered(id, invalid)` | reject before mutation | queued object unchanged | hash and all scores unchanged | throw `RangeError`; valid retry remains possible |
| queued | `markDelivered(id, valid)` | queued → delivered | exact `deliveredAt`; status=`delivered` | exact hash text; global/user/thread score=`deliveredAt`; status=`delivered` | return the delivered message with store parity |
| delivered / canceled / untracked | `markDelivered(id, valid)` | no transition | object unchanged | hash and indexes unchanged | return the existing message |
| delivered / canceled / untracked | `markDelivered(id, invalid)` | boundary reject | object unchanged | hash and indexes unchanged | throw `RangeError`; invalid API input never becomes state-dependent |
| missing | `markCanceled(id)` | no transition | no object | no hash/index write | return `null` |
| queued | `markCanceled(id)` | queued → canceled | status=`canceled`; no `deliveredAt` | hash status=`canceled`; global/user/thread scores unchanged | return the canceled message with store parity |
| legacy-immediate / delivered / canceled | `markCanceled(id)` | no transition | object and `deliveredAt` unchanged | hash and every index score unchanged | return the existing message unchanged |
| queued + terminal transitions overlap | `markDelivered(id, valid)` × `markCanceled(id)` | **RESERVED**: Redis uses independent read→write sequences without a shared CAS | single-threaded memory calls serialize by invocation order | last Redis writer may overwrite terminal status after both observed queued | PR #1193 owns atomic CAS and no-op event suppression; no Phase A1 linearizability claim |
| queued + ownership changes concurrently | `markDelivered(id, valid)` × `reassignUserId(id, nextUserId)` | **RESERVED**: current read→`MULTI` paths have no shared CAS | N/A: Redis-only reassignment helper | deterministic interleavings can leave the new-user score stale or retain an old-user member | independent atomic-transition follow-up; no Phase A1 parity claim |

The admitted domain is the existing sortable-order timestamp domain: `Number.isInteger(value)`, `value >= 0`, and valid ECMAScript TimeClip. This is stricter than Redis's floating-point score grammar by design. It matches all production callers (`Date.now()`), keeps the delivery field a timestamp, and prevents future hash/ZSET representation splits without expanding D3 historical reconciliation.

### Stateful adversarial test matrix

| Scenario | Invariant | RED→GREEN evidence |
|---|---|---|
| direct append with fractional/non-finite/otherwise valid `deliveredAt` | INV-1 / INV-9 | paired stores reject every terminal-field presence before ID/idempotency/listener/hash/index side effects; a valid queued retry succeeds |
| direct append with `deliveryStatus=delivered|canceled` | INV-9 | paired stores reject terminal-status initialization while preserving the legitimate queued-creation path |
| valid queued append after rejected ownership bypass | INV-9 / INV-10 | memory/Redis return and rehydrate status=`queued`, `deliveredAt` absent, and global/user/thread scores exactly equal `timestamp` |
| fractional `deliveredAt` (`100.25`) | INV-9 | paired stores reject; message remains queued; Redis hash and three scores remain at append time |
| `NaN`, `Infinity`, `-Infinity`, negative, and TimeClip overflow | INV-9 | paired invalid-domain loop rejects every value with no state mutation |
| valid zero and positive TimeClip boundary with stable ownership | INV-9 / INV-10 | exact value survives transition and Redis hydration |
| invalid attempt followed by valid retry | INV-9 | retry delivers successfully, proving rejection did not consume the transition |
| invalid attempts followed by valid increasing deliveries, page size 1 | INV-9 / INV-10 | memory and real Redis collectors both return every delivered message once without runtime error |
| queued cancellation | INV-9 | paired stores transition only queued → canceled while retaining append-time scores and no `deliveredAt` |
| legacy-immediate or delivered cancellation | INV-9 / INV-10 | paired stores return the existing record unchanged; delivered case snapshots status, `deliveredAt`, Redis hash, and global/user/thread scores |
| concurrent delivery × cancellation | RESERVED to PR #1193 | source audit proves Redis has no shared CAS/Lua across the two read→write paths; Phase A1 does not imply last-writer behavior or unconditional queue-route deletion events are valid serialization |
| sequential user ownership reassignment after valid delivery | INV-10 | Redis preserves exact zero/positive-boundary order through raw-score forwarding and the missing-score hydrated fallback |
| concurrent delivery × user ownership reassignment | RESERVED | isolated Redis reproduces both stale-new-user score and stale-old-user membership interleavings; atomic CAS/reconciliation belongs to `proposal_mrt0j01zvz1mopnq` |
| valid `deliveredAt=0` through HTTP/Web projection | RESERVED | store/hash/ZSET hydration is exact, but existing truthiness-based transport/UI copies can omit zero; consumer-presence repair belongs to the same independent follow-up |
| legacy fractional/infinite `timestamp` cursor | INV-6 / INV-8 | existing direct hash/ZSET fixtures remain unchanged; historical attestation/migration stays RESERVED |

## Phase A — executable without a public-bound decision

### Task A1: Valid-Date admission (TDD)

**Files:**

- Modify: `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts`
- Modify: `packages/api/src/domains/cats/services/stores/redis/RedisMessageStore.ts`
- Test: `packages/api/test/message-store.test.js`
- Test: `packages/api/test/redis-message-store.test.js`

1. Add RED cases for negative/fractional values, `NaN`, `Infinity`, `-Infinity`, and values outside `±8_640_000_000_000_000`.
2. Assert rejection occurs before an append listener or Redis write is observable.
3. Add one pure `assertValidStoredMessageTimestamp()` helper and call it before any store side effect.
4. Add boundary-success cases for zero, an ordinary integral value, and the positive ECMAScript Date maximum; prove chronological ID order, delivery-cursor monotonicity, and memory/Redis expired-cursor recovery across that admitted class.
5. Seed read-only legacy Redis fixtures: prove both before-cursor APIs exclude fractional and positive/negative-infinity cursors after Redis score canonicalization; exercise a bounded real-store multi-page consumer for progress/uniqueness; prove empty and whitespace hash timestamps remain invalid through single and batch hydration without changing fractional or missing-field behavior.
6. Add paired memory/Redis RED cases proving `markDelivered` rejects the full invalid timestamp domain before any state/hash/index mutation, then succeeds on a valid retry.
7. Add paired valid-delivery pagination cases proving exact `deliveredAt` hydration and bounded one-record pages preserve completeness and store parity.
8. Build and run the focused memory/Redis suites.
9. Narrow `AppendMessageInput` to exclude `deliveredAt` and allow only queued initialization; add a shared runtime ownership guard at the start of both append implementations, then add paired direct-append rejection/valid-retry/rehydration/index-score tests.
10. Add paired memory/Redis RED cases for cancellation source-state ownership: queued succeeds; legacy-immediate and delivered are no-ops; delivered Redis hash and global/user/thread scores remain unchanged. Add a sibling-transition audit that explicitly reserves `markDelivered()` × `markCanceled()` linearizability and no-op queue event suppression to PR #1193 because the current Redis read→write paths have no shared CAS and current queue callers do not inspect the returned state.

### Task A2: Producer inventory and generated-ID proof

**Files:**

- Modify: `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts`
- Test: `packages/api/test/message-store.test.js`

1. Add RED proof cases demonstrating the current sequence can exceed its six-character presentation and lacks an explicit invariant.
2. Choose the generator repair only after confirming whether the public bound should preserve the current format or allow its full safe-integer domain.
3. Export the final source-owned maximum beside the generator and test N/N+1 generator state without relying on wall-clock timing.

Task A2 may document the gap, but its behavior change waits for Decision D1.

## Phase B — decision-gated implementation

### Decision D1: Compatibility posture for identifier maxima

This is a contract/compatibility choice, not a code-style choice.

- **Closure-first:** introduce canonical store-level maxima for `threadId`, user actor IDs, and cat actor IDs, audit historical data, reconcile violations, then separately propose matching K-1 bounds. #1165 records the related reservation but does not authorize that future implementation. This unlocks reserved leaves but can reject previously accepted identities.
- **Compatibility-first:** attest only internally minted IDs now; keep externally sourced `threadId` and actor IDs reserved until their owning ingress paths have independent migration plans. This changes less behavior but does not fully unlock M1/M2/M5.

Recommended default: compatibility-first until a read-only audit shows the closure-first maxima have no legacy violations.

### Decision D2: Unicode-scalar admission

Choose whether canonical ingress rejects isolated UTF-16 surrogates for thread/user/cat IDs. Length-only admission cannot close M1/M2 under revision 6.

Recommended default: add scalar admission together with each identifier's canonical bound, after legacy audit; do not claim scalar compatibility from JSON serialization alone.

### Decision D3: Legacy-data finding disposition

Choose one explicit policy for findings: migrate in a reviewed operator-run tool, quarantine with a visible Host fault and repair path, or keep the affected wire leaves reserved. Tests and this branch must remain report-only.

## Verification commands

```bash
pnpm --filter @cat-cafe/api build
node --test packages/api/test/message-store.test.js
pnpm test:api:redis
pnpm check
```

## Reservation-provenance handoff for #1165

#1165 is retained only as the source of the M7 RESERVED record. It is not the accepted issue for this patch, does not authorize implementation, and must not be closed by #1185. The following evidence would be required before a separate wire-shape proposal could cite this work:

- exact core commit SHA;
- source-owned maxima and their producer/admission paths;
- RED→GREEN test names for memory and Redis parity;
- read-only legacy audit result/provenance, or an explicit statement that affected leaves remain reserved;
- confirmation that no cursor/lease/settlement state moves on an incompatible stored value.
- confirmation that generic append cannot seed transition-owned delivery metadata and that queued creation remains compatible across both stores.
