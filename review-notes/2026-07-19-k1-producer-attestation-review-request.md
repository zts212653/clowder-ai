# Review Request: K-1 producer sortable-safe Date admission

Review-Target-ID: `fix-k1-producer-attestation`
Branch: `fix/k1-producer-attestation`
Pre-fix review SHA: `05ad80c6f789477bf313b76210dc6657e0edc577`
Primary tracking issue: [#1200](https://github.com/zts212653/clowder-ai/issues/1200)

## What

- Add one shared `assertValidStoredMessageTimestamp()` admission rule to the memory and Redis message stores.
- Run that rule before ID generation, idempotency work, store/index mutation, Redis commands, or append listeners.
- Preserve fractional historical evidence through both Redis hydration paths; hydration is not new-write admission.
- Preserve present-but-blank historical timestamp evidence as invalid instead of coercing it to epoch zero.
- Preserve exclusive global/thread before-cursor pagination for fractional and infinity historical evidence, including bounded multi-page consumer progress across Redis score canonicalization.
- Apply the same non-negative integral TimeClip admission to `markDelivered()` before delivery state, message hashes, or effective-order indexes can change.
- Separate record creation input from stored output: append may initialize only legacy-immediate or queued state, while a shared type/runtime guard rejects transition-owned `deliveredAt`, `delivered`, and `canceled` before side effects.
- Model the store-side effective-order value `deliveredAt ?? timestamp`, including append and delivery writers, hash/ZSET persistence, both hydration paths, sequential reassignment forwarding, and every before-cursor consumer.
- Cover the non-negative integral Date domain, chronological IDs, delivery-cursor monotonicity, expired-cursor recovery, and zero-side-effect rejection in paired memory/Redis tests.

## Why

K-1 projects `StoredMessage.timestamp` through `Date#toISOString()`, but both stores previously accepted numbers that make that projection throw. Redis history order is later materialized from `deliveredAt` when a queued message is delivered, so future-write safety must cover both producers rather than only append-time `timestamp`. #1200 tracks this implementation. Separately, #1165 records that M7 stays RESERVED until valid-Date admission and stored-data attestation/migration exist; it is provenance, not implementation authorization. This slice closes only the future-write admission half and deliberately leaves historical compatibility and public identifier bounds unresolved.

## Original Requirements

> “M7 marks `occurredAt` CLOSED ... [but] does not prove that every source timestamp is a valid ECMAScript Date.”
> “Required correction: either ... mark M7 RESERVED pending a K-1 valid-Date admission plus stored-data attestation/migration invariant, or ... provide that source invariant now.”
> New-write admission must not be represented as proof for historical stored data.

- Accepted bug intake: `https://github.com/zts212653/clowder-ai/issues/1200` (`bug`, `triaged`, and `accepted` labels; maintainer verdict recorded in issue comment 5037044903)
- Related M7 reservation provenance only: `https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5011835675`
- Local grounding/plan: `feature-specs/2026-07-19-k1-producer-attestation.md`
- **Please judge whether the diff closes future-write valid-Date admission without overclaiming M7 or choosing identifier/migration policy.**

## Tradeoff

The shared helper admits only non-negative integral TimeClip values for append-time `timestamp` and transition-time `deliveredAt`. Append itself is not a terminal-delivery producer: its input excludes `deliveredAt`, permits only `deliveryStatus?: 'queued'`, and runtime callers that bypass TypeScript are rejected before ID/idempotency/store side effects. This matches every production append/delivery caller, the current lexical message-ID/cursor order, and the existing integral `deliveredAt` hydration contract. Redis hydration still preserves historical `timestamp` fractions rather than rewriting evidence; historical `deliveredAt` attestation or migration remains D3 work. Phase A1 proves single-writer/store parity, not linearizability between `markDelivered()` and `reassignUserId()` or exact zero-presence through HTTP/Web copies; those pre-existing gaps are RESERVED to `proposal_mrt0j01zvz1mopnq`. D2 owns the explicit cursor-order repair and may restore a broader write domain only with memory/Redis compatibility coverage. Message-ID maxima, thread/actor bounds, Unicode-scalar admission, and legacy reconciliation remain decision-gated and RESERVED.

## Architecture Ownership

Architecture cell: `dispatch`, grounded in F117's message-delivery lifecycle. The current map has no dedicated message-timeline storage cell, so this Phase A1 slice stays with the nearest existing delivery owner while reusing `IMessageStore.append`, `IMessageStore.markDelivered`, and `IMessageStore.markCanceled` boundaries. `bubble-pipeline` is an adjacent projection consumer only; it does not own persistence or terminal transitions.
Map delta: `none`
Why: this adds admission and source-state invariants to two existing store implementations inside the F117 delivery lifecycle; it creates no parallel Store/Queue/Router/Adapter/Dispatcher/Binding, moves no ownership boundary, and does not invent a new cell in a hotfix.

Please reviewer check:

- whether the declared cells are adequate for this narrow storage-admission slice;
- whether the diff is consistent with `Map delta: none`;
- whether the exported helper belongs at the existing store port rather than a new policy module.

## Invariant Matrix

| Invariant | Assertion | Verification |
|---|---|---|
| INV-1 pre-write admission | Invalid timestamps and append lifecycle-ownership bypasses reject before IDs, idempotency state, memory/Redis records/indexes, or listeners change. | Memory size/listener assertions; isolated Redis keyspace/listener assertions; ownership/timestamp helpers are the first statements in both `append()` methods. |
| INV-2 store parity | Memory and Redis use the same pure timestamp and append-ownership rules with stable error classes/messages. | Paired invalid-value tables assert timestamp `RangeError`; paired direct-append tables assert lifecycle `TypeError`, zero side effects, and a valid queued retry. |
| INV-3 sortable valid-Date domain | Every newly persisted timestamp is an integral TimeClip value whose current ID prefix preserves chronological order. | `0`, `1`, and positive TimeClip max succeed; negative/fractional/N+1/NaN/infinities reject; ID/cursor/expired-cursor tests cover consumers. |
| INV-4 hydration fidelity | Historical numeric timestamp evidence is neither truncated/replayed, present-but-blank evidence is not fabricated as epoch zero, and Redis `inf`/`-inf` scores remain equivalent to hydrated infinities. | Shared Redis numeric parser plus direct blank/whitespace/fractional/missing/infinity fixtures; fractional and positive/negative-infinity hash/zset fixtures cover both before APIs, with fractional and positive-infinity bounded collector progress. D3 raw audit still owns compatibility. |
| INV-5 legacy honesty | New-write admission does not close historical M7 compatibility or any identifier leaf. | Plan/handoff keep legacy audit/migration and D1–D3 explicitly outside this slice. |
| INV-9 delivery-order admission/ownership | Append accepts only absent/queued initial status and no `deliveredAt`; `markDelivered()` rejects every value outside the shared non-negative integral TimeClip domain before delivery state, hash fields, or global/user/thread scores change; invalid input is not state-dependent. | Public input type excludes terminal fields; paired runtime bypass tables cover fractional/non-finite/valid-integer `deliveredAt`, terminal statuses, zero side effects, queued retry, and transition invalid-domain loops. |
| INV-10 single-writer effective-order parity | With stable ownership during delivery, queued append starts with no `deliveredAt` and timestamp-scored indexes; every later admitted delivery value survives memory state, Redis hash text, global/user/thread scores, both hydration paths, sequential reassignment forwarding/fallback, and before-cursor reuse as the same exact number. Mention ordering intentionally remains append-time. | Paired queued append rehydration/index-score checks, zero/ordinary/positive-TimeClip-boundary transitions, sequential raw-score and missing-score reassignment cases, plus one-record-page collectors. Concurrent delivery × reassignment and transport/UI zero-presence are explicitly RESERVED. |

## E2E User Path Evidence

Exempt: this is an internal producer data-consistency guard with no UI or direct cat/user interaction. The executable path is covered at the persistence boundary in both storage implementations using isolated test data.

## Open Questions

### Technical OQ

1. Is validation early enough in both implementations to guarantee zero idempotency and index side effects?
2. Does the shared Redis numeric parser preserve legacy fractional/infinity cursor exclusivity across hash and canonical ZSET spellings while retaining integer behavior?
3. Does hydration keep blank/whitespace timestamp evidence invalid while retaining fractional, infinity, and missing-field compatibility?
4. Is the temporary non-negative integral TimeClip domain the correct safe boundary until D2 replaces lexical cursor ordering?
5. Does `markDelivered()` reject before any state/hash/index mutation and retain a valid retry across both stores?
6. Does the producer census correctly distinguish append-time creation (`timestamp`, optional queued status) from transition-owned `deliveredAt`/terminal status and sequential reassignment score forwarding, without implying concurrent atomicity?
7. Does the narrow scope honestly avoid claiming historical M7 or M1/M2 closure?

Please validate every row in the Invariant Matrix independently.

### Value OQ

None in this branch. Public identifier maxima, scalar admission, sortable-ID format, and legacy disposition remain explicit maintainer/operator decisions and are not encoded here.

## Fresh-Context Findings

Agent: `[砚砚/GPT-5.6 Sol🐾]`
SHA scanned: `ac0ba273f`
Scope: 6 files, 281 insertions, 2 deletions
Total findings: 0 (0 P1, 0 P2, 0 P3)

The scan separately recorded the decision-gated sortable-ID/legacy risks above; it did not reinterpret them as permission to broaden this branch.

**Reviewer delta tracking:** formal reviewer, please mark any finding `[FC:new]`; there are no pre-existing FC rows to mark covered.

### Delivery-order follow-up scan

Agent: `[宪宪/opus-4-8🐾]`
Scope: current uncommitted delivery-order diff
Reported: 1 P1, 1 P3

- **P1 dismissed after source verification:** the proposed failure required the shared helper to admit fractions and negatives, but `Number.isInteger(timestamp)` and `timestamp >= 0` are explicit preconditions. Paired tests reject `1.5` and `-1` before Redis access and assert unchanged hash plus timeline/user/thread/mention scores. No parser or second validator was added for this false-positive mechanism.
- **P3 fixed:** the port and both implementations now state the complete non-negative integral ECMAScript Date contract in their `markDelivered()` JSDoc.
- **Producer census corrected:** append produces creation-time `timestamp` and may initialize only queued/legacy-immediate state; `markDelivered()` exclusively produces terminal `deliveredAt`, `markCanceled()` owns cancellation, sequential reassignment only forwards an existing effective-order score, and the mention index intentionally retains append-time order. Concurrent delivery/reassignment remains a separate RESERVED atomicity gap.

## Remote review follow-up — `bf04e637`

- Finding: P1 legacy fractional cursor replay in Redis before pagination (`[FC:new]`).
- Verified mechanism: both cursor helpers truncated zset scores with `parseInt`, so `1.5` could not compare equal to the hydrated `1.5` timestamp and the cursor-exclusion branch was skipped.
- Failure-mode audit: the PR contained exactly two `parseInt(score)` sibling sites; both now use full numeric equality. No other Redis message score truncation remains.
- Red→Green: the direct legacy fixture returned `[earlier, cursor]` before the fix and `[earlier]` through both `getBefore()` and `getByThreadBefore()` after it.

## Remote review follow-up — `e3520dfa6`

- Finding: P1 new `docs/` bug report omitted ADR-011 YAML frontmatter (`[FC:new]`).
- Verified mechanism: `docs/SOP.md` requires frontmatter for every `docs/**/*.md`; `scripts/check-frontmatter.mjs` listed this exact path as missing.
- Red→Green: the target moved from `missingFrontmatter` index `4` to no missing frontmatter, `doc_kind`, or `created` entry after adding ADR-011-compliant bug-report metadata.
- Maintainer acceptance tail: added a bounded real-Redis `collectAllThreadMessages()` regression. With the old two score-truncation sites restored, it fails after three before-page calls with “pagination did not make progress”; with full numeric score equality it terminates in two calls with two unique records.

## Remote review follow-up — `50f45244d`

- Finding: P2 blank/whitespace Redis hash timestamp was coerced by `Number()` to epoch zero (`[FC:new]`).
- Verified mechanism: both single and batch hydration used `Number(raw ?? '0')`; present-but-blank strings therefore became `0`, unlike the prior invalid `NaN` evidence.
- Failure-mode audit: exactly two PR-delta timestamp hydration sites existed. Both now call one parser that distinguishes blank values from the existing missing-field default.
- Red→Green: direct empty/whitespace fixtures failed first in single hydration because the value was `0`; GREEN keeps them `NaN` through `getById()` and `getRecent()`, while fractional `123.5` and missing-field `0` remain unchanged.

## Remote review follow-up — `67bde9e3a`

- Finding: P2 Redis canonical `inf` / `-inf` ZSET scores failed equality against hydrated `Infinity` / `-Infinity` cursors (`[FC:new]`).
- Verified mechanism: isolated Redis 8.6.1 accepts `Infinity` / `-Infinity` scores but `ZSCORE` returns `inf` / `-inf`; JavaScript `Number()` parses the hash spellings but not the canonical score spellings.
- Failure-mode audit: this is the same hash↔ZSET numeric-equivalence invariant as the fractional cursor finding. Exactly two PR-delta score-to-number siblings exist; both now share the parser already used by single and batch timestamp hydration. Other `zscore` consumers only test membership or pass the raw score back to Redis.
- Red→Green: direct global/thread positive-infinity pagination returned `[earlier, cursor]`, and the bounded collector hit its non-progress guard. GREEN excludes positive and negative infinity cursors through both APIs and terminates the fractional/positive-infinity collectors in two before calls.

## Remote review follow-up — `2dfc02072`

- Finding: P1 `deliveredAt` was omitted as the second effective-order producer, allowing public `markDelivered()` calls to split Redis hash, ZSET, hydration, and pagination representations (`[FC:new]`).
- Stop-rule response: before changing runtime code, the plan and bug capsule were expanded with the queued-message Stateful Object Gate, `deliveredAt ?? timestamp` truth-source model, state/event table, representation/admission matrix, and full producer/consumer census in `f92b19474`.
- Chosen contract: memory and Redis reject every delivery value outside the shared non-negative integral TimeClip domain before lookup or mutation. This matches all production callers and keeps invalid API input state-independent.
- Red→Green: both store suites failed first because fractional/non-finite delivery values did not throw. GREEN rejects the full invalid domain with unchanged queued state; Redis additionally proves unchanged hash and global/user/thread/mention scores, exact zero/ordinary/positive-boundary hydration, sequential raw-score and missing-score user reassignment, successful retry, and complete one-record-page collection.
- Scope guard: historical attestation/migration and M7 remain RESERVED; `closingIssuesReferences` must stay empty.

## Systematic author scan — `ecca6b705`

- Finding: P1 concurrent `markDelivered()` × `reassignUserId()` can split hash/global/thread order from user-index order, or retain old-user membership (`[FC:new]`). Both opposite interleavings were reproduced on isolated Redis.
- Finding: P2 admitted `deliveredAt=0` can be omitted by truthiness-based HTTP/Web projection copies (`[FC:new]`). Store/hash/ZSET hydration remains exact; the uncovered boundary is beyond Phase A1's persistence proof.
- Finding: P3 base/gate evidence became stale after GitHub merged upstream main into the PR branch (`[FC:new]`).
- Size-gated disposition: the P1 repair requires a shared Redis atomic/CAS transition and concurrency suite, so operator directed it to an independent follow-up. P2 joins that effective-order consumer follow-up. This PR makes no new runtime change for either finding; it narrows INV-10 to stable-owner/single-writer parity and marks both gaps RESERVED under `proposal_mrt0j01zvz1mopnq`.

## Maintainer exact-HEAD follow-up — `ea12c92ce`

- Finding: P1 `AppendMessageInput` inherited `deliveredAt` plus terminal statuses from `StoredMessage`, allowing public append callers to bypass the declared transition owner and produce memory/Redis representation/index divergence (`[FC:new]`).
- Stop-rule response: before runtime code changed, the plan's truth-source matrix, Stateful Object Gate, state/event table, invariants, and adversarial matrix were expanded in `9d74d39e3` to separate creation from terminal transitions.
- Chosen contract: append may create legacy-immediate or queued records only. The structural input excludes `deliveredAt` and terminal status; one shared runtime guard protects JavaScript callers before both append implementations perform timestamp validation, ID generation, idempotency work, listener calls, or storage/index mutation.
- RED→GREEN: memory 32/33 → 33/33 and isolated Redis 33/34 → 34/34. Unsafe fractional/non-finite/valid-integer direct `deliveredAt` and terminal status all reject with zero side effects; a queued retry using the same idempotency key succeeds, rehydrates without `deliveredAt`, and Redis global/user/thread indexes retain the exact append timestamp.
- Existing fixture audit: production call sites already use status absent/`queued`; test-only direct terminal fixtures were migrated to queued→transition or legacy-immediate creation, with their behavior suites green.

## Maintainer `markCanceled` source-state P1 resolution

- Stop-rule response: plan commit `a1d10c8d8` updates the truth-source matrix, INV-9/INV-10, Stateful Object Gate, transition table, adversarial matrix, and bug capsule before runtime code changes.
- Chosen contract: one shared fail-closed source-state guard is consumed by both memory and Redis terminal methods. `markCanceled` applies only queued → canceled; missing returns `null`; legacy-immediate, delivered, and already-canceled records are returned unchanged.
- RED→GREEN: memory 33/34 → 34/34 and isolated Redis 34/35 → 35/35. The Redis delivered no-op snapshots hydrated status/`deliveredAt`, raw hash, and global/user/thread scores; queued success and repeated cancellation are also covered.
- Sibling-transition audit: the exact #1185 Redis tree has independent read→write delivery/cancellation paths and the three queue cancellation loops do not inspect the returned state before emitting `message_deleted`. #1185 therefore makes no concurrency or no-op event claim; atomic CAS and event suppression are explicitly owned by PR #1193 rather than duplicated here.
- Expanded dependent set: 232/232 across MessageStore, delivery-time, F117 lifecycle, F232 aggregator, callback, commands, and reply-validation suites.

## Next Action

Please perform an independent formal review of `origin/main...fix/k1-producer-attestation`, with a clear APPROVE or REQUEST_CHANGES verdict and severity on every finding. Do not treat this author-side scan as approval.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/fix-k1-producer-attestation/Fable`
- Start Command: not applicable; no server/UI path changed. Use the validation commands below from a detached read-only checkout.
- Ports: `web=N/A`, `api=N/A`

### Sandbox Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build
```

## Self-check evidence

### Spec compliance

- Phase A1 acceptance criteria are implemented and paired across memory/Redis.
- The repeated persisted-number finding triggered the round stop: delivery admission and stable-owner effective-order materialization were specified before runtime changes resumed; later concurrent owner reconciliation is explicitly RESERVED.
- Phase A2 and Phase B are intentionally not implemented: no public maxima, scalar policy, generator format change, legacy mutation, beta publication, or consumer pin.
- No UI, runtime-config, or production-data change.
- Patch counter: one plan-first commit plus one implementation commit for this newly verified ownership gap; no repeated repair of the same mechanism.
- Fallback-layer audit: one shared guard and one fail-closed branch; no fallback chain was added. Architecture map delta remains `none` because lifecycle ownership stays inside the existing message-store port.
- Design/artifact checks: no matching `.pen`, no web component diff, and no repository-root media artifact.
- Dogfood scope: exempt as a pure internal persistence-consistency fix; paired public store calls exercise the complete reject → queued retry → hydrate/index path in memory and isolated Redis.
- The branch contains GitHub's merge of upstream `main@dff66bdb4` (`5a7d76d78`); the two local Phase A1 commits were replayed on top without overlapping upstream file changes. The final exact HEAD is recorded in the live PR body after the managed gate; parked K-1 `9fb37310` is untouched.

### Test results

```text
pnpm --filter @cat-cafe/api run build
  PASS

node --test test/message-store.test.js        # from packages/api
  33 passed, 0 failed

node --test packages/api/test/message-store.test.js \
  packages/api/test/message-delivered-at.test.js \
  packages/api/test/delivery-status.test.js \
  packages/api/test/f232-thread-artifacts-aggregator.test.js
  73 passed, 0 failed

bash ./scripts/with-test-home.sh \
  bash ./scripts/run-isolated-redis-tests.sh -- \
  node --import "$(pwd)/test/helpers/setup-cat-registry.js" \
  --test --test-timeout=60000 test/redis-message-store.test.js
  34 passed, 0 failed (isolated Redis 8.6.1 on an ephemeral non-protected port)

CAT_CAFE_REDIS_TEST_ISOLATED=1 node --test test/f232-thread-artifacts-redis.test.js
  3 passed, 0 failed (same isolated Redis, run sequentially to prevent cleanup races)

node --test test/commands-route.test.js
  11 passed, 0 failed

node --test test/message-store.test.js test/message-delivered-at.test.js \
  test/delivery-status.test.js test/f232-thread-artifacts-aggregator.test.js \
  test/callback-routes.test.js test/commands-route.test.js test/reply-to-validation.test.js
  231 passed, 0 failed

pnpm lint && pnpm check && pnpm -r --if-present run build
  PASS (repository warnings only; 0 errors, exit 0)

pnpm gate
  Required on the committed post-review SHA before push. The live PR body records the
  exact HEAD, full-gate result, and focused-suite counts used for remote re-review.

git diff --check origin/main...HEAD
  PASS

root media/artifact gate (working tree + committed diff)
  PASS: no matches
```

### Related documents

- Plan: `feature-specs/2026-07-19-k1-producer-attestation.md`
- Bug capsule: `docs/bug-report/k1-invalid-message-timestamp/bug-report.md`
- Primary tracking bug: accepted issue `#1200`
- Related reservation provenance only: issue `#1165` (M7; no implementation authorization)

[砚砚/GPT-5.6 Sol🐾]
