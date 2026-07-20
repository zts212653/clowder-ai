# Review Request: K-1 producer sortable-safe Date admission

Review-Target-ID: `fix-k1-producer-attestation`
Branch: `fix/k1-producer-attestation`
Pre-fix review SHA: `05ad80c6f789477bf313b76210dc6657e0edc577`

## What

- Add one shared `assertValidStoredMessageTimestamp()` admission rule to the memory and Redis message stores.
- Run that rule before ID generation, idempotency work, store/index mutation, Redis commands, or append listeners.
- Preserve fractional historical evidence through both Redis hydration paths; hydration is not new-write admission.
- Preserve present-but-blank historical timestamp evidence as invalid instead of coercing it to epoch zero.
- Preserve exclusive global/thread before-cursor pagination for that fractional historical evidence, including bounded multi-page consumer progress.
- Cover the non-negative integral Date domain, chronological IDs, delivery-cursor monotonicity, expired-cursor recovery, and zero-side-effect rejection in paired memory/Redis tests.

## Why

K-1 projects `StoredMessage.timestamp` through `Date#toISOString()`, but both stores previously accepted numbers that make that projection throw. #1165 revision 6 correctly keeps M7 RESERVED until valid-Date admission and stored-data attestation/migration exist. This slice closes only the future-write admission half and deliberately leaves historical compatibility and public identifier bounds unresolved.

## Original Requirements

> “M7 marks `occurredAt` CLOSED ... [but] does not prove that every source timestamp is a valid ECMAScript Date.”
> “Required correction: either ... mark M7 RESERVED pending a K-1 valid-Date admission plus stored-data attestation/migration invariant, or ... provide that source invariant now.”
> New-write admission must not be represented as proof for historical stored data.

- Source: `https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5011835675`
- Local grounding/plan: `feature-specs/2026-07-19-k1-producer-attestation.md`
- **Please judge whether the diff closes future-write valid-Date admission without overclaiming M7 or choosing identifier/migration policy.**

## Tradeoff

The helper temporarily admits only non-negative integral TimeClip values because the current `generateSortableId()` and cursor stores compare IDs lexically. Redis hydration still round-trips historical fractions rather than truncating or rewriting evidence. D2 owns the explicit cursor-order repair and may restore full valid-Date admission only with memory/Redis compatibility coverage. Message-ID maxima, thread/actor bounds, Unicode-scalar admission, and legacy reconciliation remain decision-gated and RESERVED.

## Architecture Ownership

Architecture cell: `identity-session` with `thread-navigation` as the adjacent owner for the plan's later identity decisions; this Phase A1 slice reuses the existing `IMessageStore.append` boundary.
Map delta: `none`
Why: this adds a pure admission invariant to two existing store implementations; it creates no parallel Store/Queue/Router/Adapter/Dispatcher/Binding and moves no ownership boundary.

Please reviewer check:

- whether the declared cells are adequate for this narrow storage-admission slice;
- whether the diff is consistent with `Map delta: none`;
- whether the exported helper belongs at the existing store port rather than a new policy module.

## Invariant Matrix

| Invariant | Assertion | Verification |
|---|---|---|
| INV-1 pre-write admission | Invalid timestamps reject before IDs, idempotency state, memory/Redis records/indexes, or listeners change. | Memory size/listener assertions; isolated Redis keyspace/listener assertions; helper is first statement in both `append()` methods. |
| INV-2 store parity | Memory and Redis use the same pure rule and stable error class/message. | Paired invalid-value tables assert `RangeError` and `/non-negative integer ECMAScript Date/`. |
| INV-3 sortable valid-Date domain | Every newly persisted timestamp is an integral TimeClip value whose current ID prefix preserves chronological order. | `0`, `1`, and positive TimeClip max succeed; negative/fractional/N+1/NaN/infinities reject; ID/cursor/expired-cursor tests cover consumers. |
| INV-4 hydration fidelity | Historical fractional timestamp evidence is neither truncated/replayed, and present-but-blank timestamp evidence is not fabricated as epoch zero. | Shared Redis timestamp parser plus direct blank/whitespace/fractional/missing fixtures covering single and batch hydration; fractional hash/zset fixtures cover both before APIs and bounded collector progress. D3 raw audit still owns compatibility. |
| INV-5 legacy honesty | New-write admission does not close historical M7 compatibility or any identifier leaf. | Plan/handoff keep legacy audit/migration and D1–D3 explicitly outside this slice. |

