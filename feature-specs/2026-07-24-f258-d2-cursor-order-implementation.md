# F258 D2: Bounded Sortable-ID Producer — Implementation Design

**Feature:** F258 / K-1 messaging producer attestation
**Scope:** D2-A "opaque bounded ID + explicit cursor order" from [K-1 Producer Attestation D-Gate](2026-07-19-k1-producer-attestation.md)
**Baseline:** `upstream/main@e3770ef219` (includes #1185, #1192, #1193)
**Worktree:** `/Users/lang/workspace/github-lab/clowder-ai-f258-d2-cursor`
**Branch:** `feat/f258-d2-cursor-order`

## Decision in one paragraph

Keep the existing `timestamp-seq-uuid` lexical ID layout and treat it as the explicit cursor-order key. Because #1185 already restricts future writes to non-negative integral ECMAScript Date values, the timestamp component is a fixed 16-digit decimal string and the sequence component can be bounded to six decimal digits per logical timestamp. The producer tracks a single *logical* high-water timestamp and a per-logical-timestamp sequence counter; advancing the high-water mark resets the counter, so there is no process-lifetime sequence ceiling. The logical timestamp is derived from admitted timestamps: it moves forward when the caller supplies a larger timestamp and stays unchanged for smaller or equal inputs. A single admitted timestamp can advance the high-water mark by at most `MAX_HIGH_WATER_ADVANCE_MS` (24 hours), which prevents one far-future input from pinning the global sequence bucket for the remaining process lifetime. This preserves exact lexical cursor order using only bounded local state while still admitting out-of-order timestamps (for example, a queued message with an earlier timestamp appended after a later one). The producer fails closed (`RangeError`) when the per-timestamp sequence would exceed `MAX_SEQUENCE`, preventing the `999999 → 1000000` lexicographic inversion and guaranteeing a 32-character output ceiling. Memory and Redis continue to share the same producer, so they implement the same ordering relation without a separate order-key field.

## Why this satisfies D2-A

| Required terminal invariant | How this implementation closes it |
|---|---|
| A later append at the same effective score never compares at or before an earlier cursor | The producer keeps a monotonic logical timestamp and a per-logical-timestamp sequence counter. The 6-digit zero-padded form preserves lexicographic order for IDs sharing the same logical timestamp up to `MAX_SEQUENCE`, and cross-timestamp order is preserved by the fixed-width logical-timestamp prefix. Out-of-order input timestamps are promoted to the current logical timestamp, so generation order still matches lexical order. |
| Expired-cursor recovery is defined for mixed legacy/new IDs | The ID format is unchanged; legacy six-digit IDs and new bounded IDs order consistently by timestamp first, then by sequence. Tests cover `getByThreadAfter` with a mixed-epoch cursor. |
| Finite, enforced output maximum | `MAX_SEQUENCE = 999_999` plus 16-digit timestamp plus 8-character UUID gives a hard 32-character ceiling. |
| Sequence exhaustion/restart/concurrency is explicit and fail-closed | Exhaustion throws `RangeError: sortable-ID sequence exhausted` before width expansion or wrap. Advancing the high-water timestamp resets the sequence counter, so there is no process-lifetime ceiling. Restart resets both high-water and sequence; this is documented as a known boundary that production callers must mitigate with monotonic timestamps. |
| Memory and Redis implement the same ordering relation | Both stores import `generateSortableId` from the same module and rely on Redis ZSET ordering for score ties. |

## Files changed

- `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts`
  - Export `MAX_SEQUENCE`.
  - Export test-only `resetSortableIdSequence` and `getSortableIdSequence` hooks.
  - Add fail-closed exhaustion guard in `generateSortableId`.
- `packages/api/test/d2-cursor-order.test.js`
  - Admission regressions (existing).
  - Same-timestamp lexicographic order.
  - Six-digit sequence exhaustion and bounded length.
  - Restart boundary documentation.
- `packages/api/test/redis-message-store.test.js`
  - Redis exhaustion fail-closed and zero-partial-state proof.
  - Mixed-epoch legacy/new ID ordering and expired-cursor recovery.

## Explicit boundaries and reservations

- **Logical timestamp in the ID prefix.** The 16-digit timestamp component of the sortable ID is a process-local logical ordering timestamp, not necessarily the message's stored timestamp. It advances when the caller supplies a larger timestamp and never decreases, so the lexical cursor order is always well-defined.
- **High-water advancement is rate-limited.** A single admitted timestamp can advance the logical high-water mark by at most `MAX_HIGH_WATER_ADVANCE_MS` (24 hours). Far-future timestamps are still admitted but their contribution to the ordering key is capped, preventing a single future input from pinning the global sequence bucket.
- **Out-of-order timestamps are admitted but promoted.** #1185's non-negative integral Date domain is still validated. Timestamps lower than the current high-water mark are admitted using the current logical timestamp as the ID prefix, so they still sort after all earlier IDs generated in the process.
- **No historical data scan or migration.** This is a future-write producer boundary only; D3 raw audit and M7 historical compatibility remain RESERVED per the D-Gate.
- **No `threadId`, `actor.id`, or Unicode-scalar bounds.** Those identifiers have alternate ingress paths and remain RESERVED pending source-specific inventory.
- **No shared CAS between concurrent processes.** The sequence state is local to a single Node.js process (one high-water logical timestamp + one sequence counter); cross-process order is only guaranteed for callers that supply monotonically non-decreasing timestamps.
- **Sequence reset at the same logical timestamp can regress order.** The producer has no memory of prior process epochs; production callers must not reset or restart within the same millisecond.
- **Extreme clock rollback is bounded.** A caller-supplied timestamp far below the current high-water mark still produces an ordered ID, but its ID prefix no longer matches its stored timestamp. Consumers that decode the ID prefix as a timestamp would observe the logical value, not the original input.

## Test evidence

Run the targeted suites:

```bash
# memory + producer
cd packages/api && node --test test/d2-cursor-order.test.js test/message-store.test.js

# redis (isolated DB 15)
CAT_CAFE_REDIS_TEST_ISOLATED=1 REDIS_URL=redis://localhost:6379/15 \
  node --test test/redis-message-store.test.js
```

All listed suites pass at the current HEAD.

## Quality-gate checklist before PR

- [ ] `pnpm --filter @cat-cafe/api test:public` or equivalent public gate passes.
- [ ] Cross-family review by Maine Coon / sol (`@codex`).
- [ ] No changes to runtime config, Redis data, or operator data stores.
- [ ] No claims that close M1/M2/M5/M6/M7 or #1200/#1165.
