# Review Request: K-1 Plugin Messaging Domain Convergence

Review-Target-ID: `feat-k1-messaging-domain`
Branch: `feat/k1-messaging-domain`
Implementation candidate: branch HEAD produced by this R3 repair; the exact SHA is attached to the Terra re-review handoff

## What

K-1 introduces the plugin-facing messaging domain as one complete kernel slice:

- `messaging.send(draft)` with canonical envelopes and host-issued addressing
- per-thread monotonic output events, durable subscription-local ack cursors, stale detection, and snapshot recovery
- atomic `messaging.appendElements` through a host-issued MessageHandle, with parent-handle revocation, provenance, and revision enforcement
- instance-scoped send/append settlement ledgers
- memory and Redis stores plus a K-2-facing `createMessagingDomain(...)` composition seam

The implementation candidate contains 25 commits and changes 49 files (`+8032/-19`) relative to `upstream/main@01bf27faf`. It does not migrate existing connector call sites or instantiate a broker; those belong to K-2/P-7.

## Why

The public plugin contract needs one reliable messaging model instead of exposing connector-specific transports. K-1 defines the host-owned boundary: plugins use scoped handles, while the existing connector transport retains platform delivery and degradation behavior. This keeps canonical identity, authorization, persistence, and replay semantics in the kernel without making plugins aware of raw thread IDs or connector internals.

## Original Requirements（必填）

> `MessageDraft.address: ThreadHandle | ConnectorBindingRef` — host-issued, no raw ID channel.
> `MessageEnvelope` is canonical and host-binds actor/audience/time.
> `MessageOutputEvent` has per-thread monotonic sequence for publish and append events.
> Ack is durable per consumer; stale cursors require snapshot recovery and never silently skip.
> Send key = `(pluginInstanceId, idempotencyKey)`; append key = `(pluginInstanceId, messageId, operationId)`.

- Source: `zts212653/clowder-ai-plugins@189f25d`, `docs/proposals/plugin-system-principles-and-v0-design.md` §3.1
- Candidate contract checked for executable parity: `zts212653/clowder-ai-plugins#3@f5faba5`
- Operational scope/gate: `zts212653/clowder-ai-plugins#1` roadmap comment `#issuecomment-4969779486`, PR-2 K-1
- Please judge whether the implementation preserves this host/plugin boundary and all five K-1 deliverables.

## Architecture Ownership（必填）

Architecture cell: `plugin-messaging`
Map delta: `new cell required`
Why: K-1 creates the plugin-facing messaging contract and reliability state machines. It is distinct from the existing connector transport cell (F088), which continues to own inbound/outbound platform transport and platform degradation.

Please check:

- whether `plugin-messaging` is the right ownership boundary or should be named/placed differently;
- whether the new ledger, event log, cursor, handle, and append-lock stores remain internal persistence seams of this cell rather than parallel transport infrastructure;
- whether additive `IMessageStore.extra.pluginMessage` persistence keeps `StoredMessage` as the single canonical message truth.

## Invariant Matrix

| Invariant | Required behavior | Main verification |
|---|---|---|
| INV-1 | Same send idempotency key returns the identical receipt | send, ledger, facade suites |
| INV-2 | Plugin drafts cannot produce `system` audience | validation + adversarial send suites |
| INV-3 | Sequence is strictly monotonic per thread | memory/Redis event-log suites |
| INV-4 | Unacked events redeliver; acked events do not | event-stream suites |
| INV-5 | Cursor token is opaque and subscription-local | event-stream adversarial cases |
| INV-6 | Append never rewrites an existing element | append suites |
| INV-7 | Append cannot wash `inference` into stronger provenance | append provenance cases |
| INV-8 | Cross-instance and revoked handles/messages fail closed, including MessageHandle → parent address-handle revocation | handle + append ownership suites |
| INV-9 | Retention overrun returns stale, never a silent gap | event-stream stale/snapshot suites |
| INV-10 | `baseRevision` conflict produces zero mutation | append CAS/lease-takeover cases |
| INV-11 | Existing non-plugin message paths remain unchanged | extra round-trip + rich-block regression suites |
| INV-12 | Repeated append operation never duplicates elements | append replay + Redis suites |
| INV-13 | Append requires a live parent grant with `canSubscribe=true` | send-only parent handle regression |
| INV-14 | Append lease validation and event insertion are atomic | Memory + Redis fencing suites |
| INV-15/16 | Output watermark advances contiguously; successor repairs predecessors first | append takeover/replay suites |
| INV-17/18 | Snapshot revN cannot be followed by an older revision; uncovered fenced holder cannot settle | controlled retention-1 race + retry regression |
| INV-19/20 | Canonical hydration is closed/bounded, append history exactly reconstructs its stamped suffix, and media/rich payloads stay open | envelope + Redis round-trip suites |