## E2E User Path Evidence

Exempt: this is an internal producer data-consistency guard with no UI or direct cat/user interaction. The executable path is covered at the persistence boundary in both storage implementations using isolated test data.

## Open Questions

### Technical OQ

1. Is validation early enough in both implementations to guarantee zero idempotency and index side effects?
2. Do `Number()` hydration and full numeric zset-score comparison jointly preserve legacy fractional cursor exclusivity while retaining all integer behavior?
3. Does hydration keep blank/whitespace timestamp evidence invalid while retaining fractional and missing-field compatibility?
4. Is the temporary non-negative integral TimeClip domain the correct safe boundary until D2 replaces lexical cursor ordering?
5. Does the narrow scope honestly avoid claiming historical M7 or M1/M2 closure?

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

## Remote review follow-up — `bf04e637`

- Finding: P1 legacy fractional cursor replay in Redis before pagination (`[FC:new]`).
- Verified mechanism: both cursor helpers truncated zset scores with `parseInt`, so `1.5` could not compare equal to the hydrated `1.5` timestamp and the cursor-exclusion branch was skipped.
- Failure-mode audit: the PR contained exactly two `parseInt(score)` sibling sites; both now use full numeric equality. No other Redis message score truncation remains.
- Red→Green: the direct legacy fixture returned `[earlier, cursor]` before the fix and `[earlier]` through both `getBefore()` and `getByThreadBefore()` after it.

## Remote review follow-up — `e3520dfa6`

- Finding: P1 new `docs/` bug report omitted ADR-011 YAML frontmatter (`[FC:new]`).
- Verified mechanism: `docs/SOP.md` requires frontmatter for every `docs/**/*.md`; `scripts/check-frontmatter.mjs` listed this exact path as missing.
- Red→Green: the target moved from `missingFrontmatter` index `4` to no missing frontmatter, `doc_kind`, or `created` entry after adding F258 bug-report metadata.
- Maintainer acceptance tail: added a bounded real-Redis `collectAllThreadMessages()` regression. With the old two score-truncation sites restored, it fails after three before-page calls with “pagination did not make progress”; with full numeric score equality it terminates in two calls with two unique records.

## Remote review follow-up — `50f45244d`

- Finding: P2 blank/whitespace Redis hash timestamp was coerced by `Number()` to epoch zero (`[FC:new]`).
- Verified mechanism: both single and batch hydration used `Number(raw ?? '0')`; present-but-blank strings therefore became `0`, unlike the prior invalid `NaN` evidence.
- Failure-mode audit: exactly two PR-delta timestamp hydration sites existed. Both now call one parser that distinguishes blank values from the existing missing-field default.
- Red→Green: direct empty/whitespace fixtures failed first in single hydration because the value was `0`; GREEN keeps them `NaN` through `getById()` and `getRecent()`, while fractional `123.5` and missing-field `0` remain unchanged.

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
- Phase A2 and Phase B are intentionally not implemented: no public maxima, scalar policy, generator format change, legacy mutation, beta publication, or consumer pin.
- No UI, runtime-config, or production-data change.
- The post-review fix stays on `fix/k1-producer-attestation`, based on `origin/main@128263c9b`; parked K-1 `9fb37310` is untouched.

### Test results

```text
pnpm --filter @cat-cafe/api run build
  PASS

node --test test/message-store.test.js        # from packages/api
  30 passed, 0 failed

bash ./scripts/with-test-home.sh \
  bash ./scripts/run-isolated-redis-tests.sh -- \
  node --import "$(pwd)/test/helpers/setup-cat-registry.js" \
  --test --test-timeout=60000 test/redis-message-store.test.js
  30 passed, 0 failed (isolated Redis on an ephemeral non-protected port)

node --test test/commands-route.test.js
  11 passed, 0 failed

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
- External shape anchor: issue `#1165`, M7 remains RESERVED

[砚砚/GPT-5.6 Sol🐾]
