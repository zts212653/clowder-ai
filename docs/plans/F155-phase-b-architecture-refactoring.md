# F155 Phase B: Architecture Refactoring Execution Plan

> **Status**: Design Frozen | **Feature**: F155 Scene-Based Guidance Engine
> **Created**: 2026-04-12 | **Authors**: opus, gpt52, gemini
> **Prerequisite**: PR #398 (Phase A) merged to main

## Background

Phase A shipped the complete guide engine (PR #398) but made intentional coupling trade-offs for speed:
- `route-serial.ts` / `route-parallel.ts` each carry +158 lines of guide logic
- `SystemPromptBuilder.ts` has +108 lines of guide injection
- `guideState` lives on ThreadStore thread records (same pattern as bootcampState)
- Frontend uses window CustomEvent bridge for `guide:start`, Socket.io for `guide_start/control/complete`
- `callback-guide-routes.ts` mixes state machine logic with route handlers
- `InteractiveBlock.tsx` contains guide-specific callback logic

Phase B decouples these without changing user-facing behavior.

## Scope

**In scope**: 6 architecture refactoring items + 5 supplementary decoupling points
**Out of scope**: Product expansion (new scenarios, Guide Catalog UI, progress persistence) -- deferred until architecture is stable and validated

## Implementation Steps

### B-1: GuideLifecycleService Extraction (Size: M)

**What**: Extract state machine, validation, and socket side-effects from `callback-guide-routes.ts` and `guide-action-routes.ts` into `GuideLifecycleService` / `GuideStateMachine`.

**Why first**: This creates the domain seam that all subsequent steps depend on. Without it, routing interceptor and prompt section have no clean service to delegate to.

**Files touched**:
- `packages/api/src/routes/callback-guide-routes.ts` (source)
- `packages/api/src/routes/guide-action-routes.ts` (source)
- `packages/api/src/domains/guides/GuideLifecycleService.ts` (new)
- `packages/api/src/domains/guides/GuideStateMachine.ts` (new)

**Acceptance criteria**:
- [ ] All state transitions (offered→awaiting_choice→active→completed/cancelled) live in `GuideStateMachine`
- [ ] Socket emission, validation, and access control live in `GuideLifecycleService`
- [ ] Route files are thin: parse request → call service → return response
- [ ] Existing tests pass without modification (behavior unchanged)
- [ ] New unit tests for `GuideStateMachine` state transitions (≥90% branch coverage)

**Owner**: gpt52 | **Reviewer**: opus

---

### B-2: GuideRoutingInterceptor (Size: L)

**What**: Extract guide candidate resolution, offered/completed injection, owner/fallback selection, keyword match, and completionAcked write-back from `route-serial.ts` / `route-parallel.ts` into `GuideRoutingInterceptor`.

**Contract** (two-phase design from gpt52):

```typescript
interface GuideRoutingInterceptor {
  prepare(req: {
    threadId: string;
    userId: string;
    rawUserMessage: string;
    targetCats: CatId[];
    mode: 'serial' | 'parallel';
  }): GuideRoutingDecision;

  ackVisibleCompletion(
    decision: GuideRoutingDecision,
    catId: CatId,
  ): void;
}

interface GuideRoutingDecision {
  injectionsByCatId: Map<CatId, GuidePromptContext>;
  hiddenForeignNonTerminal: boolean;
  matchedSession: GuideSessionRef | null;
  completionAckPlan: {
    sessionId: string;
    guideId: string;
    eligibleCatIds: CatId[];
  } | null;
}
```

**Constraint**: `prepare()` must be synchronous or microsecond-level (Redis round-trip OK, no external API calls). It's on the hot path of every message routing.

**Supplementary**: Selection parsing `message.match(/^引导流程：(.+)$/)` moves to `GuideOfferPolicy` (decoupling point #9).

**Files touched**:
- `packages/api/src/domains/cats/services/agents/routing/route-serial.ts` (remove ~158 lines)
- `packages/api/src/domains/cats/services/agents/routing/route-parallel.ts` (remove ~158 lines)
- `packages/api/src/domains/guides/GuideRoutingInterceptor.ts` (new)
- `packages/api/src/domains/guides/GuideOfferPolicy.ts` (new)

**Acceptance criteria**:
- [ ] `route-serial.ts` and `route-parallel.ts` contain zero direct `guideState` reads
- [ ] Routing core calls only `interceptor.prepare()` and `interceptor.ackVisibleCompletion()`
- [ ] `GuideOfferPolicy` owns keyword matching and selection parsing
- [ ] Interceptor adapter still reads from `thread.guideState` (migration in B-4)
- [ ] All existing routing tests pass; new interceptor unit tests added

**Owner**: gpt52 | **Reviewer**: opus

---

### B-3: GuidePromptSection (Size: S)

**What**: Extract 108 lines of guide injection from `SystemPromptBuilder` into `GuidePromptSection` builder, consumed via narrow `GuidePromptContext` interface.

**Files touched**:
- `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` (remove ~108 lines)
- `packages/api/src/domains/guides/GuidePromptSection.ts` (new)

**Acceptance criteria**:
- [ ] `SystemPromptBuilder` calls `GuidePromptSection.build(context: GuidePromptContext)` and appends result
- [ ] `SystemPromptBuilder` has zero knowledge of offered/awaiting_choice protocol details
- [ ] `GuidePromptContext` is the same interface consumed from B-2's `injectionsByCatId`
- [ ] Prompt output byte-for-byte identical for same inputs (regression test)

**Owner**: gpt52 | **Reviewer**: opus

---

### B-4: GuideSession Domain Object + Independent Store (Size: M)

**What**: Migrate from thread-scoped `guideState` on ThreadStore to independent `GuideSession` entity with its own repository.

**Schema**:
```typescript
interface GuideSession {
  sessionId: string;      // unique per guide activation
  threadId: string;
  userId: string;
  guideId: string;
  clientId?: string;      // for multi-tab binding (gemini input)
  state: GuideStatus;
  currentStep: number;
  offeredAt: number;
  startedAt?: number;
  completedAt?: number;
  completionAcked: boolean;
}
```

**Supplementary**: Thread read-path guide redaction moves to `GuideSessionRepository` (decoupling point #8).

**Files touched**:
- `packages/api/src/domains/guides/GuideSession.ts` (new)
- `packages/api/src/domains/guides/GuideSessionRepository.ts` (new)
- `packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts` (remove guideState field)
- `packages/api/src/routes/threads.ts` (remove redaction logic, delegate to repository)
- B-1/B-2/B-3 adapters updated to use repository instead of `thread.guideState`

**Acceptance criteria**:
- [x] `GuideSessionRepository` is the single source of truth for guide state (write path)
- [x] All new writes go through `GuideSessionStore`, not `thread.guideState`
- [x] `guideState` / `updateGuideState` on ThreadStore marked `@deprecated`
- [x] Migration path: existing `thread.guideState` auto-migrated on first read via `RedisGuideSessionStore`
- [x] Thread list/detail endpoints still sanitize via `canAccessGuideState`
- [ ] Multi-tab binding via `clientId` supported (gemini: prevent ghosting)
- [ ] **Phase B+**: Remove deprecated `guideState` field + `updateGuideState` from ThreadStore interface (requires confirming all active threads migrated)
- [ ] **Phase B+**: Remove `legacyThreadStore` fallback from `RedisGuideSessionStore`

**Owner**: opus | **Reviewer**: gpt52

---

### B-5: CustomEvent Migration to Socket.io + Zustand (Size: M)

**Pre-requisite**: GuideOverlay file split (#5 frontend half) + Z-Index integration with OverlayProvider

**What**: Remove `window.addEventListener('guide:start')` bridge. All guide events flow through Socket.io (server→client) + Zustand actions (client-side). Single reducer pattern.

**UX Defense Strategy** (from gemini):

| Risk | Mitigation |
|------|-----------|
| Multi-tab ghosting | Backend session binds `clientId`; Zustand checks `targetClientId === localClientId` |
| Animation jittering | Presence Manager layer between Zustand and React; UI waits for CSS transition completion |
| Loss of optimistic feel | Click start → local `pending_start` state → overlay opens on authoritative event |
| Dropped events | Rehydrate on thread switch / socket reconnect: pull active guide session |

**Supplementary**:
- InteractiveBlock guide callback → `guideClientActions` module (decoupling point #7)
- GuideOverlay → `guide-overlay-parts.tsx` decomposition (decoupling point #11)
- Z-Index → standard `OverlayProvider` integration (decoupling point #10)

**Files touched**:
- `packages/web/src/hooks/useGuideEngine.ts` (rewrite to single reducer)
- `packages/web/src/hooks/useSocket.ts` (remove CustomEvent bridge)
- `packages/web/src/stores/guideStore.ts` (add `reduceServerEvent`, `pendingStart`)
- `packages/web/src/components/GuideOverlay.tsx` (split + OverlayProvider)
- `packages/web/src/components/rich/InteractiveBlock.tsx` (extract to guideClientActions)

**Acceptance criteria**:
- [ ] Zero `window.addEventListener` or `window.dispatchEvent` for guide events
- [ ] All guide events enter through `guideStore.reduceServerEvent(event)` with `threadId + guideId + sessionId`
- [ ] `InteractiveBlock.tsx` has no guide-specific code; delegates to `guideClientActions`
- [ ] Presence Manager prevents animation flicker on rapid state updates
- [ ] Rehydrate works: switch thread with active guide → overlay appears
- [ ] Multi-tab: only initiating tab shows overlay

**A11y** (gemini): Focus trap allows passthrough to target elements, not dead-lock on overlay.

**Owner**: opus + gemini (design review) | **Reviewer**: gpt52

---

### B-6: Keyword Trigger Strategy Layer (Size: S)

**What**: Replace simple keyword matching with configurable strategy: confidence threshold, user dismiss-rate tracking, explicit action triggers (slash command / button).

**Why last**: This is policy, not structure. Doing it earlier mixes "architecture debt" with "match quality" — two separate concerns.

**Files touched**:
- `packages/api/src/domains/guides/GuideOfferPolicy.ts` (from B-2, extend)
- `packages/api/src/domains/guides/guide-registry-loader.ts` (confidence config)

**Acceptance criteria**:
- [ ] Each guide flow YAML can specify `triggerStrategy: { mode: 'keyword' | 'explicit' | 'hybrid', confidence?: number }`
- [ ] Dismiss-rate tracked per user per flow; suppresses re-offer after N dismissals
- [ ] Explicit triggers (slash command, button) bypass confidence threshold
- [ ] No guide hijacks normal conversation when user clearly isn't asking for help

**Owner**: gpt52 | **Reviewer**: opus

---

## Phase A Closure (Post-Merge, Before B-1)

| # | Item | Key Pitfall | Owner |
|---|------|------------|-------|
| A-1 | Remove `retreatStep` dead code | Must remove frontend + backend + protocol together, not just one end | gpt52 |
| A-2 | Add `schemaVersion` to YAML flows | Allow implicit v1 transition period, don't hard-require | gpt52 |
| A-3 | Accessibility | Focus trap must allow passthrough to target elements; focus restore after exit; aria-live throttle; reduced-motion degradation | opus |
| A-4 | Telemetry | Instrument at lifecycle transition layer, not button handlers | opus |
| A-5 | State authority documentation | Document default-thread special case; frontend Zustand is projection only | opus |

## Work Assignment Summary

| Cat | Primary | Review |
|-----|---------|--------|
| gpt52 | B-1, B-2, B-3, B-6, A-1, A-2 | B-4, B-5 |
| opus | B-4, B-5, A-3, A-4, A-5 | B-1, B-2, B-3, B-6 |
| gemini | B-5 design review (Presence Manager, OverlayProvider, UX defense) | — |

## Dependency Graph

```
Phase A Closure (A-1..A-5)
         │
         ▼
    B-1: GuideLifecycleService
         │
         ▼
    B-2: GuideRoutingInterceptor ──────┐
         │                              │
         ▼                              │
    B-3: GuidePromptSection             │
         │                              │
         ▼                              │
    B-4: GuideSession Domain ◄──────────┘
         │
         ▼
   [B-5 pre]: Overlay split + OverlayProvider
         │
         ▼
    B-5: CustomEvent → Socket.io + Zustand
         │
         ▼
    B-6: Keyword Strategy Layer
```

## Validation Strategy

Each step follows TDD (red → green → refactor):
1. Write failing tests against new interface
2. Implement minimum to pass
3. Verify existing tests still pass (behavior unchanged)
4. `pnpm check` + `pnpm lint` green

Final validation after B-6:
- [ ] `pnpm test` all green
- [ ] `route-serial.ts` and `route-parallel.ts` contain zero guide-specific logic
- [ ] `SystemPromptBuilder.ts` contains zero guide-specific logic
- [ ] `ThreadStore` has no `guideState` field
- [ ] Zero `window.addEventListener`/`dispatchEvent` for guide events
- [ ] `InteractiveBlock.tsx` has no guide-specific code
- [ ] All guide logic lives under `packages/api/src/domains/guides/` and `packages/web/src/domains/guides/`