## Fresh-Context and Terra R1/R3 Findings Closed

All sixteen are fixed in the current branch HEAD and await Terra's full re-review:

1. Trace fields were lost through persistence/projection.
2. Retention trim racing `read()` could silently skip events.
3. Snapshot head/message reads could include a message beyond the captured head.
4. An expired append-lock holder could overwrite a successor revision.
5. An old ledger claimant could release or settle a successor claim.
6. Redis `pluginMessage` parsing dropped fields and only shallowly validated values.
7. Replay after event trim could rewrite an event's original `baseRevision` from retry input.
8. Lock takeover after persistence but before emission could publish `rev3` before `rev2`; persisted `appendOps` now act as a small repairable outbox.
9. Append accepted a naked `messageId`, bypassing the original address handle's revocation truth; send now persists a host-issued MessageHandle and append resolves both it and its still-live parent handle before ledger claim.
10. Snapshot could include an output completed beyond `resumeSequence`, while a fixed 200-message window could silently omit older state; canonical `outputRevision/outputSequence`, a complete thread scan, and a stable two-head fence now fail closed under active races.
11. The handwritten mirror accepted shapes wider than C-1; closed objects and duplicate whisper targets are rejected, and both read pages and cumulative envelopes are capped at 32.
12. Soft deletion before a publish/append watermark completed permanently poisoned snapshot retries; snapshot now derives the fenced set from canonical current-state projection before checking output watermarks, while historical events remain untouched.
13. A send-only parent grant could still authorize append; `resolveForAppend()` now checks the live parent's `canSubscribe` bit before any ledger claim.
14. A stale emitter could append rev2 after a successor emitted/snapshotted rev3 once retention trimmed rev2's dedupe key; append event insertion now validates the current lease atomically (Memory synchronous critical section, Redis Lua), fenced writes consume no sequence, and output watermarks advance one revision at a time.
15. Redis hydration still accepted unknown closed-object fields, 33 elements, and duplicate IDs; memory projection and Redis hydration now share one strict closed/bounded parser without a permissive fallback.
16. Strict hydration accepted an `appendOps` record that claimed an initial element while leaving the actual appended element unowned; the shared parser now requires ordered bijection with the stamped element suffix, exact present `baseRevision`, and pre-operation derivation sources.

The R1 repair range is `f2d618932..72515cf6b`; the deletion-race repair is `06c0bbbbd`; the R2 emission-fencing state model is committed at `7580e7002`. The current repair closes the remaining writer/parser drift in that terminal state model. Existing Redis owner-token/CAS, cursor, and host-extra isolation mechanisms were retained.

## Dogfood-Your-Slice

The official isolated Redis runner completed this 11-step plugin-developer path:

1. Issue a scoped thread handle.
2. Subscribe through that handle.
3. Send a plugin message.
4. Read the publish event.
5. Ack the delivered cursor.
6. Append derived elements.
7. Read the append event.
8. Take a consistent snapshot.
9. Replay send with the same idempotency key.
10. Replay append with the same operation ID.
11. Verify the final Hub-visible content projection.

Result: 11/11 pass. The temporary script was removed; no dogfood artifacts remain.

R3 is an internal canonical-hydration correction with no new user-facing surface; the existing 11-step path remains the applicable dogfood, and the final facade suite reruns the live issue→append→snapshot chain.

## Tradeoffs

1. **Contract mirror before v0.1 publish:** K-1 currently mirrors C-1 candidate `f5faba5` locally so shape review can run in parallel. The five-step gate still requires replacing/pinning this mirror to the exact published v0.1 package and running conformance before merge.
2. **Single-thread subscriptions:** each subscription binds exactly one ThreadHandle. Multiple threads require multiple subscriptions, structurally preventing a cursor from advancing across threads.
3. **Persistent append operation history + terminal lease fence:** `appendOps` records the original element IDs and `baseRevision`, enabling crash replay and predecessor-event repair. It is bounded by per-message append limits rather than silently compacted in K-1. The event store additionally requires the current append lease for insertion; retention/dedupe alone is not an ownership boundary.
4. **Public-only stream/snapshot in v0:** whisper messages are send-only; authorized consumers may observe sequence gaps but cannot receive restricted content.
5. **Snapshot under sustained writes:** snapshot retries a stable complete fence three times, then returns `RETRYABLE_INFLIGHT`; it never truncates state or advances a cursor over omitted messages.

