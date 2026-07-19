# Review Request: K-1 producer valid-Date admission

Review-Target-ID: `fix-k1-producer-attestation`
Branch: `fix/k1-producer-attestation`
Code SHA: `ac0ba273f`

## What

- Add one shared `assertValidStoredMessageTimestamp()` admission rule to the memory and Redis message stores.
- Run that rule before ID generation, idempotency work, store/index mutation, Redis commands, or append listeners.
- Preserve valid fractional timestamps through both Redis hydration paths by replacing integer parsing with numeric parsing.
- Cover invalid Date values, exact Date boundaries, fractional round trips, and zero-side-effect rejection in paired memory/Redis tests.

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

The helper follows the ECMAScript Date TimeClip domain, so valid fractional and expanded-year-boundary inputs remain accepted. Redis now round-trips fractions rather than truncating them. That preserves the existing accepted domain but does not repair the older `generateSortableId()` formatting assumptions for fractional/negative timestamps. Message-ID format/maxima, thread/actor bounds, Unicode-scalar admission, and legacy reconciliation remain decision-gated and RESERVED.

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
| INV-2 store parity | Memory and Redis use the same pure rule and stable error class/message. | Paired invalid-value tables assert `RangeError` and `/valid ECMAScript Date/`. |
| INV-3 valid-Date domain | Every newly persisted timestamp produces a non-invalid ECMAScript Date. | Exact ±8,640,000,000,000,000 boundaries and `1.5` succeed; N+1, NaN, and infinities reject. |
| INV-4 hydration fidelity | A valid fractional timestamp is not silently truncated by Redis reads. | `getById()` and `getRecent()` both round-trip `1.5`. |
| INV-5 legacy honesty | New-write admission does not close historical M7 compatibility or any identifier leaf. | Plan/handoff keep legacy audit/migration and D1–D3 explicitly outside this slice. |

## E2E User Path Evidence

Exempt: this is an internal producer data-consistency guard with no UI or direct cat/user interaction. The executable path is covered at the persistence boundary in both storage implementations using isolated test data.

## Open Questions

### Technical OQ

1. Is validation early enough in both implementations to guarantee zero idempotency and index side effects?
2. Is `Number()` correct for the two Redis timestamp hydration paths while retaining all previously valid integer data?
3. Does accepting the full TimeClip domain preserve the intended `occurredAt` contract without accidentally asserting sortable-ID compatibility?
4. Does the narrow scope honestly avoid claiming historical M7 or M1/M2 closure?

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
- Worktree is clean on `fix/k1-producer-attestation`, directly based on `origin/main@191122256`; parked K-1 `9fb37310` is untouched.

### Test results

```text
pnpm --filter @cat-cafe/api run build
  PASS

node --test test/message-store.test.js        # from packages/api
  28 passed, 0 failed

bash ./scripts/with-test-home.sh \
  bash ./scripts/run-isolated-redis-tests.sh -- \
  node --import "$(pwd)/test/helpers/setup-cat-registry.js" \
  --test --test-timeout=60000 test/redis-message-store.test.js
  26 passed, 0 failed (isolated Redis on an ephemeral non-protected port)

pnpm lint
  PASS (existing web warnings only)

pnpm check
  PASS after using the correct non-feature branch class `fix/k1-producer-attestation`

pnpm -r --if-present run build
  PASS (existing web warnings only)

pnpm test
pnpm test:api:redis
  BASELINE-RED, not represented as green: origin/main checkout tests reference assets that
  do not exist on origin/main (for example scripts/redis-restore-from-rdb.sh,
  docs/reflections/README.md, and .claude/settings.json). An independent detached
  origin/main@191122256 reproduction ran redis-restore-script + reflection-capsule-m3:
  1 passed / 6 failed with the same missing-file failures. Target memory/Redis suites above are green.

git diff --check origin/main...HEAD
  PASS

root media/artifact gate (working tree + committed diff)
  PASS: no matches
```

This is a documented Rule-0 exception to the repository-wide “all tests green” prerequisite: the branch does not hide or reclassify the full-suite failure, and exact baseline reproduction is attached so the reviewer can reject the exception if the causal separation is not convincing.

### Related documents

- Plan: `feature-specs/2026-07-19-k1-producer-attestation.md`
- Bug capsule: `docs/bug-report/k1-invalid-message-timestamp/bug-report.md`
- External shape anchor: issue `#1165`, M7 remains RESERVED

[砚砚/GPT-5.6 Sol🐾]
