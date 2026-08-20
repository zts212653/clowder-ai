---
feature_ids: [F273]
topics: [desktop, electron, updater, renderer-readiness, state-machine]
doc_kind: implementation-plan
created: 2026-07-29
updated: 2026-08-03
---

# F273 renderer document-readiness state contract

> Stateful Object Gate contract originated by the F273 design owner (Fable),
> then corrected after terra's FC-1 stale-REGISTER counterexample. This contract
> supersedes both start-navigation admission windows and renderer-initiated
> document registration.

## Scope and release boundary

PR #1227 exact HEAD `b768d4e91f067f60d51b3055dbbaec5b6a2f88c9`
still admits a trusted `desktop-update:ready` sent by the old main-frame
document after readiness has been invalidated. The stale event can set
`_rendererReady` back to `true`, so a prompt created before the new AppShell
mounts does not arm the 15-second native-fallback timer.

The first token implementation at `83ae487a7` closes stale READY but lets any
trusted main-frame REGISTER replace the token. A queued REGISTER from retired
document D1 can therefore arrive after D2 has registered and become ready,
replace D2's token, and demote the live state from S2 to S1. D2 already had its
READY accepted, so rejection-based retry never runs. The review-packet HEAD
`38c7ffd07` is consequently not a release candidate either.

Fork dry-run `0.12.0-rc.1105.3` (Actions run `30380555581`) is therefore
superseded and must not be offered for installation. A replacement RC can be
dispatched only from the repaired, exact-reviewed, CI-green PR head.

This plan changes no transfer owner, fallback duration, persistence, or React
API. `UpdatePromptController` remains the unique lifecycle owner.

## Why document identity is required

- `WebFrameMain` identifies a frame, not a document. Same-site navigation can
  reuse the frame and renderer process, so sender/main-frame equality plus
  origin validation cannot distinguish a queued old-document message from a
  new-document message.
- IPC and navigation events do not provide one cross-interface ordering
  guarantee on which an admission window can safely depend.
- `did-navigate` is the main-frame document commit boundary. A cancelled or
  failed provisional navigation has no commit and must not perturb the live
  document's readiness.

The selected mechanism is therefore a main-owned document capability generated
only from the main-frame commit lifecycle and delivered main→preload. Renderer
documents cannot request, replace, or choose it. The capability is revoked on
the next commit or renderer-process loss. `did-start-navigation`, renderer
REGISTER, and their readiness predicates are removed.

## Mechanism

1. Main-frame `did-navigate` calls the controller's commit transition. The
   controller first invalidates the retired capability, then generates a new
   opaque capability only if the current main window is still the trusted app
   origin, and immediately sends it to the current trusted main frame. Commit
   is the atomic create-and-first-deliver transition.
2. Top-level `dom-ready` idempotently replays the active capability over the
   same main→preload-only channel. The replay covers lifecycle delivery order
   without minting or replacing authority. There is no renderer-initiated
   registration handler.
3. Preload installs the capability listener before exposing the bridge and
   stores the value only in its isolated closure; React never receives or
   supplies it.
4. The existing zero-argument `bridge.updatePromptReady()` records readiness
   intent. Capability delivery and intent may arrive in either order; whichever
   arrives second invokes `desktop-update:ready` exactly once for that
   capability. Intent is a persistent latch, not consumed by a READY attempt;
   every newly delivered capability re-evaluates the same intent once.
5. READY returns `{ accepted: boolean }` for diagnostics but cannot mint or
   replace authority. Rejection stops; a replacement document receives its own
   capability from its own commit/DOM lifecycle.
6. `render-process-gone` revokes the capability and calls the existing
   pending-presentation invalidation behavior.

No new store or timer is added. The existing presentation timer remains the
only fallback timer.

## State × event transition table

State is `(documentToken, rendererReady)`:

- S0 = `(null, false)`: no authorized current document.
- S1(T) = `(T, false)`: trusted current document committed but AppShell not
  ready.
- S2(T) = `(T, true)`: trusted current document committed and AppShell ready.
- `(null, true)` is unreachable.

