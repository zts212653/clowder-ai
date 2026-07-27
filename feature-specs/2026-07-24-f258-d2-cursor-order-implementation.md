# F258 D2: Bounded Sortable-ID Producer — Implementation Design v5

**Feature:** F258 / K-1 messaging producer attestation
**Scope:** D2-A "opaque bounded ID + explicit cursor order" from [K-1 Producer Attestation D-Gate](2026-07-19-k1-producer-attestation.md)
**Baseline:** `upstream/main@e3770ef219` (includes #1185, #1192, #1193)
**Worktree:** `/Users/lang/workspace/github-lab/clowder-ai-f258-d2-cursor`
**Branch:** `feat/f258-d2-cursor-order`
**Frozen HEAD:** `a7724b348b84fce8adf38cdfb2b1a70e99e4587c`

## Decision in one paragraph

Keep the existing `timestamp-seq-uuid` lexical ID layout, but **decouple cursor order from the ID**. The sortable ID remains an opaque bounded identity; thread-level visibility order is maintained by a store-owned monotonic **`orderKey`** stored as the Redis thread-ZSET score (and by an equivalent private `Map` in the in-memory store). The orderKey allocator is single-threaded inside Redis: `candidate = max(zsetMaxScore + 1, redisServerTimeMs)`, guarded to be finite, strictly greater than `maxScore`, and not above `Number.MAX_SAFE_INTEGER`; otherwise it fails closed. `timeline`, `user`, and `mentions` ZSETs keep their existing time semantics (`timestamp` for queued/legacy, `deliveredAt` after delivery). Thread pagination uses the orderKey; callers continue to pass a message-ID cursor, and the store resolves the cursor's current score internally. Both `getByThreadAfter` and `getByThreadBefore` are implemented as chunked scans with a **dual-state** (boundary + scanCursor): the boundary only advances when a message is actually returned, while the scanCursor always advances to the raw chunk end; a constant predicate filters any entries at or behind the boundary, making fallback recovery safe without skip counters or offset state. Expired/missing cursors replay from the visibility-order start (allow duplicates, forbid loss). Memory implements the same orderKey invariant via `Map<messageId, orderKey>` and `Map<threadId, maxOrderKey>`.

## Terminal invariants (D2-A)

| Required terminal invariant | How v5 closes it |
|---|---|
| Cursor order is decoupled from opaque ID internals | Cursor is a message ID; its order position is the thread ZSET score (`orderKey`), never `id.slice(0,16)`. |
| Later append/delivery never compares at or before an earlier cursor | `orderKey` is strictly monotonic per thread; re-delivery assigns a fresh orderKey > all existing ones. |
| Expired-cursor recovery is defined | Missing cursor score → replay from start; boundary predicate prevents duplicates; finite ZSET guarantees termination. |
| Strict full-order tie handling | ZSET ranks by `(score, lex(member))`; equal-score buckets are scanned and filtered with `(score,id)` boundary. |
| No false exhaustion across filtered gaps | Chunk scan continues until enough delivered/user-visible messages are collected or the ZSET is exhausted. |
| Finite, enforced output maximum | `MAX_SEQUENCE = 999_999` plus 16-digit timestamp plus 8-char UUID keeps IDs ≤ 32 chars. |
| Memory/Redis parity | Both use the same orderKey allocation semantics; Memory keeps private maps, Redis keeps thread ZSET scores. |
| Idempotency is atomic | JS pre-ID read-only fast path + `APPEND_LUA` atomic claim/write; stale cleanup happens inside the Lua linearization point. |
| `+inf`/numerical edge cases fail closed | `APPEND_LUA` and `DELIVER_LUA` validate `candidate` finite, `≤ MAX_SAFE_INTEGER`, and `> maxScore` before any mutation. |

## Score/ID decoupling

- **ID** = `timestamp-seq-uuid` produced by `generateSortableId`. It is an opaque identity; no store code decodes `id.slice(0,16)` for ordering.
- **Thread visibility score** = `orderKey`, a per-thread monotonic number managed by the store.
- **Timeline/user/mention scores** = `deliveredAt ?? timestamp` (existing time semantics, unchanged).
- `getByThreadAfter(threadId, afterId?)` and `getByThreadBefore(threadId, timestamp, limit?, beforeId?, userId?)` use the thread orderKey for cursor resolution. `getByThreadAfter` follows the visibility order only (no timestamp ceiling). `getByThreadBefore` always applies the `timestamp` argument as an **effective-time AND guard** on top of the orderKey boundary: a candidate is returned only if its `deliveredAt ?? timestamp` is `< cursorTimestamp`, or if it is `== cursorTimestamp` **and** the cursor message itself sits at that same effective time and the candidate's id is lexically smaller than `beforeId`. When `beforeId` is absent the same guard degenerates to the legacy exclusive effective-time bound.

## Append atomicity

Two layers, no layer removed:

1. **JS pre-ID fast path** (read-only): if `idempotencyKey` maps to an existing message, return it immediately. This protects the bounded sortable-ID sequence from being consumed by replays. If the mapped message is missing, do **not** mutate Redis; fall through.
2. **`APPEND_LUA`** (single linearization point): handles stale idempotency cleanup, idempotency claim, orderKey allocation, hash write, all ZSET writes, and TTL/EXPIRE in one script.

`APPEND_LUA` behavior:
- `redis.replicate_commands()` at the top.
- If idempotency key exists and its message hash exists → return that message id.
- If idempotency key exists but hash is missing → treat as stale, allow this call to claim.
- Claim idempotency key with `SET NX`; if lost, re-read and return the winner.
- Compute `orderKey = max(maxThreadScore + 1, redisServerTimeMs)` with guards.
- `HMSET` the hash, `ZADD` timeline/user/mentions with `timestamp`, `ZADD` thread with `orderKey`.
- Apply TTL/EXPIRE and prune expired timeline/user/mentions/thread entries if `ttlSeconds > 0`.
- Return the new message id.

`onAppend` fires **only on created** paths; idempotent replays must not re-fire it (Memory and Redis).

## OrderKey allocation

```
candidate = max(maxScore + 1, serverTimeMs)
assert finite(candidate)
assert candidate <= Number.MAX_SAFE_INTEGER
assert candidate > maxScore       -- strict monotonicity
```

- `serverTimeMs` comes from `redis.call('TIME')` inside the Lua script (Redis) or `Date.now()` (Memory).
- `maxScore` is the current maximum score of the thread ZSET / Memory `threadMaxOrderKeys`.
- Legacy `+inf` / `-inf` scores are read-only compat; writing into a thread whose `maxScore` is `+inf` fails closed instead of silently producing `inf+1 = inf`.

## Thread pagination state machines

### After

```
boundary   = afterId ? (ZSCORE(afterId), afterId) : nil
scanCursor = boundary
result     = []
want       = limit > 0 ? limit : unbounded

loop until result.length >= want or exhausted:
  chunk = GET_THREAD_CHUNK(key, scanCursor, 'after', CHUNK)
  if chunk empty: break
  scanCursor = (chunk.lastScore, chunk.lastId)
  for (id, score) in chunk.entries:
    if boundary && (score,id) <= boundary: continue
    msg = hydrate(id, {includeDeleted:true})
    if !msg: continue
    if !isDelivered(msg): continue
    if userId && !userFilter(msg): continue
    result.push(msg)
    boundary = (score,id)
    if result.length >= want: break
return result
```

### Before (structural mirror with effective-time AND guard)

```
boundary   = beforeId ? (ZSCORE(beforeId), beforeId) : nil
scanCursor = boundary
result     = []
want       = limit ?? DEFAULT_LIMIT
cursorMsg  = beforeId ? getById(beforeId) : null
cursorMsgTs = cursorMsg ? (cursorMsg.deliveredAt ?? cursorMsg.timestamp) : timestamp

loop until result.length >= want or exhausted:
  chunk = GET_THREAD_CHUNK(key, scanCursor, 'before', CHUNK)
  if chunk empty: break
  scanCursor = (chunk.lastScore, chunk.lastId)    -- descending raw end
  for (id, score) in chunk.entries:
    if boundary && (score,id) >= boundary: continue
    msg = hydrate(id)                              -- no tombstones for before
    if !msg: continue
    if msg.deletedAt: continue
    if !isDelivered(msg): continue
    if userId && !userFilter(msg): continue
    effectiveTs = msg.deliveredAt ?? msg.timestamp
    if effectiveTs > timestamp: continue
    if effectiveTs == timestamp:
      if cursorMsgTs == timestamp:
        if msg.id >= beforeId: continue           -- exclude cursor and lexically at/after it within same ts
      else:
        continue                                   -- strict bound when cursor is anchored at a different effective time
    result.push(msg)
    boundary = (score,id)
    if result.length >= want: break
return result.reverse()
```

`GET_THREAD_CHUNK` is a thin Lua that atomically resolves the start rank and returns the next `CHUNK` entries with `WITHSCORES`. It has two modes:
- `after`: `ZRANK` fast path or `ZCOUNT -inf (cursorScore` fallback; then `ZRANGE ... WITHSCORES`.
- `before`: `ZREVRANK` fast path or `ZCOUNT (cursorScore +inf` fallback; then `ZREVRANGE ... WITHSCORES`.

### Before/after asymmetry and mismatched-cursor behavior

- **`getByThreadAfter`** follows visibility order (`orderKey`) only. It has no effective-time ceiling, so a far-future delivered message is fully visible when paging forward. This matches the unseen-loss fix that motivated D2.
- **`getByThreadBefore`** keeps the visibility-order boundary **and** an always-active effective-time guard. This preserves the historical "before timestamp" paging contract: a message whose `deliveredAt ?? timestamp` is strictly greater than the cursor timestamp is never returned, even if its `orderKey` is before the cursor.
- **Composite-cursor tie break** (`cursorMsgTs == timestamp`): when the cursor message itself sits at the passed timestamp, same-timestamp candidates with lexically smaller ids are included. This prevents same-millisecond burst messages from falling into a gap.
- **Mismatched cursor** (`cursorMsgTs != timestamp`, e.g. a legacy fractional numeric cursor anchored to a real message at a different time): the effective-time guard becomes strict for that exact timestamp. Same-timestamp candidates are conservatively excluded. The result set is smaller but never repeats and never crosses the cursor boundary.
- **Missing/expired cursor** (`boundary == null`): `getByThreadBefore` replays from the visibility start and applies the strict effective-time guard, avoiding unbounded growth of the result window.

## Memory parity

- `messageOrderKeys: Map<messageId, number>` — only append and physical removal mutate it.
- `threadMaxOrderKeys: Map<threadId, number>` — allocator writes it; `deleteByThread` deletes it.
- `markCanceled` does **not** delete `messageOrderKeys[id]`.
- Missing orderKey is a hard invariant failure (`throw`).
- All four thread read surfaces (`getByThread`, `getByThreadIncludingQueued`, `getByThreadAfter`, `getByThreadBefore`) share a single view sorted by `(orderKey, id)`.

## Redis version

All write scripts that call `redis.call('TIME')` begin with `redis.replicate_commands()`. This is a no-op on Redis 7+ and enables the required effects replication on Redis 3.2+. Tested locally on Redis 8.6.1; recommended production minimum is 7.0.

## Files changed

- `packages/api/src/domains/cats/services/stores/redis/redis-message-delivery-lua-scripts.ts`
  - Add `APPEND_LUA`.
  - Add `GET_THREAD_CHUNK_LUA` (after/before shared).
  - Update `DELIVER_LUA` to allocate a fresh thread orderKey and guard numerics.
  - Remove `GET_BY_THREAD_AFTER_LUA`.
  - Keep `CANCEL_LUA` and `REASSIGN_LUA` semantics aligned (cancel does not remove thread member; reassign does not touch thread orderKey).
- `packages/api/src/domains/cats/services/stores/redis/RedisMessageStore.ts`
  - `append`: use `APPEND_LUA`; keep read-only JS idempotency fast path; remove JS `redis.del(idempotencyKey)`.
  - `getByThreadAfter`, `getByThreadBefore`: dual-state chunked scan.
  - `getByThread` / `getByThreadIncludingQueued`: continue to scan the thread ZSET by orderKey; filter semantics unchanged.
  - `deleteByThread`: unchanged (deletes thread ZSET; orderKey allocator restarts from `TIME` on next append).
- `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts`
  - Add orderKey maps to `MessageStore`.
  - Update append/markDelivered/deleteByThread/trim to maintain maps.
  - Reimplement thread read surfaces over the `(orderKey,id)` view.
  - Ensure `onAppend` fires only on created messages.
- `packages/api/test/message-store.test.js`
  - Add RED tests for orderKey ordering, filtered-gap after/before, cancel parity, idempotency replay without `onAppend` re-fire.
- `packages/api/test/redis-message-store.test.js`
  - Update score assertions to orderKey semantics.
  - Add RED tests for `+inf`/numerical guards, equal-score fallback, filtered gap, idempotency atomicity, Memory/Redis parity.

## RED matrix

| # | RED statement | Verification |
|---|---|---|
| 1 | `generateSortableId` still rejects invalid timestamps and bounds length/sequence. | `d2-cursor-order.test.js` |
| 2 | `append` rejects transition-owned `deliveredAt`/`deliveryStatus`. | existing ownership tests |
| 3 | `append` is atomic: after any outcome, either the message hash + all indexes exist, or no Redis keys are created. | invalid-timestamp / ownership tests |
| 4 | `APPEND_LUA` idempotency: concurrent same-key appends produce exactly one hash, one thread member, and both callers return the same message. | new Redis RED test |
| 5 | `onAppend` fires only on `created`; idempotent replay does not re-fire (Memory and Redis). | new RED test |
| 6 | Thread ZSET score is `orderKey`, not `timestamp`/`deliveredAt`; timeline/user keep time semantics. | updated score assertions |
| 7 | `markDelivered` assigns a strictly larger thread orderKey than any existing member. | new Redis RED test |
| 8 | `markDelivered`/`append` fail closed when the thread max score is `+inf` or near `2^53`. | new numerical-guard RED test |
| 9 | `markCanceled` does not remove the thread member and does not delete Memory `messageOrderKeys[id]`. | existing cancel parity test |
| 10 | `getByThreadAfter` returns messages after the cursor in thread order, including across queued→delivered re-score. | existing + new filtered-gap test |
| 11 | `getByThreadAfter` does not falsely exhaust when the first raw item after the cursor is queued/canceled/another-user. | new filtered-gap RED test |
| 12 | `getByThreadAfter` equal-score fallback recovers correctly when the anchor member is re-scored or removed. | new equal-bucket RED test |
| 13 | `getByThreadBefore` is the exact structural mirror: no reverse-rank math errors, excludes deleted, respects cursor boundary. | new + existing before tests |
| 14 | `getByThreadBefore` with missing/expired cursor replays from start without loss. | existing expired-cursor tests |
| 15 | Memory and Redis return the same thread order for identical append/deliver/cancel sequences. | parity RED test |
| 16 | `_orderKey` or any internal score is not exposed on returned `StoredMessage` objects. | JSON projection test |

## Test evidence

```bash
# producer + memory
cd packages/api
pnpm run build
node --test test/d2-cursor-order.test.js test/message-store.test.js

# redis (isolated DB 15)
CAT_CAFE_REDIS_TEST_ISOLATED=1 REDIS_URL=redis://localhost:6379/15 \
  node --test test/redis-message-store.test.js
```

## Quality-gate checklist before PR

- [x] `pnpm --filter @cat-cafe/api test:public` passes (16723/16723).
- [x] Cross-family review by Maine Coon / sol (`@codex`) — completed in thread.
- [ ] No changes to runtime config, Redis data, or operator data stores.
- [ ] No claims that close M1/M2/M5/M6/M7 or #1200/#1165.
