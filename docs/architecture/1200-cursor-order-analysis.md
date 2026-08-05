# Issue #1200 — Cursor Order Architecture Analysis

**Author**: 布偶猫/宪宪 (@opus)
**Branch**: `fix/1200-cursor-order` (rebased onto `upstream/main` @ `f30e20c28`)
**Status**: ✅ **ARCHITECTURE GATE OPEN** — rev 7 APPROVED by Sol.
Implementation proceeds per §8.10. Canonical contract: **#1269** (maintainer
decision, binding). Architecture doc is reference material, not the contract
source.

**Activation gate** (#1269, wired per maintainer review rounds 1-3):
`VISIBILITY_CURSOR_V2=on` env var controls **durable-slot initiation** only.
`cursorFor()` always produces canonical v2 when visibilitySeq is known
(not gated — CAS comparison/advancement must be v2-coherent in both modes).
`gateForDurableSlot()` in `cursor-activation.ts` controls whether untouched
durable slots initiate v2 encoding. Wired at all durable write boundaries:
- `DeliveryCursorStore.ackCursor/ackMentionCursor/ackSeenCursor` (delivery, mention, seen)
- `gatedReadStateAck()` in `threads.ts` (read-state via all 3 ingress points)
Existing v2 slots advance in v2 regardless of gate state (rollback-safe).
PreReconcile (v1→v2 stored upgrade) is gated: only runs when writing v2.

**Sunset criteria**: The `VISIBILITY_CURSOR_V2` flag is a temporary deployment
control. It can be removed (always-on) once v2 cursors have been validated
in production across all durable cursor consumers and the rollback window
has closed.

---

## 1. Problem Statement

Thread message pagination uses two incompatible ordering relations that create a cursor cycle.

**Provenance**: This is a **code-audit / defensive correctness finding** discovered
during K-1/K-2 messaging infrastructure hardening (PR #1185 timestamp validation
and plugin-contract message boundary design). No production incident has been
traced to this cursor-domain mismatch. The project owner has observed related
message display anomalies (F117 cancelled-message visibility, F123 bubble
duplication/disappearance, pr #1146 message timing questions), but causal
attribution to the cursor ordering domain is inferential, not traced.

### The C→Q→C Cycle (Synthetic Counterexample)

The following is a **synthetic state-space counterexample** derived from the
store/CAS code paths. It demonstrates a reachable ordering inconsistency in the
`getByThreadAfter` OR-union logic and lexicographic cursor CAS, not a traced
production failure through a specific F254 carrier lifecycle.

Given:
- Message **C** (direct): created at t=200, delivered immediately. `C.id ≈ "0000…0200-…"`, ZSET score = 200.
- Message **Q** (queued): created at t=100, delivered at t=300. `Q.id ≈ "0000…0100-…"`, ZSET score = 300 (re-scored by DELIVER_LUA).

Ordering comparison:
| Relation | C vs Q | Winner |
|----------|--------|--------|
| Lexicographic ID | Q.id < C.id | C is "after" Q |
| ZSET score | C.score < Q.score | Q is "after" C |

Current `getByThreadAfter` uses OR-union: `id > afterId OR score > afterScore`.
- Query after C → returns Q (via score branch: Q.score=300 > C.score=200)
- Query after Q → returns C (via ID branch: C.id > Q.id)
- **Cycle**: C → Q → C → Q → …

Callers (`route-helpers.ts`, `DeliveryCursorStore`, `checkFreshnessForPostMessage`) store the last returned message ID and advance via lexicographic comparison (`boundary > current`). A cycle means the cursor alternates between C and Q indefinitely.

No single production consumer has been identified that both observes C and later
consumes Q through the same cursor in a normal same-target FIFO journey. The
counterexample establishes the structural invariant violation at the store/CAS
layer independent of any specific carrier.

### Memory/Redis Parity Gap (Baseline)

The Memory store (in-memory array, never re-sorted) does NOT exhibit this cycle — but only because it silently drops late-delivered messages from forward pagination entirely. `markDelivered` sets `deliveredAt` but does not reposition the message. Walking forward from C never encounters Q (Q is before C in insertion order).

The Redis store finds Q via ZSET score re-scoring. No shared test covers this behavioral divergence.

---

## 2. Current Implementation (upstream/main)

### Message ID Format
`<16-digit zero-padded timestamp>-<6-digit sequence>-<8-char UUID>`
Lexicographic order = insertion order within same process (module-global `_seq` monotonically increases).

### MessageStore (Memory)
- `getByThreadAfter(threadId, afterId, limit, userId)`:
  - Primary: walks array forward, exact-match cursor by ID, returns everything after.
  - Fallback (cursor pruned): `msg.id <= afterId` lexicographic filter.
  - **Late-delivered messages**: invisible in forward pagination (array position unchanged).
- `getByThreadBefore(threadId, timestamp, limit, beforeId, userId)`:
  - Composite cursor `(timestamp, beforeId)`. Uses `effectiveTs = deliveredAt ?? timestamp`.
  - Walks array backward. Same-ts tiebreak: `msg.id >= beforeId` excluded.

### RedisMessageStore
- `getByThreadAfter(threadId, afterId, limit, userId)`:
  - No afterId: `ZRANGE 0 limit-1`.
  - afterId + score found: OR-union of `(same-score, id > afterId)` + `(score > afterScore)`. **← cycle source**
  - afterId + score missing: full `ZRANGE 0 -1` + `id > afterId` lex filter.
  - **Late-delivered messages**: visible via score branch (score shifts on delivery).
- `getByThreadBefore(threadId, timestamp, limit, beforeId, userId)`:
  - Chunked `ZREVRANGEBYSCORE`. Composite cursor with same-score ID tiebreak.
  - Consistent with Memory store's effective-time semantics.

### ZSET Score Lifecycle
- **Append**: score = `msg.timestamp` in all ZSETs (timeline, thread, user, mentions).
- **Deliver**: DELIVER_LUA re-scores to `deliveredAt` in thread, timeline, and user ZSETs.
- **Cancel**: no ZSET change (message filtered by `isDelivered` check).

### Cursor Consumers (all use lex ID comparison)
- `route-helpers.ts`: `upsertMaxBoundary` — `boundaryId > current` (string `>`).
- `DeliveryCursorStore`: `ackCursor` — `effective <= current` skip (string `<=`).
- `checkFreshnessForPostMessage`: `paginationCursor = batch[batch.length - 1].id`.

---

## 3. The Impossibility Under Current Contract

**Claim**: Under the current external contract (cursor = raw message ID, progress = lexicographic string comparison), no single ordering can simultaneously:
1. Include late-delivered messages at their delivery position (visibility correctness)
2. Guarantee monotonic cursor progress (no cycles, no stuck cursors)

**Proof sketch**:
- Late-delivered Q has `Q.id < C.id` but must appear after C (delivered later).
- If `getByThreadAfter` returns Q after C, the caller sets cursor = Q.id.
- Since `Q.id < C.id`, the caller's `boundary > current` check fails (Q.id is not > C.id).
- Either the cursor doesn't advance (stuck), or if forced, it regresses.

**Corollary**: Any correct solution must change the cursor contract OR accept that late-delivered messages don't appear in forward pagination.

---

## 4. Solution Space

### A. Store-Owned Monotonic Sequence (orderKey)

Each thread maintains a monotonically increasing counter. Messages receive an orderKey at their "visibility moment":
- Direct append: orderKey assigned at append time.
- Queued → delivered: NEW orderKey assigned at delivery time (strictly greater than all prior).

**Cursor format**: Versioned opaque token, e.g. `v2:<orderKey>:<messageId>` or structured object `{ v: 2, ok: number, id: string }`.

**Pagination**: `getByThreadAfter` scans by `orderKey > cursor.ok`. Total order. No cycles.

**Caller migration**: All cursor consumers compare cursor objects (by orderKey), not raw strings. DeliveryCursorStore, route-helpers, checkFreshness all change.

**Legacy migration**: v1 cursors (raw message IDs) → look up message's orderKey. If message pruned → orderKey = 0 (scan from thread start, deduplicate against delivered set).

**Memory parity**: Memory store maintains `Map<threadId, number>` for max orderKey + `Map<messageId, number>` for per-message orderKey. markDelivered assigns new orderKey.

| ✅ Pro | ❌ Con |
|--------|--------|
| Clean total order, provably cycle-free | Requires cursor format migration |
| Memory/Redis parity by construction | All cursor consumers must change |
| orderKey is private; external API can keep message IDs as display identifiers | Additional Redis state (counter key per thread) |
| Pruned cursor degrades gracefully | |

### B. Effective-Time Composite Cursor

Order by `(effectiveTs, messageId)` where `effectiveTs = deliveredAt ?? timestamp`. Cursor = `{ ts: number, id: string }`.

| ✅ Pro | ❌ Con |
|--------|--------|
| Uses existing data | effectiveTs can change (on delivery) — cursor instability |
| Simpler than orderKey | Same-effectiveTs + different-ID tiebreak still uses lex ID (fragile) |
| | Message's effectiveTs changes on delivery → in-flight cursor invalidated |

**Rejected**: effectiveTs mutability makes cursor references unstable. A cursor pointing at Q before delivery resolves differently after delivery.

### C. Immutable Visibility Timestamp

Like B, but assign effectiveTs once and never change:
- Direct: effectiveTs = timestamp (at append).
- Queued: effectiveTs = deliveredAt (at delivery, assigned once).

Still needs a tiebreaker. If two messages have the same effectiveTs, lex ID tiebreak can create micro-cycles within the same millisecond bucket.

**Verdict**: Strictly weaker than A. If we need a new cursor format anyway (to carry effectiveTs), we might as well use a monotonic integer that's simpler to reason about.

### D. Separate Visibility Index

Maintain a second ZSET per thread scored by "visibility time". Original thread ZSET stays as-is.

**Rejected**: Doubles Redis storage per thread. Adds complexity without solving the cursor format problem.

### E. Accept Late-Delivery Invisibility in Forward Pagination

Don't return late-delivered messages in `getByThreadAfter`. They appear only via `getByThreadBefore` (history load) or full thread fetch.

| ✅ Pro | ❌ Con |
|--------|--------|
| No cursor change needed | Late-delivered messages invisible to delivery cursor → agents miss them |
| Matches current Memory store behavior | Breaks the Redis test that proves late-delivery visibility |
| Simplest implementation | Queued messages become second-class citizens |

**Verdict**: Unacceptable if queued messages must be visible to agent routing. Acceptable only if a separate "pending delivery" notification path exists.

---

## 5. Recommendation

**Option A (store-owned monotonic orderKey)** is the only approach that satisfies all constraints:
- Single total order → no cycles ✅
- Private to store → external API unchanged ✅
- Assigned at visibility moment → late-delivery correct ✅
- Integer comparison → no lex-ID dependency ✅
- Memory/Redis parity by mirrored counter ✅

The key design decisions Fable needs to make:

1. **Cursor wire format**: opaque base64? structured JSON? versioned string `v2:ok:id`?
2. **Cursor storage**: Do DeliveryCursorStore / seen / mention cursors store the new format, or do they keep message IDs and resolve to orderKey on read?
3. **Migration strategy**: How do in-flight v1 cursors (raw message IDs in Redis) get resolved? Is there a "re-scan from last known position" fallback?
4. **getByThreadBefore**: Does it also use orderKey, or keep effective-time semantics? (The before path doesn't have the cycle problem because it walks backward from a timestamp, not forward from an ID.)
5. **Scope boundary with #1210**: PR #1210 has atomicity/idempotency/TTL fixes. Does this PR depend on those, or are they orthogonal? If APPEND_LUA from #1210 is needed, what's the rebase strategy?

---

## 6. Open Questions (from Sol's handoff)

| # | Question | Notes |
|---|----------|-------|
| 1 | Public cursor versioned? | If yes, old clients sending v1 cursors need migration path |
| 2 | Order source/index truth | orderKey counter: per-thread Redis key? Hash field? |
| 3 | Legacy data migration | Existing messages have no orderKey. Backfill or scan-from-zero? |
| 4 | before/after shared relation? | before uses effective-time; does after switch to orderKey independently? |
| 5 | Concurrent deliver + paginate | Delivery assigns orderKey → concurrent getByThreadAfter reads stale page? |
| 6 | No-limit / backfill contract | getByThreadAfter with no limit: does it return all? Bounded by what? |
| 7 | TTL / hard-delete vs high-water | If the highest-orderKey message is deleted, does the counter reset? (Must not.) |

---

## 7. Baseline Test Coverage

| Test file | Coverage | Late-delivery cursor? |
|-----------|----------|-----------------------|
| `d2-cursor-order.test.js` | sortable ID generator only | No |
| `message-store.test.js` | Memory getByThread basic pagination | No late-delivery test |
| `redis-message-store.test.js` | Redis late-delivery visibility (line 912) | Yes, but single-page only — no progress/cycle test |
| `messages-endpoint.test.js` | API cursor pagination | Unknown (not reviewed) |

**Missing tests** (RED tests to write):
1. C→Q→C cycle regression (both stores)
2. Two-page cursor progress with late-delivered message
3. Limit pagination with interleaved direct/queued messages
4. Pruned/expired cursor fallback with orderKey
5. Memory/Redis parity for late-delivery ordering

> ⚠️ Superseded by §8.1 — the §1 cycle as written does NOT reproduce on current
> upstream/main. RED tests must target FM-1…FM-6 below, or they come up green.

---

## 8. Architecture Verdict (Fable, 2026-07-27, rev 7)

**Verdict: Option A's PRINCIPLE confirmed (store-owned monotonic visibility
sequence); its STRUCTURE amended — dedicated visibility index, not thread-ZSET
score replacement.** Sol's 001237 recommendation is adopted with bindings below.

> **Rev 3 status**: rev 2 was BLOCKED by Sol's cross-post review (16:30 UTC,
> 3 P1s, all CONFIRMED on verification): (A) legacy equal-score successors lost
> under numeric-only cursor + exclusive range; (B) append shape (b)'s crash
> window is NOT healed by retry — the idempotency fast path short-circuits
> before allocation, and the EXISTS backfill guard is blind to single missing
> members; (C) `cursorFor` cannot issue v2 for legacy messages (no hash field;
> ZSCORE resolve lives on the read side, not the issuance side). Rev 3 fixes:
> canonical position becomes the **(seq, id) pair** (8.3/8.4), shape (b) is
> **deleted** (8.6), issuance closes via **WITHSCORES injection + graded
> issuance** (8.7).
>
> **Rev 4** answers Sol's rev-3 narrow scan (16:42 UTC, 2 P1 + 1 P2, all CONFIRMED
> against first-hand code): (P1-1) legacy fractional/±inf scores are a protected
> contract that `ZUNIONSTORE` copying + integer-only `seq16` cannot close → backfill
> becomes **rank-normalize** (8.2), with the consequence that index cleanup is
> **member-driven, never score-cutoff**; (P1-2) RED #15 narrowed to
> immediately-visible appends, new RED #19 pins the queued lifecycle + legacy-replay
> issuance; (P2-1) WITHSCORES injection binds **by id via Map**, never by array
> position (8.7, RED #11).
>
> **Rev 5** lands Sol's merged-gate remainder (16:52 UTC, 4 P1 + 1 P2, all verified
> first-hand): (P1-1) order truth moves to a **persistent per-thread meta hash**
> (`migrated` + `hwm`) — never TTL'd, only deleteByThread removes; allocator reads
> meta, migration guard reads meta, the index becomes a pure query set (rev 4's
> "index IS the high-water" is formally superseded); (P1-2) **mention successor
> selection moves to the visibility relation** (per-thread paging + hash-mentions
> filter; ack cursor is per-cat-per-thread so this closes the leak with zero new
> structures); (P1-3) **read-state mark-all/read-latest migrate** to
> `getLatestVisibleCursor`; (P1-4) **cursor CAS TTL default becomes 0** (Iron Law 5;
> `EX 604800` was silently resetting all cursor namespaces weekly); (P2) backfill
> gets `MAX_BACKFILL_MEMBERS = 50_000` fail-visible bound + stale far-future
> headroom prose removed. RED grows to 25.
>
> **Rev 6** answers Sol's rev-5 final narrow scan (17:01 UTC, 4 implementation P1 +
> 1 doc-truth P1, all verified): (P1-1) **read-side migration guard**
> `ensureVisibilityMigrated` on every visibility read/resolve entry — read-only
> legacy threads must not return empty pages forever; (P1-2) mention scan is
> **match-counted inside the visibility relation** — rev 5's page-then-filter would
> resurrect FM-2 as mention starvation; (P1-3) **canonicalize-before-write** on all
> CAS ingress (incl. `PATCH /read`, mention acks) + `/read/latest` keeps its
> `messageId` wire contract via `{cursor, messageId}`; (P1-4) TTL fix covers
> **pre-existing keys** (PERSIST-before-compare in the TTL=0 branch, read-path
> PERSIST, one-shot ops sweep); (P1-5) every stale `indexMax`/"index is high-water"
> phrase swept to `meta.hwm`. RED grows to 26 (#22/#23/#24 extended).
>
> **Rev 7** answers Sol's rev-6 re-scan (17:07 UTC, 2 adjacent P1, both CONFIRMED —
> each a rev-6 sentence colliding with an established contract): (P1-1) read-path
> PERSIST **deleted** — the write-path LUA branch IS the policy discriminator
> (ttl=0 → PERSIST-before-compare; ttl>0 → EX, never PERSIST), reads never touch
> TTL, dormant keys go to the cutover-ordered ops sweep, and a recorded constraint
> pins future opt-in call sites to a policy marker; (P1-2) `getLatestVisibleCursor`
> is a **filtered reverse chunked scan** (match-counted skeleton, limit=1), never a
> bare `ZREVRANGE 0 0` — standing rule distilled: every new visibility-index reader
> inherits the full dirty-query-set discipline (chunk / hydrate / filter chain /
> lazy null-ZREM). RED #23 (+d,e) and #24 (+opt-in) extended.
>
> **APPROVED**: Sol's final two-item re-scan of blob `dc2b2a45…` returned
> 0 P1 / 0 P2 (17:13 UTC) — **architecture gate OPEN**, TDD authorized per 8.10.

