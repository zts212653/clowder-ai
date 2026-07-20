# K-1 Producer Attestation Implementation Plan

**Feature:** F258 / #1165 producer-owned closure follow-up
**Goal:** Establish testable source-side guarantees for message identifiers, thread identifiers, actor identifiers, and message timestamps without inventing an unreviewed wire bound or silently excluding stored messages.
**Acceptance Criteria:** Until D2 decouples cursor order from ID text, future message writes admit only non-negative integral JavaScript `Date` timestamps and reject all other values before persistence; every proposed identifier bound is traced to a producer or admission source; memory and Redis stores share one admission rule; legacy stored data has an explicit read-only audit and reconciliation decision before any bound is claimed compatible; #1165 receives only claims backed by tests and an exact core commit.
**Architecture cell:** `identity-session` (actor identity) with `thread-navigation` as an adjacent owner (thread identity)
**Map delta:** none
**Map delta why:** This hardens existing producer/admission boundaries; it does not move ownership or introduce a new runtime component.
**Architecture:** A pure admission helper is the single write-side policy consumed by both message stores. It temporarily matches the domain that the current lexical sortable-ID/cursor encoding can preserve; D2 will replace that coupling before the full valid-Date domain can be restored. A separate read-only audit reports legacy violations; it does not mutate persistent data. K-1 projection remains fail-closed and may rely on a bound only after admission, legacy compatibility, and the corresponding #1165 shape delta are all reviewed.
**Tech Stack:** TypeScript, Node test runner, in-memory message store, Redis message store
**前端验证:** No

---

## Grounding verdict

The work is valid, but the original task summary is not sufficient authorization to choose public maxima.

- #1165 revision 6 explicitly leaves `messageId`, `threadId`, and `actor.id` reserved pending a K-1 attested bound or admission gate.
- The same revision says that the resulting wire bound enters as a reviewed shape delta.
- `occurredAt` additionally requires valid-Date admission and stored-data attestation/migration.
- The roadmap identifies the work but supplies no exact identifier maxima or legacy-data disposition.

Therefore Phase A below is executable now. Phase B must not begin until the decision packet is resolved.

## Finish line and non-goals

Terminal state:

1. all new messages satisfy one source-owned identity/timestamp policy before any storage side effect;
2. memory and Redis stores behave identically;
3. a read-only legacy audit can prove whether persisted values fit the proposed policy;
4. K-1 can cite exact tests and a commit when proposing the corresponding #1165 shape delta.

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

## Core invariants

- **INV-1 — pre-write admission:** Invalid identity/timestamp input is rejected before idempotency claims, Redis commands, in-memory append, indexes, or append listeners change.
- **INV-2 — store parity:** Memory and Redis stores call the same pure policy and return the same error class for the same invalid input.
- **INV-3 — sortable valid-Date domain:** Every newly persisted timestamp is a non-negative integer inside ECMAScript `Date` TimeClip, so both `toISOString()` and the current timestamp-prefixed ID ordering remain valid. Full valid-Date admission waits for D2 explicit cursor order.
- **INV-4 — generated-id bound:** Every newly minted message ID satisfies a documented finite maximum; generator state cannot silently escape that maximum.
- **INV-5 — scalar compatibility:** A bound is not called wire-compatible unless the admitted string domain also excludes isolated UTF-16 surrogates required by the compact wire profile.
- **INV-6 — legacy honesty:** New-write admission does not prove historical compatibility. Hydration preserves present-but-blank timestamps as invalid evidence rather than fabricating epoch zero, and Redis numeric aliases retain their original finite/non-finite values; legacy closure still requires a read-only audit result or an explicit migration/reconciliation policy.
- **INV-7 — no silent skip:** A legacy incompatibility is a Host fault with a reconciliation path; it cannot advance a delivery cursor, callback lease, or settlement state.
- **INV-8 — legacy cursor exclusivity:** Redis before-cursor pagination parses canonical sorted-set score spellings into the same numeric domain as hydrated timestamps, so preserved fractional and infinity cursors are excluded rather than replayed and bounded multi-page consumers always make progress.

## Existing behavior protection

| Existing behavior | Protection |
|---|---|
| message IDs remain lexicographically sortable for admitted timestamps | paired boundary classes plus delivery-cursor and memory/Redis expired-cursor tests |
| idempotent append returns the original message | retain existing memory and Redis idempotency tests |
| Redis and memory stores persist the same canonical fields | paired admission cases in `message-store.test.js` and `redis-message-store.test.js` |
| Redis legacy fractional timestamps remain exact and before cursors remain exclusive | direct legacy hash/zset fixture exercises both before-cursor APIs plus a bounded real-store multi-page collector |
| Redis blank timestamp evidence is not normalized into valid data | direct empty/whitespace fixtures exercise single and batch hydration while preserving fractional and missing-field compatibility |
| Redis canonical `inf` / `-inf` scores remain equivalent to hydrated `Infinity` / `-Infinity` | direct positive/negative infinity fixtures exercise both before-cursor APIs; the bounded collector covers positive-infinity progress |
| existing route-generated thread/user/cat identifiers continue to append | boundary-success fixtures at the selected maxima |
| no production data is touched by audit tests | audit accepts an injected iterator/snapshot and defaults to report-only |

## Stateful-object census

| Object | Lifecycle owner | Relevant transitions | Adversarial cases |
|---|---|---|---|
| message record | `IMessageStore.append` implementation | candidate → admitted → persisted/indexed | invalid input, idempotency replay, Redis contention, listener side effects |
| sortable-id generator state | `generateSortableId` module | sequence read → increment → encoded | same millisecond burst, maximum safe sequence, non-monotonic timestamp |
| persisted legacy message | existing store data | hydrated → audited → compatible/finding | malformed timestamp, oversized/non-scalar identity, missing field |
| cat registry identity | catalog loader/registry | configured → registered → referenced by message | route-created vs file-configured IDs, registry reload |

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
6. Build and run the focused memory/Redis suites.

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

- **Closure-first:** introduce canonical store-level maxima for `threadId`, user actor IDs, and cat actor IDs, audit historical data, reconcile violations, then propose matching #1165 bounds. This unlocks reserved leaves but can reject previously accepted identities.
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

## Handoff evidence required for #1165

- exact core commit SHA;
- source-owned maxima and their producer/admission paths;
- RED→GREEN test names for memory and Redis parity;
- read-only legacy audit result/provenance, or an explicit statement that affected leaves remain reserved;
- confirmation that no cursor/lease/settlement state moves on an incompatible stored value.