## Open Questions

### Technical OQ（for reviewer）

1. **Ownership cell:** should `plugin-messaging` become a new cell as proposed, with F088 retaining connector transport, or should the map express a parent/child relationship?
2. **Feature number collision:** this upstream-mirror branch uses tentative F288, while fork `develop_base` already uses F288 for Desktop In-App Update. Please choose the final upstream feature number; the implementation intentionally did not guess or rewrite history.
3. **Append outbox window:** `appendOps` repairs every committed predecessor before a successor write; event-key dedupe is retention-window bounded, so an old crash replay may re-emit the same `eventId` at a new sequence under the documented at-least-once contract. Please verify that this boundary and bounded, non-compacting operation history are acceptable for v0.1.

### Value OQ（for operator）

None. The remaining questions are reversible ownership/numbering/contract mechanics inside the approved K-1 scope.

## Next Action

Please re-review `upstream/main@01bf27faf...HEAD`, with particular focus on Terra R2's three repaired roots and the affected existing paths:

1. A MessageHandle minted from `canSend=true, canSubscribe=false` cannot append, and parent liveness/revocation still gate before ledger claim.
2. With `retentionCount=1`, successor rev3 output/snapshot followed by stale rev2 resume produces no event and consumes no sequence in both Memory and Redis stores.
3. A fenced holder succeeds only when canonical output covers its target revision; otherwise it returns `RETRYABLE_INFLIGHT`, releases the claim, and a later lease repairs it.
4. `outputRevision/outputSequence` advances contiguously, successor repair remains revision-ordered, and replay may re-emit only the latest same-message revision.
5. Canonical hydration rejects closed-schema/bound/relationship violations while retaining open `media_ref`/`rich_block` payloads and independent Redis arrays.
6. Flattened `appendOps[].elementIds` equals the canonical appended suffix in order; present `baseRevision`, appended stamps, and derivation boundaries match `AppendService` output.
7. Existing snapshot deletion, Redis owner-token/CAS, cursor, and host-extra isolation paths remain unchanged.

This request is `review-ready`, not `shape-approved`. A reviewer pass is required before the latter signal is sent to the plugins thread.

## Review Sandbox（必填）

- Reviewer: `@codex`
- Path: `/tmp/cat-cafe-review/feat-k1-messaging-domain/codex`
- Start Command: N/A — backend domain only; use the verification commands below
- Ports: N/A — no UI or runtime service is required

## Verification Evidence

| Check | Result |
|---|---|
| K-1 non-Redis targeted suites | 149/149 pass |
| Official isolated Redis targeted suites | 18/18 pass |
| Terra review targeted validation/append/event-stream/snapshot suites | 72/72 pass |
| Terra R2 Red → Green | send-only append, snapshot rev3 followed by new rev2, uncovered stale holder settlement, and permissive hydration all reproduced RED; focused GREEN 25/25 |
| Terra R3 append-history Red → Green | exact counterexample reproduced as 10/11 RED → 11/11 GREEN; affected append/envelope/Redis-parser consumers 21/21 |
| Dogfood real path | 11/11 pass |
| `pnpm check` | exit 0 |
| `pnpm lint` | exit 0; pre-existing web warnings only |
| `pnpm -r --if-present run build` | exit 0 |
| `git diff --check` | exit 0 |
| K-1 source/test file hard limit | all <=350 lines; maximum 349 (`plugin-messaging-redis-stores.test.js`) |

Full `pnpm test` and full API `test:redis` still encounter upstream-mirror fork-only baseline failures. A branch/base comparison established identical failing sets before the final audit; neither run contains a K-1 failure. The focused Redis runner is green and uses isolated DB 15 on a non-reserved random port.

Related evidence: `docs/features/F288-plugin-messaging-domain.md` and the two bug reports under `docs/bug-report/`.

Upstream audit: the three commits after merge base `01bf27f` through `591a9dc` touch desktop, provider effort, cat config/web, and governance only; none overlaps the messaging/Redis event-log slice, so no dirty-tree reconciliation was needed before re-review.

---

Date: 2026-07-16
Signed: [砚砚/GPT-5.6 Sol🐾]
