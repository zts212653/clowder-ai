# ADR-023: F160 Journey — Naming Pivot + Activity Event Spine

**Status:** Implemented (Phase A-E)  
**Date:** 2026-04-15 (updated 2026-04-16)  
**Authors:** opus (布偶猫), gpt52 (缅因猫), gemini (暹罗猫), sonnet (布偶猫)  
**Supersedes:** Original F160 "Cat Growth RPG" naming

## Context

F160 Phase A-C implemented a six-dimensional profiling system with XP, levels,
achievements, and radar charts. External review (Issue #480) correctly identified
that calling this "Growth" oversteps what the system actually does — it visualizes
collaborative activity, not agent capability emergence.

After team discussion (architecture + design + product), we converge on:

> **This is not a growth system. It's a journey record.**  
> The system observes and visualizes collaborative activity footprints.  
> Growth (capability emergence via memory) belongs to F102/F152.

## Decision 1: Naming Pivot

### Feature-level

| Old | New (zh) | New (en) |
|-----|----------|----------|
| Cat Growth RPG | **猫猫足迹** | **Cat Journey** |

### Sub-concept mapping

| Old (RPG) | New (Journey) | Rationale |
|-----------|---------------|-----------|
| XP / Experience Points | **足迹点 / Footfall** | Observable trace, not reward |
| Level (Lv.3) | **历练 / Seasoning** ("步履 · 第三阶") | Depth of participation |
| Achievement | **珍贵瞬间 / Moments** | Noteworthy milestones, not trophies |
| Growth Radar Chart | **特质画像 / Traits Portrait** | Personality profile, not stat sheet |
| Growth Dimension | **Trait Axis** | Activity distribution axis |
| GrowthService | **JourneyService** | Code-level rename |
| GrowthOverview | **JourneyOverview** | Code-level rename |
| CatGrowthProfile | **CatJourneyProfile** | Code-level rename |
| GrowthDimension | **TraitDimension** | Code-level rename (values unchanged) |

### Visual progression (Seasoning tiers)

| Tier | Label | Visual |
|------|-------|--------|
| 1-2 | 浅印 (light print) | Faint paw prints |
| 3-5 | 深印 (deep print) | Solid paw prints |
| 6+ | 铭刻 (engraving) | Embossed / gold paw prints |

### What does NOT change

- Dimension values: `architecture | review | aesthetics | execution | collaboration | insight`
- Level formula: `floor(sqrt(xp / 100))`
- XP amounts per source
- Achievement unlock conditions
- Redis key structure (prefix changed from `growth:` to `journey:`, no migration needed)

## Decision 2: Activity Event Spine

### Problem

`awardXp()` calls are scattered across 8 files in the transport/route layer,
coupling product logic to request handling. GrowthService and F075
leaderboard-service both consume similar signals through separate ingestion paths.

### Architecture

```
Route / Hook layer
    │ emit ActivityEvent (facts only — no business logic)
    │
    ▼
ActivityEventBus (in-process EventEmitter, no persistence)
    ├─→ JourneyProjector      → cat footfall, traits, bonds, titles, moments
    ├─→ LeadershipProjector   → co-creator leadership footfall + shadow calibration (Phase D)
    ├─→ LeaderboardProjector  → rankings, badges, stats (F075)
    ├─→ ToolUsageProjector    → tool analytics (F150)
    └─→ MemoryProjector       → high-value events → F102 evidence
```

### ActivityEvent schema

```typescript
/** Unified activity event — source of truth for all projectors. */
export interface ActivityEvent {
  /** Event type discriminator */
  readonly type: ActivityEventType;
  /** Cat ID or 'co-creator' */
  readonly actorId: string;
  /** ISO 8601 timestamp */
  readonly timestamp: string;
  /** Thread context */
  readonly threadId?: string;
  /** Freeform metadata per event type */
  readonly metadata: Record<string, unknown>;
}

export type ActivityEventType =
  // ── Cat activity events ─────────────────────────
  | 'tool_used'                      // metadata: { toolName, category }
  | 'task_completed'                 // metadata: { clarificationCount, interventionCount }
  | 'message_sent'                   // metadata: { intent? }
  | 'review_submitted'               // metadata: { findings? }
  | 'bug_caught'                     // metadata: {}
  | 'multi_mention_dispatched'       // metadata: { targetCatIds }
  | 'multi_mention_completed'        // metadata: { targetCatId, success } (per-responder)
  | 'multi_mention_request_completed' // metadata: { successCount, targetCount, isDeepCollab }
  | 'deep_collab_completed'          // metadata: { participants }
  | 'a2a_handoff_completed'          // metadata: { fromCatId, toCatId }
  | 'evidence_cited'                 // metadata: {}
  | 'session_sealed'                 // metadata: { clarificationCount }
  | 'rich_block_created'             // metadata: { blockKind }
  | 'design_feedback_given'          // metadata: {}
  // ── Phase D6: Co-creator leadership events ──────
  | 'clarification_requested'        // Cat asked co-creator for missing info
  | 'decision_confirmed'             // Co-creator confirmed direction via interactive block
  | 'feedback_applied';              // Co-creator feedback adopted (future: task chain)
```

### Emission points

Events are emitted by routes/hooks as **facts** (what happened), not interpretations:

| Event | Emission point | Notes |
|-------|---------------|-------|
| `tool_used` | `route-serial.ts`, `route-parallel.ts` | On every tool_use message |
| `task_completed` | `callbacks.ts` | On task status → completed |
| `message_sent` | `callbacks.ts` | On assistant message append |
| `review_submitted` | `callbacks.ts` | On review-intent invocation completion |
| `bug_caught` | `callbacks.ts` | When review finds actionable issue |
| `multi_mention_dispatched` | `callback-multi-mention-routes.ts` | Once per dispatch |
| `multi_mention_request_completed` | `callback-multi-mention-routes.ts` | Once per flushResult |
| `deep_collab_completed` | `callback-multi-mention-routes.ts` | When 3+ cats succeed |
| `evidence_cited` | `route-serial.ts` | On search_evidence tool use |
| `session_sealed` | `session-hooks.ts` | On session seal |
| `rich_block_created` | `route-serial.ts` | On create_rich_block tool use |
| `clarification_requested` | `route-serial.ts`, `route-parallel.ts` | On AskUserQuestion tool use |
| `decision_confirmed` | `message-actions.ts` | On confirm-type interactive block selection |
| `feedback_applied` | *(no emitter yet)* | Type reserved for future task chain detection |

### Projector responsibilities

**JourneyProjector** — translates activity events into cat trait footfall:
- Maps events to `FootfallSource` via configurable rules
- Handles Phase E observability bonuses (cache efficiency, intent boost, error recovery, fast execution) when upstream metadata is available
- Awards footfall to individual cats based on `actorId`

**LeadershipProjector** (Phase D) — translates activity events into co-creator leadership footfall:
- Coordination: `multi_mention_dispatched` → dispatch XP, `multi_mention_request_completed` → success/diversity/deep_collab XP
- Delegation: `task_completed` with zero interventions → autonomy XP
- Exploration: `tool_used` with mcp/skill category → breadth XP
- Guidance: `task_completed` with zero clarifications → one-shot XP, `session_sealed` with low clarifications → guidance XP
- Decision (shadow): `decision_confirmed` → explicit direction XP, `task_completed` with low clarifications → proxy direction XP
- Feedback (shadow): `review_submitted` → proxy feedback XP, `clarification_requested` → audit trail only (1 XP for D7 calibration)

**MemoryProjector** — forwards high-value activity events to F102 EvidenceStore:
- Always promote: `deep_collab_completed` → discussion, `bug_caught` → lesson, `evidence_cited` → research
- Conditionally promote: `review_submitted` (when `hasFindings`), `decision_confirmed` (when `threadId` present), `feedback_applied` (always when emitted)
- Uses semantic anchor keys for upsert idempotency (e.g. `activity-decision-{blockId}`, `activity-collab-{threadId}-{sessionId}`)
- Template-based summaries; emitter-supplied `metadata.summary` overrides default

### Shadow dimension calibration (D7 gate)

Decision and feedback dimensions run as **shadow scores** — recorded in Redis
(`leadership:decision`, `leadership:feedback`) and the audit trail
(`leadership:audit`), but flagged `shadow: true` and excluded from the displayed
`leadershipLevel`.

**Explicit vs proxy coexistence:**
- Proxy events use source keys like `direction_confirmed` (inferred from task metadata)
- Explicit events use separate source keys like `direction_confirmed_explicit` (from UI confirm blocks)
- Both land in the same audit sorted set with distinguishable `source` fields
- D7 compares proxy vs explicit distributions to evaluate proxy accuracy before transition

**D7 transition criteria (proposed):**
- ≥100 explicit events per shadow dimension (excluding proxies)
- Proxy vs explicit directional correlation >0.7
- ≥2 weeks of natural usage data
- Calibration report reviewed by co-creator before promotion

### Relationship to existing `POST /api/leaderboard-events`

The existing leaderboard events endpoint accepts external events (git stats,
game results). The Activity Event Spine handles **internal** events emitted by
the application itself. The two converge at the projector level — both
LeaderboardProjector and JourneyProjector can consume from either source.

**Current state:** In-process EventEmitter, no persistence.  
**Future:** Optionally persist events to enable replay/recomputation.

### Migration path for awardXp

Each `awardXp()` call site becomes an `activityBus.record()`:

```typescript
// Before (route-serial.ts)
deps.growthService.awardXp(msg.catId, source);

// After
deps.activityBus.record('tool_used', msg.catId, { toolName, category });
```

JourneyProjector subscribes and translates events to footfall awards internally.

### Co-creator identity

**Current implementation:** `actorId = 'co-creator'` string constant, used directly
in `LeadershipService` and `GrowthService`. The co-creator is configured in
`cat-config.json` with mention patterns (`@co-creator`, `@铲屎官`) managed by
`runtime-cat-catalog.ts`.

**Registry status:** Co-creator is not yet a first-class `catRegistry` entry.
The registry (F127) manages cat identities; co-creator bypasses it via hardcoded
paths in `GrowthService.getProfile()` and `LeadershipService`.

**Alignment path:**
1. *(Done)* Co-creator mention patterns configurable in `cat-config.json`
2. *(Done)* `LeadershipService` operates independently with `'co-creator'` actor
3. *(Future)* F127 registry evolves to support a `participant` type that includes
   both cats and co-creator, eliminating special-case paths

This is a **registry evolution** question, not a F160 question. F160 consumes
whatever identity model exists; it doesn't define one.

### Memory promotion rules (F102 integration boundary)

Not all events merit memory crystallization. Rules:

| Event | Promote to F102? | Condition |
|-------|------------------|-----------|
| `deep_collab_completed` | Yes | Always — rare, high signal |
| `bug_caught` | Yes | Always — learning moment |
| `evidence_cited` | Yes | Always — knowledge reuse |
| `review_submitted` | Maybe | Only if review contains actionable findings |
| `decision_confirmed` | Maybe | Only explicit (confidence=1.0) decisions with thread context |
| `clarification_requested` | No | High frequency, low individual signal |
| `feedback_applied` | Yes | When implemented — feedback adoption is high-value knowledge |
| `tool_used` | No | Too noisy |
| `message_sent` | No | Too noisy |
| `session_sealed` | No | Lifecycle event, not knowledge |
| `multi_mention_*` | No | Coordination mechanics, not knowledge |

MemoryProjector applies these filters before forwarding to F102 EvidenceStore.
Implemented in `packages/api/src/domains/activity/MemoryProjector.ts`.

## Consequences

- **Positive:** Clean separation of concerns. Routes emit facts, projectors
  interpret meaning. New consumers (e.g. future analytics) just subscribe.
- **Positive:** Naming accurately reflects what the system does.
- **Positive:** Shadow dimension mechanism allows safe iteration on new
  leadership dimensions without affecting user-visible stats.
- **Negative:** Significant rename across ~26 files. Mechanical but tedious.
- **Done:** Redis keys use `journey:` prefix (no legacy `growth:` data to migrate).
- **Risk:** `feedback_applied` has no emitter yet — the full feedback chain
  (co-creator feedback → cat code change → verification) requires future work.
  Candidate approaches: review-fix cycle detection via PR tracking, task chain
  linking, or explicit co-creator confirm block after cat applies feedback.