| Current | Event | Next | Required effects |
|---|---|---|---|
| S0 | trusted app main-frame commit | S1(T_new) | Generate and deliver a new main-owned capability; re-arm pending presentation |
| S0 | DOM_READY / delivery request | S0 | No capability to deliver |
| S0 | READY(any) | S0 | Reject `{ accepted: false }` |
| S0 | untrusted commit / process-gone | S0 | Idempotent invalidation |
| S1(T) | trusted app main-frame commit | S1(T_new) | Revoke T, generate and deliver replacement capability, re-arm pending presentation |
| S1(T) | DOM_READY | S1(T) | Send T to the current trusted main frame; no state mutation |
| S1(T) | READY(T) | S2(T) | Accept; invoke `onRendererReady` once; present/replay pending prompt and progress |
| S1(T) | READY(T' ≠ T) | S1(T) | Reject without presentation, replay, callback, or timer clear |
| S1(T) | untrusted commit / process-gone | S0 | Revoke capability and invalidate pending presentation |
| S2(T) | trusted app main-frame commit | S1(T_new) | Revoke T, generate and deliver replacement capability, re-arm pending presentation |
| S2(T) | DOM_READY | S2(T) | Idempotently send T to the current trusted main frame |
| S2(T) | READY(T) | S2(T) | Idempotently accept; do not start a second readiness epoch |
| S2(T) | READY(T' ≠ T) | S2(T) | Reject stale/forged token |
| S2(T) | untrusted commit / process-gone | S0 | Revoke capability and invalidate pending presentation |
| any | dispose | S0 | Revoke capability/readiness, remove controller IPC handlers, and resolve a pending prompt as `later` |

Negative lifecycle contract:

- `did-start-navigation`: no readiness mutation and no listener.
- Cancelled/fail-load provisional navigation: no commit, so no readiness
  mutation.
- Same-document navigation: no readiness mutation.
- Child-frame navigation: no readiness mutation.

### Ownership and bypass restrictions

- `UpdatePromptController` alone creates, replaces, compares, delivers, and
  revokes the capability and alone writes renderer readiness.
- `desktop/main.js` forwards only main-frame `did-navigate`, top-level
  `dom-ready`, and `render-process-gone` lifecycle events. The controller's
  commit transition performs first delivery; `dom-ready` is replay only.
- Main code never reads or writes token/readiness fields directly.
- Preload cannot request or choose the capability, exposes no token-bearing API
  to React, and sends READY at most once per delivered capability.
- Renderer code keeps the existing zero-argument `updatePromptReady()` API.
- The renderer-initiated REGISTER channel and handler do not exist.
- Capability delivery and READY retain current-window, trusted-origin, and
  current-main-frame checks.
- No lifecycle caller may directly clear a presentation timer.
- Controller disposal does not own the listeners registered by `main.js`.
  Shutdown first disposes and nulls the global controller owner, making those
  optional-chained forwarders no-ops; BrowserWindow destruction then releases
  the forwarding listeners with the WebContents.

## Invariants and required tests

1. **INV-1 — Reachable-state shape.**
   `rendererReady` implies a non-null document token.
   - Test every transition in the decision table and assert no `(null, true)`
     state is observable through behavior.
2. **INV-2 — Bounded fallback.**
   A pending transaction whose current document is not ready has exactly one
   live presentation timer.
   - Test commit/process loss and repeated invalidation against timer
     identity/count.
3. **INV-3 — Commit revokes old documents.**
   After commit, every READY except one carrying the capability minted by that
   commit is rejected.
   - Primary RED: accepted ready → commit → stale ready → `show()` must produce
     one live fallback timer.
4. **INV-4 — Commit/process loss re-arms pending presentation.**
   Both transitions leave ready false and re-arm the timer for an in-flight
   prompt.
   - Test while a pending prompt is presentation-ready.
5. **INV-5 — No-commit navigation is inert.**
   Cancelled, failed provisional, same-document, and child-frame navigation do
   not mutate readiness.
   - Source-contract test removes `did-start-navigation` readiness wiring and
     admits only `did-navigate`, `dom-ready` capability delivery, and process
     loss.
6. **INV-6 — Token equality is mandatory.**
   READY with a random, old, missing, or malformed token is rejected.
   - Controller decision-table tests.
7. **INV-7 — Only commit replaces authority.**
   No renderer-originated IPC can create or replace the active capability.
   - Assert the REGISTER channel/handler is absent and a delayed retired-
     document message cannot change the live token, readiness epoch, callback,
     replay, or timer.
8. **INV-8 — Delivery-order convergence.**
   Preload completes READY once for the active capability whether readiness
   intent occurs before or after capability delivery. A transport-level invoke
   rejection re-arms only the still-current capability for a later delivery or
   intent event; a retired rejection cannot clear its replacement marker.
   - Preload tests cover intent→capability, capability→intent, duplicate
     capability, duplicate intent, and
     intent→C1→READY(C1) rejected→C2→READY(C2) once, same-capability retry
     after invoke rejection, and C1 rejection after C2 becomes current.
9. **INV-9 — Epoch callback idempotence.**
   Duplicate READY(T) in S2 never invokes `onRendererReady` twice.
   - Adapt the existing readiness-epoch test.
10. **INV-10 — Retired registration is powerless.**
    D1 cannot demote or replace D2 after D2 READY is accepted.
    - Primary R2 RED: delay D1's former registration until after D2
      commit→capability→READY; assert D2 stays ready, no timer starts, and its
      duplicate READY remains accepted.
11. **INV-11 — Disposal is terminal.**
    Disposal revokes readiness authority, removes every controller-owned IPC
    handler, finishes the pending prompt once, and leaves later main lifecycle
    forwarding inert through the nulled owner reference.
    - Extend dispose/source-contract tests.
12. **INV-12 — Commit delivery is live.**
    A trusted commit both mints and first-delivers its capability; readiness
    cannot depend on a later lifecycle event occurring in one assumed order.
    - Controller RED requires one capability delivery immediately after
      `markDocumentCommitted()`, then requires `dom-ready` replay to reuse the
      exact same capability.

## Adversarial scenarios

| Scenario | Expected result | Evidence |
|---|---|---|
| ready → commit → queued stale ready → show | Stale token rejected; one fallback timer armed | INV-3 RED→GREEN |
| Old ready arrives after same-URL reload commit | Old token rejected | INV-3 / INV-6 |
| Old ready arrives between navigation start and commit | Old document may still be accepted; commit then revokes it and re-arms any pending fallback | INV-4 |
| Cancelled navigation | No commit; current readiness remains valid | INV-5 |
| Provisional load failure | No commit; current readiness remains valid | INV-5 |
| Error page commits | Old capability revoked; untrusted page receives no replacement; fallback remains available | INV-3 / INV-4 |
| Readiness intent precedes initial capability delivery | Intent latches; delivery sends READY once | INV-8 |
| Initial capability delivery precedes readiness intent | Capability latches; intent sends READY once | INV-8 |
| Commit occurs after an early/no-op replay | Commit immediately delivers the newly minted capability | INV-12 |
| Commit delivery succeeds before `dom-ready` | `dom-ready` replays the same capability; preload emits no duplicate READY | INV-8 / INV-12 |
| Renderer crashes with queued IPC | Process loss revokes token; queued ready is rejected | INV-4 / INV-6 |
| Hash/history navigation | State unchanged | INV-5 |
| Preview iframe full navigation | State unchanged | INV-5 |
| Retired D1 REGISTER arrives after D2 READY | No handler exists; D2 token/readiness/timer/callback remain unchanged | INV-7 / INV-10 |
| Duplicate capability delivery | Preload sends READY at most once for that capability | INV-8 |
| C1 delivery reaches replacement preload and READY(C1) is rejected, then C2 arrives | Persistent intent sends READY(C2) exactly once | INV-8 |
| READY(C1) invoke rejects while C1 remains current | A later C1 replay or renderer intent may retry C1 | INV-8 |
| READY(C1) invoke rejects after C2 has been signaled | C2 remains marked; later C2 replay does not duplicate READY | INV-8 |
| Forged or malformed token | Rejected | INV-6 |
| Duplicate READY for current token | Accepted idempotently; no duplicate schedule callback | INV-9 |
| Prompt is pending across commit | Timer re-armed; new document ready replays; transaction resolves once | INV-2 / INV-4 |
| READY loses a race with the next commit | Old token rejected; next document receives a new capability; fallback remains reachable | INV-2 / INV-3 |
| dispose with pending prompt or queued lifecycle event | Capability revoked, prompt resolves `later`, controller handlers removed, later forwarder no-ops | INV-11 |

## Red → green implementation sequence

1. Preserve the first-round stale-READY red→green evidence from `b768d4e91`.
2. Add the R2 controller RED for delayed D1 REGISTER after D2 READY and preload
   RED tests for intent/capability delivery in both orders.
3. Delete renderer-initiated REGISTER. Move capability creation to the
   controller's trusted main-frame commit transition.
4. Add main→preload capability delivery on top-level `dom-ready`; latch
   readiness intent in preload and keep the renderer-facing method
   zero-argument.
5. Retain main-frame `did-navigate` and independent `render-process-gone`;
   keep `did-start-navigation` absent.
6. Run focused controller/preload/main tests, the complete desktop/package
   suite, Web TypeScript, targeted Biome, and `git diff --check`.
7. Update the F273 bug report and quality-gate evidence. Commit with a Why body,
   push, and request fresh exact-HEAD review from the P2 reviewer.
8. Only after local review, cloud review, and PR CI are green, dispatch the next
   Mac arm64/x64 and Windows Installer/portable RC from that exact SHA.
9. After `.5` field logs prove the renderer never became ready, add the INV-12
   RED. Make commit create-and-first-deliver atomically, retain `dom-ready` as
   an idempotent replay, and add commit/delivery/accepted lifecycle logs before
   dispatching another RC.

## Rejected alternatives

- **Start-navigation admission window:** depends on ordering between navigation
  and IPC delivery, needs cancellation/failure/redirect window repair, and
  still lacks document identity.
- **Renderer-generated token:** lets the untrusted side choose the asserted
  identity and gives main no independent authority to compare against.
- **Renderer-initiated REGISTER for a main-generated token:** a delayed retired
  document REGISTER can still replace the live document's authority because
  frame/origin checks do not identify documents and IPC/navigation lack a
  global order.
- **Rejected-READY re-registration:** only repairs orders in which READY is
  rejected; it cannot repair a late retired REGISTER that arrives after the
  replacement READY has already been accepted.
- **Longer/reset timeout:** changes symptoms without preventing stale ready from
  suppressing fallback.
- **Renderer-owned readiness state:** duplicates the main-process lifecycle
  owner across the context-isolation boundary.