Sources verified first-hand (not trusted from summaries):
- Code: `RedisMessageStore.ts:96/138/183-187/556-638`, `MessageStore.ts:620-683`,
  `route-helpers.ts:251-253`, `DeliveryCursorStore.ts:103/170/232`,
  `checkFreshnessForPostMessage.ts:185-213`, Lua imports `RedisMessageStore.ts:29`.
- Maintainer's exact-HEAD review of #1210 `bf4fd8a9f` (fetched from GitHub, full text):
  path-1 P1 + the explicit blessing *"treat the typed/order cursor as separate
  architecture work"* — this branch IS that work.
- Main-thread prior art (`thread_mrkmxgdfqquounc9`): Verdict v3
  (msg `0001785141231078`) — allocator formula, far-future/retention couplings,
  RED matrix v3; Plans v4/v5.1 convergence; Sol's 001237 consumer-surface audit.

### 8.1 Factual correction — §1 conflates two codebases

§1 claims `getByThreadAfter` uses naive OR-union `id > afterId OR score > afterScore`.
**That is the #1210 BRANCH (kimi's path-1 narrowing restored `GET_BY_THREAD_AFTER_LUA`
with the naive union — maintainer's exact-HEAD P1 on `bf4fd8a9f` describes it), NOT
upstream/main.** This branch forks from main, where actual code
(post-#1193 `e3770ef21`, `RedisMessageStore.ts:578-586`) is:

```
(score == afterScore AND id > afterId)  →  same-score ID tiebreak
OR (score > afterScore)                 →  no ID filter
```

That is a **(score, id) composite order** — a total order over any *static* snapshot.
The direct C→Q→C store-level alternation in §1 does NOT reproduce on OUR baseline:
after Q, `zscore(Q)=300` exists, so the query walks the score branch and never returns
C. The lex-ID branch only runs when the cursor message has expired (`zscore === null`).
(The maintainer's C→Q→C repro is real — on #1210's HEAD. Keep it as an invariant
guard here, not as a RED driver; our RED reds are FM-1…FM-6 + far-future below.)

**The impossibility argument in §3 still stands** — it never depended on the OR-union.
It depends only on the external contract: cursor = raw message ID, caller advance =
lex string comparison. That contract is what breaks. The *real* failure modes on
current main are:

| # | Failure mode | Where | Effect |
|---|-------------|-------|--------|
| FM-1 | Caller lex-advance can't absorb late-delivered Q (`Q.id < cursor`) | `upsertMaxBoundary` (`boundaryId > current`), `DeliveryCursorStore` ×3 (`effective <= current`) | Cursor stuck → Q re-returned by every subsequent after-query → **repeated delivery/processing** |
| FM-2 | `ids.slice(0, limit)` runs BEFORE hydrate + `isDelivered` filter (`RedisMessageStore.ts:588-597`) | Redis after-path | limit slots eaten by undelivered queued msgs → **short/empty page while delivered messages exist beyond** → caller reads empty page as "caught up" → stuck until queue drains |
| FM-3 | Expired-cursor fallback filters by lex `id > afterId` (`:574-576`), a DIFFERENT relation than the (score,id) main path | Redis + Memory (`MessageStore.ts:638-647`) fallbacks | Re-returns already-read high-id/low-score msgs (duplicates); skips unread late-delivered low-id/high-score msgs (loss) |
| FM-4 | Memory forward-walks **insertion order**, never repositions on delivery (`MessageStore.ts:626-636`); Redis walks score order. Also: Memory counts limit AFTER isDelivered filter, Redis slices BEFORE | Memory vs Redis | Late-delivered invisible in Memory, visible in Redis; **different page sizes for identical data**. No shared test covers either |
| FM-5 | (score,id) order is **time-varying** — DELIVER_LUA re-scores | Redis | Any consumer holding score-domain state across a re-score sees a shifted order; orderKey (immutable, assigned once) removes the class |
| FM-6 | Cursor produced by caller (`batch[last].id`), not by store (`checkFreshnessForPostMessage.ts:213`) | all callers | Root enabler of FM-1/FM-3: callers manufacture cursors in the lex-ID domain the store no longer orders by |

| FM-7 | **Far-future timestamps (#1185 preserved domain) break score-order visibility on main TODAY** | Redis after-path + Memory | Message F appended with far-future ts → score = far-future. Every later normal message N (score=now < F.score) and late-delivered Q (score=deliveredAt=now < F.score) sorts BELOW F → `after(F)` returns neither → **permanent unseen loss**. This is a live bug on our baseline, not a #1210 artifact |

FM-2, FM-7, and the limit-semantics half of FM-4 were not in §1–§7; found during
gate review (FM-7 via main-thread Verdict v3 prior art, re-verified against this
worktree's `zremrangebyscore`/score lifecycle).

### 8.2 D1 — Structure: dedicated visibility index (amended from score-replacement)

Two candidate structures both carry the same visibility sequence; the choice is where
it lives:

- **(i) Replace thread-ZSET score with orderKey** (main-thread Verdict v3 shape) —
  zero new storage, but EVERY `MessageKeys.thread(` consumer must survive a score
  semantics flip (after/before/eviction/unread/read-state/duty-briefing/backfill/API
  history). Sol's 001237 audit shows this surface is far larger than assumed. One
  missed reader = silent corruption. Retention compatibility rests on keeping the
  sequence time-magnitude — a dimensional coincidence doing load-bearing work.
- **(ii) Dedicated per-thread visibility index** (Sol's 001237 shape, adopted):
  new ZSET `MessageKeys.threadVisibility(threadId)`, member = messageId,
  score = `visibilitySeq`. The thread ZSET keeps its raw-time semantics untouched.

**Ruling: (ii).** Not because storage is cheap (a member is tens of bytes vs KB-scale
message hashes — "doubles storage" was always a mirage), but because (ii) makes whole
failure classes *structurally impossible* instead of carefully-handled:

| Concern | Under (ii) |
|---|---|
| Thread-ZSET consumer audit (highest-risk step under (i)) | **Vanishes** — no semantics change |
| FM-2 (undelivered eats limit slots) | **Vanishes** — queued messages never enter the index until delivered |
| FM-3 (expired-cursor lex fallback) | **Vanishes** — cursor is a *position value*, not a member reference; `(seq, +inf)` works whether or not the anchor message still exists |
| before-path seam (8.5 under (i)) | **Vanishes** — before/history/frontend read the untouched thread ZSET |
| Retention semantics | Unchanged on thread ZSET; index gets its own cleanup (below) |
| Canceled queued messages | Never entered the index — no tombstone-filter burden for them |

**visibilitySeq allocator** (portable asset from Verdict v3, re-verified here —
eviction `zremrangebyscore '-inf', cutoff` at `RedisMessageStore.ts:183-187` confirms
the time-magnitude coupling):

```
visibilitySeq = max( meta.hwm + 1 , redisServerTimeMs )      → write back to meta.hwm
```

**The order's source of truth is a persistent per-thread metadata hash**
`MessageKeys.threadVisibilityMeta(threadId)` = `{ migrated: <version>, hwm: <seq> }`
(rev 5 — Sol merged-gate P1-1). Rev 4 read the high-water from the index itself
("the index IS the high-water"); that premise is BROKEN under TTL deployments:
message-hash TTL + thread-ZSET cutoff produce hydrate-null members, rev 4's own
lazy ZREM (or a fully expired index) then removes top-end members → indexMax
regresses below already-issued seqs (reachable when the `+1` branch has outrun
wall-clock), and `EXISTS visibility` as migration marker triggers a RE-backfill
that re-uses the seq space already exposed in old v2 cursors. Both are permanent
ordering corruption. Bindings:
- `meta` is written ONLY inside the allocating/backfill Lua (same linearization
  point); **never TTL'd, never EXPIRE'd**; removed only by `deleteByThread`.
- Allocator reads `HGET meta hwm` — never `ZREVRANGE index`. The index becomes a
  pure query set: members may be lazily ZREM'd or expire without touching order
  truth (position truth = meta.hwm + hash seq field + issued tokens).
- Migration guard = `HGET meta migrated` — never `EXISTS visibility`. An emptied
  index does NOT re-trigger backfill (RED #21).
- `+1` lower bound → strict monotonicity across cleanup + clock rollback (RED #20).
- `now` lower bound → debuggability + headroom only; correctness rests on
  `meta.hwm + 1` alone (rev 4's retention-magnitude rationale is obsolete — index
  cleanup is member-driven, 8.2 below).
- Fail-closed guards: allocator throws at `MAX_SAFE_INTEGER - margin` and on any
  non-finite/non-integer `meta.hwm` — never silently truncate. Far-future raw
  timestamps never enter the allocator (FM-7: visibility order is admission order,
  not payload time). Rank-normalize (below) guarantees `meta.hwm` starts as a small
  safe integer, so effective headroom is the full 2^53 domain.
- **Assignment points**: immediate append → seq + `ZADD visibility` at the append
  atomic point; queued append → NOT in the index; deliver → extend existing
  DELIVER_LUA (main has it, `RedisMessageStore.ts:29`) with seq + `ZADD` (re-ZADD on
  a backfilled legacy member simply moves it — correct); cancel → extend CANCEL_LUA
  with `ZREM visibility` (legacy backfilled queued cleanup).
- **Never reallocated after assignment** (immutable → kills FM-5). REASSIGN does not
  touch the index (position is visibility history, not ownership).
- **Memory parity**: per-thread ordered array `{seq, id}` + maxSeq; `markDelivered`
  appends an entry (this makes late-delivered messages VISIBLE in Memory forward
  pagination for the first time — the FM-4 fix); same allocator formula with
  `Date.now()`.

**Legacy population — one-shot atomic RANK-NORMALIZE backfill, no migration window**
(rev 4 — Sol P1-1: plain `ZUNIONSTORE` copying is void. Historical scores may be
fractional / `+inf` / `-inf` — a PROTECTED contract, `redis-message-store.test.js:571-624`
writes them directly and asserts pagination. Fractional can't be `pad16`-encoded;
a fractional/`+inf` max poisons `max(max+1, now)`; fail-closing on `±inf` would make
existing readable data unpageable — worse than the disease):

First index write on a thread with `meta.migrated` unset and a non-empty thread ZSET
runs, inside one Lua: `HGET meta migrated` guard → `ZRANGE thread 0 -1` (rank order
≡ the legacy `(score, id)` order, with `±inf` correctly at the extremes) → loop
`ZADD visibility (BASE + i) member`, BASE = 1 → `HSET meta migrated 1, hwm BASE+N-1`
atomically at the end. **Bounded** (rev 5 — Sol P2): if the thread ZSET holds more
than `MAX_BACKFILL_MEMBERS = 50_000` members, the Lua ABORTS with a distinct error
(fail-visible, logged with member count — an ops-path event, not a silent stall);
single-Lua atomicity is non-negotiable (a ZSCAN-chunked backfill was considered and
rejected: it opens concurrent-append seq races and half-migrated crash states —
exactly the window class 8.6 exists to kill). Log duration + member count on every
backfill. Properties:
- Every legacy member gets a UNIQUE SAFE INTEGER seq — the `seq16` wire domain is
  closed over ALL data, `cursorFor` v2 issuance holds for every backfilled member,
  and the allocator only ever reads normalized/allocated integers (`±inf` can never
  reach it).
- Legacy relative order preserved EXACTLY (rank is the order we must keep).
- Legacy equal-score buckets VANISH (unique seqs) — the equal-seq branch of 8.3/8.4
  becomes purely defensive, empty in both regions.
- The far-future-ceiling characteristic from rev 2/3 is GONE: a legacy `8.64e15`
  (or `+inf`) score normalizes to a small rank integer; new allocations start at
  `max(meta.hwm+1, now) = now`, strictly above, with the full 2^53 headroom intact.
- Cost: O(N) loop in one atomic Lua, once per thread (~tens of ms for 10k-message
  threads — accepted; ZUNIONSTORE was O(N) too).
- Backfilled undelivered/canceled members are inert (post-hydrate `isDelivered`
  filter guards them; deliver/cancel Lua re-ZADDs/ZREMs them into correctness).

**Read-side migration guard — `ensureVisibilityMigrated(threadId)`** (rev 6 — Sol
final-scan P1-1): binding backfill to "first index WRITE" leaves read-only legacy
threads permanently empty — after deployment, a thread that never receives another
append/deliver has no index, `getByThreadAfter` returns `[]`, and the 8.4 resolve
chain (HGET miss → ZSCORE on an EMPTY index → miss) misclassifies live v1 cursors
as fully-pruned. Therefore EVERY visibility read/resolve entry point —
`getByThreadAfter`, `getLatestVisibleCursor`, v1 lazy resolve — first calls
`ensureVisibilityMigrated(threadId)`: `HGET meta migrated` → set → no-op (one cheap
read on the hot path); unset + non-empty thread ZSET → run the bounded backfill Lua
(idempotent, once per thread ever). Yes, this makes reads able to trigger a
one-time write — the standard lazy-migration shape; it is bounded, atomic, and
recorded. Eager whole-deployment migration was considered and rejected: it cannot
cover restore-from-backup timelines and adds an ops step; the read guard is a
permanent invariant instead. (RED #26.)

**Consequence — index cleanup must be MEMBER-DRIVEN, never score-cutoff** (rev 4):
normalized legacy seqs are small integers; any time-magnitude
`ZREMRANGEBYSCORE visibility '-inf', cutoff` would wipe live legacy members. The
index therefore has NO score-based retention. Cleanup surfaces: `deleteByThread`
double-DEL; CANCEL_LUA ZREM; hydrate-null members (hash TTL-expired or evicted via
the thread ZSET's own `:183-187` path) are skipped by the existing filter chain and
may be lazily ZREM'd on read. Side effect: the allocator's `now` lower bound is no
longer load-bearing for retention compatibility — it stays for debuggability and
headroom, correctness rests on `meta.hwm + 1` alone (rev 6 sweep: every
allocator-truth mention in this doc now reads meta, never the index — P1-5).

**Index + meta hygiene invariants** (write into code comments + tests):
1. softDelete = tombstone, no ZREM anywhere (cursor path keeps tombstones, ADR-008 D3).
2. deleteByThread → `DEL` both ZSETs AND the meta hash (the only meta removal path).
3. **NO score-cutoff cleanup on the visibility index — member-driven only** (rev 4):
   cancel-ZREM, deleteByThread-DEL, and lazy ZREM of hydrate-null members on read.
   Null-tolerance in the cursor path is mandatory — test it. Lazy ZREM is SAFE
   precisely because order truth lives in meta, not in members (rev 5).
4. **High-water invariant lives on `meta.hwm`, not on index members** (rev 5,
   supersedes rev 4's member-based wording): `meta.hwm` is monotonically
   non-decreasing for the lifetime of the thread — no TTL, no EXPIRE, no cleanup
   path touches it; index members may come and go freely (OQ7, RED #20/#21).

### 8.3 D2 — Cursor wire format: canonical (seq, id) pair, zero-padded

**`v2:<seq16>:<messageId>`** where `seq16` = 16-digit zero-padded decimal
(`MAX_SAFE_INTEGER` = 9007199254740991 is exactly 16 digits). Externally opaque
by contract.

- **The canonical position is the PAIR (seq, id)** — messageId is a first-class
  tiebreak component, NOT a debug field (rev 3 / Sol P1-A). Comparison:
  numeric on seq, then lex on id. Under rev 4's rank-normalize backfill, seqs are
  unique in BOTH regions — the equal-seq branch is retained as pure defense (and as
  the CAS-order argument's tiebreak), expected empty everywhere. **One relation, one
  query algorithm, no region boundary to persist or detect** (Sol's tightening #1).
- **Zero-padding makes token lex order ≡ (seq, id) order — for CANONICAL v2 values.**
  Existing string-slot CAS comparators (e.g. `SessionStore.SET_IF_GREATER_LUA`, lex
  string compare) remain correct WITHOUT script changes:
  `v2:0000000000000010:… > v2:0000000000000009:…` under lex, matching numeric.
  Unpadded seqs would invert this (`v2:10 < v2:9` lex) — opus's finding, adopted.
  `'v'` (0x76) > any digit → every v2 token lex-exceeds every v1 raw ID → the
  one-time v1→v2 upgrade always advances and stored-v2-vs-incoming-v1 regression is
  rejected. (RED #17.)
  **Canonicalize-before-write is therefore a HARD ingress rule** (rev 6 — Sol
  final-scan P1-3): the lex argument says nothing about v1↔v1 (original disease) and
  "reject incoming v1" is only correct when the v1 has first been RESOLVED — a raw
  late-delivered ID lex-below the stored token may denote a NEWER position and must
  win after canonicalization, not be dropped. Every CAS ingress (internal callers,
  `PATCH /read`, mention acks) resolves→pair→v2 BEFORE the script; raw v1 never
  reaches `SET_IF_GREATER`.
- **Strict parser** (`parseCursor`, one shared helper, both stores): rejects
  non-16-digit seq, non-canonical padding, out-of-range values, malformed tokens —
  fail-closed, never "best effort" (Sol's tightening #3).
- Not base64: debuggability is worth more; opacity is a contract statement.
  Maintainer's ban is on decoding the *message-ID prefix* for ordering — we never
  do (the prefix is a process-local logical value; decoding it is semantically
  wrong, not just coupled). The store parses only its own v2 token.
- **Discrimination:** v1 = raw message ID (starts with a digit); v2 = `v2:` prefix.
  Namespaces cannot collide.
- The token survives pruning of its anchor message: (seq, id) is a position value;
  the exclusive successor query needs no member lookup.

### 8.4 D3 — v1 migration: lazy upgrade on read, permanent; unified relation

On receiving a v1 cursor (raw message ID), resolve to a **pair**:
1. `HGET message:<id> visibilitySeq` → present → `(seq, id)`. (New messages; field
   written by the allocating Lua.)
2. Absent → `ZSCORE visibility <id>` → present → `(score, id)` — backfilled legacy
   members carry their rank-normalized integer seq (8.2), exact by construction.
   Not ID-prefix decoding — an index lookup.
3. Fully pruned → `(0, "")` (scan from start); callers' idempotent ack (already
   required, pinned by RED #2) absorbs re-reads.

**Successor query (both stores, all regions):**
```
(score == seq AND id > cursorId)  OR  (score > seq)
```
— structurally the same shape #1193 already proved on main, now over an
IMMUTABLE score domain. Redis: `ZRANGEBYSCORE [seq,seq]` + id filter, then
`ZRANGEBYSCORE (seq,+inf`, chunked. Memory: pair comparison on the mirror array.

No backfill *job*, no migration window (a window is a time bomb). The resolve path
is one small function and stays forever.

### 8.5 D4 — getByThreadBefore: UNTOUCHED

Under structure (ii) the before-path needs **zero changes**: it reads the thread ZSET,
whose semantics never change. F232's effectiveTs parity work stands as-is. The §8.5
seam fix from rev 1 of this verdict is void.

Boundary note (record, don't fix): before/history order (effectiveTs domain) and
after/visibility order (seq domain) can micro-diverge within a same-ms burst. They
already micro-diverge today (effectiveTs vs (score,id)); frontends already dedupe by
id when stitching. Macro order agrees (both domains are anchored at the delivery
moment). Not a regression; write it into the PR description.

### 8.6 D5 — #1210 boundary: fully independent, zero shared code

- Maintainer's exact-HEAD review of `bf4fd8a9f` (P1) instructs #1210 to either find a
  lex-compatible relation or **"keep only the independent atomicity/idempotency/TTL
  fixes … and treat the typed/order cursor as separate architecture work."** This
  branch is that separate work, explicitly blessed. #1210 is still mid-iteration
  (its restored naive OR-union Lua is exactly what P1 rejects) — one more reason
  nothing here may depend on its timeline.
- Main (our base) has DELIVER/CANCEL/REASSIGN Lua but **no APPEND Lua** — append is a
  MULTI pipeline (`RedisMessageStore.ts:96/138`). Our append-side seq allocation must
  share ONE atomic visibility point with message insertion ("allocation order =
  visibility order" — the main-thread P1-1 lesson: any window where a smaller seq
  commits after a larger one has been paged past is a permanent-loss gate).
- **Shape (a) is the ONLY acceptable shape** (rev 3 — Sol P1-B): the immediate-append
  path becomes one Lua carrying message hash write, idempotency claim, thread/timeline/
  user/mention ZADDs, seq allocation, and visibility ZADD — one linearization point.
  (The trailing retention-eviction commands at `:183-187` may stay as a follow-up
  pipeline segment; only the visibility-affecting writes must be inside the Lua.)
  **Shape (b) — MULTI followed by a separate ALLOC_VISIBILITY Lua — is DELETED and
  forbidden.** Rev 2 claimed its crash window "is healed by caller retry"; that was
  wrong twice over: (1) the retry hits the idempotency fast path and returns the
  stored message BEFORE ever reaching allocation — the heal never runs; (2) the
  one-shot `EXISTS` backfill guard cannot detect a single missing member in a
  non-empty index. Result: a message permanently invisible to after/unseen. A
  durable missing-member repair job would fix it at the cost of a whole new
  subsystem — deleting the window is strictly simpler and safer.
- Sol's "write only RED/spec until #1210's APPEND_LUA merges" remains declined as a
  hard gate: we still copy nothing and wait on nothing. Shape (a) does enlarge the
  rebase overlap with #1210's APPEND_LUA (both Lua-ize the append body) —
  acknowledged and accepted: a mechanical, reviewable code conflict is the price;
  a data-visibility hole (shape (b)) is not a price anyone gets to pay. Whichever
  PR lands second merges the two scripts' disjoint concerns (idempotency/TTL vs
  seq/visibility) into the single append Lua.

### 8.7 D6 — Consumer inventory: ALL cursor consumers in THIS PR

Half-migration is precisely what the maintainer rejected in #1210. Migrate every
consumer's *comparison domain*; the PR description must list every row below with its
disposition — explicit, or it didn't happen. (Sol's 001237 surface, merged with my
grep of `getByThreadAfter`/cursor callers.)

**Cursor issuance moves to the store side — and must close for legacy messages**
(rev 3 — Sol P1-C):
- `getByThreadAfter` queries the visibility index **`WITHSCORES`** and injects each
  member's score into the returned object as `StoredMessage.visibilitySeq` (runtime
  field, NOT written back to legacy hashes). Every message coming off the after-path
  — new or backfilled-legacy — therefore carries its position synchronously, and
  `cursorFor(msg) = v2:<pad16(seq)>:<id>` always works there. One `WITHSCORES` flag,
  no extra round-trips.
  **Binding is BY ID, never by array position** (rev 4 — Sol P2-1): `hydrateMessages`
  compacts away missing/soft-deleted entries (`RedisMessageStore.ts:978-986`), so a
  positional zip of `[id, score]` pairs against the compacted result misassigns
  scores to the wrong messages → wrong cursors → skips/repeats. Build
  `Map<id, score>` from the WITHSCORES reply, inject via `msg.id` lookup. RED #11
  pins the compaction case.
- **Graded issuance rule** for messages obtained from non-after surfaces (before/
  history/getByThread), where no visibility score is attached: `cursorFor` degrades
  to issuing the v1 raw ID. This is legal by construction — every comparison point
  goes through `parseCursor` + lazy resolve (8.4), so the system is closed over
  mixed tokens; issuance format may be mixed, the COMPARISON domain never is.
  This explicitly covers the **idempotency-replay of a pre-migration (legacy-live)
  message**: the replayed object has no hash seq → v1 issuance → resolve via
  `ZSCORE` is exact (RED #19).
  (Store-owned async issuance API was considered and rejected: it pushes async into
  every issuance callsite for a case the resolve path already handles.)
- Callers stop manufacturing cursors from `msg.id` themselves (kills FM-6). No
  return-type surgery on `getByThreadAfter`.

| Consumer | Disposition |
|---|---|
| `route-helpers.upsertMaxBoundary` (`:253` lex `>`) | MIGRATE → pair compare via `parseCursor` |
| `DeliveryCursorStore` delivery/seen/mention acks (`:103/:170/:232` lex `<=`) | MIGRATE → pair compare |
| `checkFreshnessForPostMessage` (`:185` init, `:213` batch-tail) | MIGRATE → resolve init; `cursorFor` on tail (WITHSCORES-fed) |
| `AgentRouter` boundary plumbing | MIGRATE (token pass-through) |
| `RedisThreadReadStateStore` (persists raw-ID cursor + calls `getByThreadAfter`) | MIGRATE — cursor slot accepts v1+v2, compare via resolve (opus-verified) |
| `ThreadUnseenChecker` (`:78` `maxMessageId = nonSelf[last].id`) | MIGRATE — cross-domain compare goes resolve→pair; issuance follows graded rule |
| `FreshnessNoticeService` (`:189` `maxMessageId` vs `seenCursor`) | MIGRATE — directly broken otherwise (opus-verified) |
| `createFreshnessReinvokeCheck` (`:115-119`, comment explicitly assumes lex-safe) | MIGRATE — comparison via resolve; DELETE the stale comment |
| `FreshnessAttentionEventLog` (persists `maxMessageId`) | SCHEMA-EVOLVE: new events store BOTH `maxCursor` (v2) and `maxMessageId`; old events go through a compat resolver, unresolvable → conservatively unresolved. Do NOT push pruned-semantics onto every comparison point (Sol tightening #4) |
| `SessionStore.SET_IF_GREATER_LUA` (lex string CAS) | VERIFIED-COMPATIBLE via 16-digit zero-padding (8.3); RED #17 pins it — no script change |
| **mention pending-window query** (`getMentionsFor:390-402`, per-cat mentions ZSET + raw-ID cursor; real caller requests limit=20, `callbacks.ts:1969-1971`) | **MIGRATE — successor selection moves to the visibility relation, MATCH-COUNTED** (rev 5 P1-2 + rev 6 final-scan P1-2). Rev 5's "page then post-filter" would resurrect FM-2 in mention form: 20 non-mentions eat the underlying page window → 21st-position mention permanently invisible, empty page with nothing ackable to advance. The scan must chunk INSIDE the visibility relation until it has collected `limit` **mention matches** (`msg.mentions.includes(catId)`, mentions already in the hash — zero new structures) or exhausted the thread — the same filter-then-count discipline `getByThreadAfter` itself uses (implement as a predicate variant sharing the chunk loop). Ack cursor is per-cat-per-thread (`DeliveryCursorStore:112-117`). The per-cat mentions ZSET remains a time-domain display/backfill surface with no cursor-advance semantics; any global+afterMessageId call sites decompose per-thread (AUDIT → disposition in doc). RED #22 incl. starvation case |
| mention ack comparisons (`callbacks.ts:1963` + 2 more) | MIGRATE — compare via resolve (pair domain), ack stores v2 token |
| `getByThreadIncludingQueued` (Memory `:600`) | AUDIT: display/briefing surface, insertion-order, no cursor advance — record why unaffected |
| `collectDutyBriefingInput`, `event-backfill` | AUDIT: full-read / time-window consumers stay untouched — record why |
| API history endpoints (`index.ts` after/before) | after: accepts v1+v2, returns v2 via `cursorFor`; before: untouched (8.5) |
| Frontend `useChatHistory` (`:1619` self-built `timestamp:id` cursor; `:655` effectiveTs sort) | UNTOUCHED under (ii) — both live in the before/history time domain, which never changes; verify + record (opus-verified line refs) |
| **public read-state: `/read/mark-all` + `/read/latest`** (`routes/threads.ts:1053-1058`, `:1134-1141` — both take `getByThread()` time-domain tail) | **MIGRATE** (rev 5, Sol merged P1-3: time-latest ≠ visibility-latest once late delivery exists — mark-all anchored at C leaves Q permanently "unseen"). Store exposes `getLatestVisibleCursor(threadId)` returning **`{cursor, messageId} \| null`**: guard-migrated, then **reverse chunked scan** — `ZREVRANGE` chunks WITHSCORES from the top, hydrate, lazy-ZREM nulls, and return the FIRST member passing the SAME visibility filter chain as the after-path (tombstone-keep / null-skip / canceled-skip / isDelivered); none live → null (rev 7 — Sol rev-6 P1-2: a bare `ZREVRANGE 0 0` returns TTL-evicted or backfilled-undelivered/canceled top members — a `messageId` that doesn't exist or isn't visible, breaking the "latest real message" contract and skipping the live member below). Effectively the match-counted scan skeleton with limit=1 reversed. The route acks `cursor` and keeps the wire contract: `messageId` field carries a raw ID, token never leaks into it, new `cursor` field added (rev 6 P1-3). **Standing rule distilled from this + the mention row: every NEW visibility-index reader inherits the full dirty-query-set discipline — chunk, hydrate, filter chain, lazy null-ZREM — no bare rank/top reads, ever.** RED #23 incl. response-contract + stale-top cases |
| **manual read ingress: `PATCH /api/threads/:id/read`** (`threads.ts:1088-1104` passes external raw `upToMessageId` straight into `readStateStore.ack`) + mention ack ingress (`callbacks.ts:2071-2097`) | **MIGRATE — canonicalize-before-write** (rev 6 final-scan P1-3): ALL CAS ingress resolves the incoming value to a pair and canonicalizes to v2 BEFORE the CAS script runs. Raw v1 must never enter `SET_IF_GREATER` at all: v1↔v1 lex compare is the original disease, and a stored v2 vs incoming v1 comparison would wrongly REJECT acks whose late-delivered position is newer than their lex ID suggests. RED #23 manual-PATCH case |
| **Cursor TTL — delivery/mention/seen CAS** (`shared/src/utils/redis.ts:65-70` LUA hardcodes `EX`; `:109/:135/:167` default `604800`) | **MIGRATE — Iron Law 5, INCLUDING pre-existing keys, WITHOUT erasing opt-in** (rev 5 P1-4 + rev 6 P1-4 + rev 7 — Sol rev-6 P1-1: an unconditional read-path PERSIST would wipe explicit opt-in TTLs on first GET — the two rev-6 sentences were mutually exclusive). Bindings: (1) **the write path IS the policy discriminator**: the TTL=0 LUA branch calls `PERSIST KEYS[1]` BEFORE the compare (so every ack attempt — advancing or no-op — de-TTLs a default-policy key), while the ttl>0 branch keeps `EX` and never PERSISTs — an explicit opt-in key survives reads AND no-ops with its TTL intact; (2) **read paths do NOT touch TTL** (rev 6's read-PERSIST is deleted as both unsafe and redundant — any active cursor has ack attempts, which hit the LUA); (3) truly dormant legacy keys are covered by a one-shot idempotent ops script (`SCAN` cursor namespaces + `PERSIST`) executed AT CUTOVER, before any future opt-in writes exist; (4) per-key policy is owned by its calling site — mixing default and opt-in calls on one key is a caller bug; (5) recorded constraint: today NO cursor opt-in call sites exist (the parameter is a reserved capability) — if one is ever introduced, it MUST ship with a policy marker and MUST NOT deploy before the migration sweep. RED #24: (a) seed key with legacy ttl → no-op advance via default path → `TTL === -1`; (b) explicit opt-in key (`ttl>0`) → read + no-op → TTL still positive |

### 8.8 RED test matrix (final — merges my FM set, Verdict v3's matrix, maintainer's P1)

All store-level tests run through a **shared dual-store harness** (same scenario
against Memory AND Redis, asserting identical pages incl. sizes — the harness IS the
FM-4 parity contract Sol demanded). RED = red on our main baseline unless noted.

1. **FM-1 exactly-once**: C direct → Q late-delivered → delivery-cursor consumer;
   Q processed exactly once (today: re-surfaced forever, cursor can't absorb it).
2. **Idempotent re-read absorb**: cursor at position 0 re-scan does not double-apply
   (pins 8.4 step 3).
3. **FM-2 limit**: `limit` queued messages then 1 delivered → `after(…, limit)`
   returns the delivered one (today Redis: `[]`; structurally green under (ii) —
   keep as invariant).
4. **FM-3 pruned anchor**: evict/prune the cursor message → next page = exact
   remainder, no duplicates, no losses (today: lex fallback both duplicates and loses).
5. **FM-4 parity sweep**: interleaved direct/queued/late-delivered, small limits,
   both stores page-identical (today: Memory hides late-delivered; limit semantics
   differ).
6. **FM-7 far-future immediate**: F(far-future ts) append → N append → `after(F)`
   returns N (today: permanent loss, both stores for different reasons).
7. **FM-7 far-future queued**: cursor=F, Q late-delivers → `after(F)` returns Q
   (today: loss).
8. **Maintainer P1 invariant**: C→Q→C sequence → successor relation is a total
   order; two-page progress, no repetition, terminates (invariant guard — partially
   green on main, red on any naive-union regression).
9. **Legacy-mixed**: backfilled thread → legacy order preserved exactly; all new
   messages strictly above; v1 cursors from the legacy region resolve exactly (8.4#2).
10. **Clock rollback**: mock `now < meta.hwm` → allocation stays strictly
    increasing (`meta.hwm+1` branch).
11. **Cleanup + WITHSCORES integrity**: member-driven cleanup only (no score cutoff);
    hydrate-null member skipped (and lazily ZREM'd); late-delivered survivor readable;
    **OQ7**: delete/tombstone highest-seq message → next allocation still higher
    (invariant 4 of 8.2). **Compaction case** (Sol P2-1): missing/soft-deleted A +
    live B in one page → `B.visibilitySeq === scoreB` exactly (Map-by-id binding),
    `cursorFor(B)` resolves to B's true position — never A's.
12. **Token stability**: same v2 token resolves to the same position twice, incl.
    after REASSIGN (kills FM-5 by construction).
13. **Cancel hygiene**: queued-canceled never enters index; backfilled-legacy
    canceled is ZREM'd by CANCEL_LUA / filtered until then.
14. **Legacy equal-score paging** (rev 3, Sol P1-A): backfill L1=(s,"a"), L2=(s,"b")
    same-ms; cursor=L1 → next page contains L2 (rev 2 design: lost; pair relation
    fixes it). Both stores.
15. **Append atomicity** (rev 3, Sol P1-B; NARROWED rev 4, Sol P1-2): every
    **immediately-visible** message returned by append — including the
    idempotency-fast-path replay of a visible message — carries `visibilitySeq` and
    is present in the index; no observable state has visible-hash-without-index.
    Queued messages are explicitly OUT of this assertion (see #19). (Structurally
    green under shape (a); guards against regression to any two-step shape.)
16. **Legacy issuance closure** (rev 3, Sol P1-C): a backfilled-legacy message from
    the after-path yields a v2 `cursorFor` token resolving to its exact position;
    the same message from a non-after surface yields a v1 token that resolves
    identically. No issuance path throws or fabricates.
17. **Padded-token CAS order**: `SET_IF_GREATER` semantics hold across
    v2(seq=10) > v2(seq=9) > any v1 raw ID; malformed / non-canonical padding
    rejected by parser (fail-closed).
18. **Non-integer legacy scores** (rev 4, Sol P1-1): threads containing fractional
    (`ts+0.5`), `+inf`, and `-inf` legacy scores (per the protected contract in
    `redis-message-store.test.js:571-624`) backfill via rank-normalize → all members
    pageable in exact legacy order, every member issues a valid v2 token, subsequent
    allocations are safe integers strictly above — for each of the three cases.
19. **Queued lifecycle** (rev 4, Sol P1-2): queued original append AND its idempotent
    replay both have NO seq and NO index member; first delivery allocates exactly
    once (atomic); repeated delivery does NOT reallocate; idempotency-replay of a
    legacy-live visible message (no hash seq) → `cursorFor` degrades to v1 and
    resolves exactly via ZSCORE (8.7 graded rule).
20. **Meta survives everything** (rev 5, Sol P1-1): COMBINED scenario — delete/expire
    the highest AND last index members (lazy-ZREM them), mock clock rollback
    (`now < hwm`), then allocate with a persisted old v2 cursor in hand → new seq
    still strictly > both `meta.hwm`-before and the old cursor; no regression.
21. **Emptied index ≠ unmigrated** (rev 5, Sol P1-1): fully expire/clear the
    visibility ZSET → `meta.migrated` still set → NO re-backfill, NO seq-space
    reuse; allocation continues from `meta.hwm`.
22. **Late mention exactly-once + no starvation** (rev 5 P1-2; rev 6 starvation
    case): (a) mention C (direct) + mention Q (queued, `Q.id < C.id`) → ack C →
    deliver Q → next mention page contains Q exactly once (today: ZRANK path skips
    it forever). (b) ack C → ≥20 consecutive NON-mention messages → then mention Q →
    `getMentionsFor(limit=20)` returns Q (match-counted scan; a page-then-filter
    implementation returns `[]` forever).
23. **Read-state at visibility high-water + contracts** (rev 5 P1-3; rev 6 cases;
    rev 7 stale-top cases): (a) C direct → Q late-delivered → `/read/mark-all` and
    `/read/latest` anchor at Q's visibility position, not C's time-tail; unseen
    count is 0 afterward. (b) `/read/latest` response keeps `messageId` = a raw
    message ID (never a token), plus the new `cursor` field. (c) manual
    `PATCH /read` with a raw late-delivered `upToMessageId` lex-below the stored
    cursor → resolved, canonicalized, and ADVANCES (raw-pass-through wrongly
    rejects). (d) top index member hydrate-null (TTL'd hash) with live B below →
    returns B's raw messageId + B's cursor, null member lazily ZREM'd. (e) top =
    backfilled undelivered/canceled legacy member → skipped, first VISIBLE member
    returned; thread with no visible members → null / "no messages".
24. **Cursor persistence incl. pre-existing keys, opt-in preserved** (rev 5 P1-4;
    rev 6 hardening; rev 7 policy split): (a) seed key with legacy TTL → no-op
    advancement via DEFAULT path (`ttl=0`) → `TTL === -1`; (b) explicit opt-in key
    (`ttl>0`) → read AND no-op advancement → TTL remains positive (never wiped);
    (c) new default writes carry no TTL; reads never modify TTL on any key.
25. **Backfill bound** (rev 5, Sol P2): a thread over `MAX_BACKFILL_MEMBERS` →
    backfill Lua aborts with the distinct error, no partial index, no meta.migrated;
    at the bound → succeeds atomically.
26. **Read-only legacy thread migrates on read** (rev 6, Sol P1-1): legacy-only
    thread, ZERO writes after deployment → first `getByThreadAfter` /
    `getLatestVisibleCursor` / v1 resolve each trigger the one-time backfill and
    return full correct pages; a live v1 cursor into that thread resolves exactly
    (not misclassified as pruned). Both stores via the harness's legacy-seeding
    shim.

### 8.9 Sol's open questions — disposition (updated for structure (ii))

| # | Question | Answer |
|---|----------|--------|
| 1 | Public cursor versioned? | Yes — `v2:` prefix; v1 raw IDs accepted forever via lazy resolve (8.4) |
| 2 | Order source of truth | **Persistent per-thread `meta` hash (`migrated` + `hwm`)**, written only inside the visibility-write Lua (rev 5 — supersedes rev 4's "the index IS the high-water": that held only while members never left the top end, which TTL deployments + lazy ZREM break; P4 yields to durability facts). The index is a query set; meta is the order authority |
| 3 | Legacy migration | One-shot atomic rank-normalize backfill per thread (guarded): every legacy member — including fractional/±inf scores — gets a unique safe-integer seq preserving exact legacy order (8.2); read-side lazy resolve on top (8.4) |
| 4 | before/after shared relation? | No, by design: after = visibility seq (new index); before/history/display = effectiveTs on the untouched thread ZSET. Micro-divergence in same-ms bursts is pre-existing and dedupe-absorbed (8.5) |
| 5 | Concurrent deliver + paginate | Delivery allocates seq strictly above every already-paged position, atomically inside DELIVER_LUA; immutable thereafter → no retro-shift (RED #12); allocation order = visibility order enforced at one Lua point (8.6) |
| 6 | No-limit/backfill contract | Unchanged: no limit → all matches. limit counts messages that pass the visibility filter chain (structurally natural under (ii); RED #3 pins it) |
| 7 | TTL/hard-delete vs high-water | **`meta.hwm` is the high-water** (rev 6 — index members are a query set and may expire/ZREM freely); no score-based eviction on the index (member-driven only, rev 4), deletes are tombstones, meta is never TTL'd — invariant 4 + RED #11/#20/#21 |

### 8.10 Implementation order — **GATE OPEN (rev 7 approved by Sol, 17:13 UTC)**

Binding sequence:

1. Dual-store harness scaffolding (8.8 preamble) — infrastructure first.
2. RED: matrix 1–8 + 14 (expect reds per annotations; an expected-red test that
   comes up green means the scenario is mis-built — stop and fix the test).
3. Visibility index write paths: **meta hash first** (allocator truth, 8.2), append
   Lua **shape (a) ONLY** (8.6), DELIVER_LUA + CANCEL_LUA extensions,
   **bounded rank-normalize backfill Lua** (8.2, sets meta atomically), Memory
   mirror, `visibilitySeq` hash field.
4. `getByThreadAfter` rewrite: **`ensureVisibilityMigrated` first** (8.2, rev 6) →
   resolve cursor to pair (8.4) → equal-seq segment + strict segment (8.4 relation),
   chunked, **WITHSCORES → `Map<id,score>` → inject `visibilitySeq` by `msg.id`**
   (never positional zip — 8.7/P2-1) → hydrate → filter (tombstone-keep / null-skip
   / canceled-skip / isDelivered) → limit AFTER filter. Memory equivalent on the
   mirror. Mention variant shares the chunk loop with a match-counted predicate
   (8.7, rev 6).
5. v2 token: strict `parseCursor` / `cursorFor` graded issuance / lazy resolve (pair).
6. Consumer migration per 8.7 table — now including mention pending-window
   (match-counted), read-state routes ({cursor, messageId} contract), CAS-ingress
   canonicalization (PATCH /read, mention acks), and the cursor-TTL flip incl.
   PERSIST-before-compare + ops sweep; fill every AUDIT row's disposition into
   this doc.
7. Member-driven cleanup + hygiene invariants (8.2 list) + RED 9–26.
8. GREEN → focused + public gates → PR description gets: consumer table, 8.5 boundary
   note, #1210 independence statement → @sol exact-SHA review.

Do not reorder 3→4: the write path must exist before the read path flips, and the
backfill guard makes the flip per-thread atomic (no global cutover moment).

---
*Verdict rev 7 signed: [宪宪/Fable🐾] — architecture gate for issue #1200,
branch `fix/1200-cursor-order`.*
*Rev 5 (write-triggered-only backfill, page-then-filter mentions, raw CAS ingress,
new-writes-only TTL fix, indexMax residue) superseded by Sol's rev-5 final scan.
Rev 6 (unconditional read-PERSIST, bare-top getLatestVisibleCursor) superseded by
Sol's rev-6 re-scan: write-path branch as TTL policy discriminator; filtered
reverse scan for latest-visible; dirty-query-set discipline made a standing rule
for all future index readers.*
*Rev 1 (SETNX allocator, thread-ZSET score replacement) superseded by FM-7 +
retention coupling + consumer-surface evidence. Rev 2 (numeric-only cursor,
shape (b), sync-only issuance) superseded by Sol's three confirmed P1s. Rev 3
(ZUNIONSTORE verbatim backfill, score-cutoff index retention, over-broad RED #15,
positional WITHSCORES) superseded by Sol's rev-3 narrow scan. Rev 4 (index-as-
high-water, EXISTS migration guard, time-domain mention successor, unmigrated
read-state, 7-day cursor TTL, unbounded backfill) superseded by Sol's merged gate:
persistent meta hash is the order authority; mention/read-state consumers migrate
to the visibility relation; cursors persist by default. Prior art: main-thread
Verdict v3, Sol 001237, Sol 16:25/16:30/16:42/16:52 reviews, opus consumer
verification + fix proposals (16:42).*
