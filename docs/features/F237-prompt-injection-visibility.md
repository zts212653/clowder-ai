---
feature_ids: [F237]
related_features: [F203, F153, F180, F190, F199, F206]
topics: [system-prompt, injection, visibility, console, settings, trust, governance, hook-pipeline, lifecycle, trace]
doc_kind: spec
created: 2026-06-02
updated: 2026-06-25
---

# Prompt Injection Visibility

> **Status**: Phase 1 done (clowder-ai#859 via cat-cafe#2505 `b859eb38`) · Phase 2 design in progress | **Owner**: Ragdoll Opus 4.6
> **Issue**: [#839](https://github.com/zts212653/clowder-ai/issues/839)
> **Feature ID**: F237 (assigned by maintainer; branch/PR retain original naming)

## Why

### Motivating Example

Thread `[thread-id]`: opus47 was dragged off-task by a startup hook's hygiene warning, dropping a review ball. Root cause: no visibility into what's injected into agent prompts, no way to audit or prioritize competing injections.

### Problem

Cat Cafe's 52 prompt injection segments are invisible infrastructure — scattered across 7 source files (`SystemPromptBuilder.ts`, `route-serial.ts`, `route-helpers.ts`, shell hooks, etc.) with no unified inventory or Console visibility. Operators can't:
1. See what's being injected into agent prompts
2. Audit why a cat behaved a certain way
3. Customize the segments designed for customization

### Trust Model

| Current: Mythic Trust | Target: Epistemic Trust |
|---|---|
| "Cat seems reliable" | "When cat fails, I can see why and fix it" |
| Black box | Transparent, auditable |

## What — Phase 1 Deliverables (PR #859)

### 1. Lifecycle Viewer

Nested flow diagram in Console showing all 52 injection segments across session/turn/event stages. Visual-only — no runtime abstraction.

- Safety badges: readonly / editable per segment
- Segment counts per stage
- Source type labels (template / config-driven / conditional)
- Preview point indicator on client-invoke stage

### 2. Template Extraction

25+ inline prompt strings moved from TypeScript to external `.md`/`.yaml` files under `assets/prompt-templates/`. Same content, same compiled output, zero behavior change. Enables `git diff` on plain text and Console content display.

| Segment | Template File | Editable |
|---------|--------------|----------|
| S6 Workflow Triggers | `workflow-triggers.yaml` | Yes (`.local.yaml` overlay) |
| S13 MCP Tools | `mcp-tools.md` | Yes (`.local.md` overlay) |
| C1 MCP Callback | `c1-mcp-callback.md` | Yes (`.local.md` overlay) |
| D8 A2A Ball Check | `a2a-ball-check.md` | No (readonly) |
| D21 Handoff Decision Tree | `handoff-decision-tree.md` | No (readonly) |
| L1-L7 L0 Sections | `l1-*.md` through `l7-*.md` | No (readonly) |
| S1, S2, S8, D1, etc. | Various `.md` files | No (readonly) |

### 3. Display-Only Manifest

`assets/prompt-injection-manifest.yaml` — lists all 52 segments with 3 display flags:

| Flag | Purpose | Values |
|------|---------|--------|
| `safetyTier` | Can the operator edit? | readonly / limited-edit / editable |
| `allowLocalOverride` | Does the API accept writes? | true (3 segments) / false (49 segments) |
| `transparencyTier` | Visibility level in Console | visible-by-default / opt-in-view / debug-only |

Not a runtime schema. Not loaded by the prompt builder. Only consumed by Console UI for badge rendering. Drift checked by `scripts/check-manifest-drift.mjs`.

### 4. Three-Segment Overlay Editor

Console UI for the 3 segments that already had `.local` overlay patterns:

- **S6** workflow-triggers.local.yaml
- **S13** mcp-tools.local.md
- **C1** c1-mcp-callback.local.md

Security model:
- Auth: session cookie (401) + owner gate (403) — matches `capability-write-guards.ts`
- YAML validation on all write paths (`validateYamlStringMapping`)
- Auto-backup to `.bak` before every save
- 49/52 segments reject writes with 403

### 5. Compiled Preview

Modal showing assembled prompt per cat, labeled "approximate". Selectable by cat from a dimension selector.

## What's NOT in Phase 1

- No changes to L0 prompt **content** or `compile-system-prompt-l0.mjs` **logic**
- No lifecycle runtime abstraction — diagram is visual only
- No arbitrary segment editability — only 3 pre-existing `.local` segments
- No hook toggle/disable/demotion (separate follow-up)
- No multi-version overlay support

## Prompt Surfaces Reference

| Layer | Source | Segment IDs |
|-------|--------|-------------|
| Compile-time L0 | `compile-system-prompt-l0.mjs` | L1-L7 |
| Session-level Builder | `buildStaticIdentity()` | S1-S13 |
| Per-turn Builder | `buildInvocationContext()` | D1-D21 |
| Route assembly | `route-serial.ts` / `route-parallel.ts` | R1-R2 |
| Invocation mutators | `invoke-single-cat.ts` | M1-M2 |
| Session continuity | `SessionBootstrap.ts` | B1 |
| MCP fallback | `McpPromptInjector.ts` | C1 |
| Navigation | `route-helpers.ts` | N1 |
| External hooks | shell hooks | H1-H3 |

## Acceptance Criteria — Phase 1

- [x] AC-1: Manifest YAML covers all prompt surfaces (52 segments)
- [x] AC-2: Each segment has `safetyTier`, `allowLocalOverride`, `transparencyTier` display flags
- [x] AC-3: `GET /api/prompt-injection/manifest` returns manifest
- [x] AC-4: `check-manifest-drift.mjs` validates manifest-to-code alignment (CI)
- [x] AC-5: Template extraction — 25+ segments from inline to external files, compiled output identical
- [x] AC-6: Console lifecycle viewer with all 52 segments, safety badges, segment counts
- [x] AC-7: 3-segment overlay editor with session+owner auth, YAML validation, backup
- [x] AC-8: Compiled preview modal per cat
- [x] AC-9: Per-cat dimension selector
- [x] AC-10: Malformed YAML overlay graceful fallback

## What — Phase 2: Hook Pipeline + Injection Trace

### Motivation

Phase 1 delivered visibility — operators can see what's injected. Phase 2 makes injections **self-contained, dynamically manageable, observable, and versionable**. The goal: each of the 52 segments becomes an independently addressable hook that can be added, modified, disabled, versioned, and traced without code changes — the data foundation for automated iteration.

### Why Hook Pipeline

The current `SystemPromptBuilder` assembles segments via manual `if/push` patterns:

```typescript
/* @segment D5 */ if (context.pingPongWarning) {
  const d5 = renderSegment('D5', vars);
  if (d5) lines.push(d5);
}
```

This pattern has served well for 52 segments, but makes several operations hard:

| Operation | Current Cost | With Hook Pipeline |
|-----------|-------------|-------------------|
| Disable a segment | Find code, comment out, deploy | `enabled: false` in manifest |
| Try a new version | Branch + code change + PR | Add v2 template, switch in manifest |
| Roll back | Revert commit + deploy | Switch version pointer |
| Know what fired | Read source + infer from logs | InjectionTrace record per turn |
| Add a new segment | Write code + template + manifest + tests | Template + manifest entry |
| Remove a segment | Find and delete code + template | `enabled: false`, then delete at leisure |

**This is not "freezing dynamic injections into static claims"** — this is making dynamic injections *declaratively manageable*. The YAML manifest describes registration metadata (stage, enabled, version, dependencies), not content policy. Content lives in templates and code resolvers, exactly as today. The difference: lifecycle operations (enable/disable/version/trace) become data operations, not code operations.

**Why this makes Build-to-Delete easier, not harder**: The maintainer's concern was that metadata turns deletion into deprecation. The opposite is true — currently, deleting a segment requires finding all code paths (condition, variable setup, render call, push), verifying no side effects, removing the template, updating the manifest display entry, and testing. With hooks: set `enabled: false`, the segment stops firing immediately. The code and template can be deleted at leisure in a cleanup pass, or left dormant with zero runtime cost. Build-to-Delete becomes a config toggle followed by optional cleanup.

**Why this is the foundation for "injections grow from trajectories"**: The maintainer wants injections to grow organically from per-user taste, cross-thread repetition signal, and CVO correction. For that, the system needs to:
1. **Trace** which segments fired per turn and what content they produced
2. **Correlate** segment combinations with turn outcomes
3. **Iterate** — try new versions, compare, promote or demote

Without a hook pipeline, there's no structured trace data, no version identity, and no way to correlate "segment X contributed to outcome Y." The hook pipeline is the measurement substrate that trajectory-based growth requires.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     ContextAssembler                            │
│  (centralized IO: queries stores, builds typed AssemblerInput)  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ AssemblerInput
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       HookPipeline                              │
│                                                                 │
│  Stage 1: compile-time   L1-L7 (observe only, content via L0)  │
│  Stage 2: session-init   S1-S13 (buildStaticIdentity hooks)    │
│  Stage 3: per-turn       D1-D21, B1 (buildInvocationContext)   │
│  Stage 4: client-invoke  C1, N1, R1-R2 (route assembly hooks)  │
│  Stage 5: event-hook     H1-H3 (shell hooks — observe only)    │
│                                                                 │
│  Each stage: iterate registered hooks → condition → resolve     │
│            → emit PromptPatch + TraceEvent                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ PromptPatch[] + TraceEvent[]
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Transport Assembly                           │
│  (OUTSIDE pipeline — independent injection mechanics)           │
│                                                                 │
│  injectSystemPrompt decision (resume/force/registryChanged)     │
│  stagingPrepend (ADR-038, every-turn)                           │
│  contextHintPrefix (F225, every-turn)                           │
│  missionPrefix (F070, external project dispatch)                │
│  M2 transcriptPathHints (always appended)                       │
└─────────────────────────────────────────────────────────────────┘
```

### The 5 Stages Are Clock Signals, Not Extension APIs

A critical design decision: stages are **clock signals** (when things happen), not **rigid extension surfaces** (what can happen). Each stage is a point in the session/turn lifecycle where registered hooks execute. The stage contract is:

- **Input**: `AssemblerInput` — typed context data gathered by ContextAssembler
- **Output**: `PromptPatch[]` + `TraceEvent[]` — content contributions and observability records

Stages don't define what hooks can do — hooks define what they do. Adding a new hook to an existing stage doesn't require a new interface. Adding a new stage (if ever needed) doesn't break existing hooks.

This addresses the maintainer's concern about "pre-freezing an N-stage pipeline locks the extension surface." The stages are:

| Stage | Clock Signal | When | Current Segments |
|-------|-------------|------|-----------------|
| `compile-time` | L0 compilation | Build / first load | L1-L7 (observe only) |
| `session-init` | New session / re-injection | Session start or force | S1-S13 |
| `per-turn` | Every invocation | Before model call | D1-D21, B1 |
| `client-invoke` | Route assembly | Per-route finalization | C1, N1, R1-R2 |
| `event-hook` | Shell hook fire | SessionStart/Stop/PostCompact | H1-H3 (observe only) |

These 5 stages map to the existing code execution points — they're not invented abstractions. `buildStaticIdentity()` already IS `session-init`. `buildInvocationContext()` already IS `per-turn`. The pipeline makes the implicit explicit.

### HookManifest — Self-Contained Segment Definition

Each hook is defined by a YAML manifest (registration metadata) + optional code resolver (condition + variable setup) + template file (content). Following the `PluginRegistry` pattern (F202):

```yaml
# assets/prompt-hooks/D5-ping-pong-warning/hook.yaml
id: D5
name: 乒乓球警告
stage: per-turn
version: 1
enabled: true

# Content resolution
template: d5-ping-pong-warning.md          # existing Phase 1 template
resolver: D5PingPongResolver               # code resolver class name (optional)

# Dependencies — what AssemblerInput fields this hook reads
inputs:
  - pingPongWarning                        # field name on AssemblerInput

# Classification (Phase 1 3-axis, carried forward)
safetyTier: limited-edit
transparencyTier: visible-by-default
governanceTier: human-gated

# CVO-facing
userExplanation: "当两只猫连续互传 ≥2 轮时警告，避免死循环"
```

**Key properties:**
- `id` — stable segment identifier (S1, D5, etc.), matches Phase 1 manifest
- `stage` — which clock signal triggers this hook
- `version` — integer, enables v1→v2 migration without deleting v1
- `enabled` — boolean, the Build-to-Delete toggle
- `template` — path to content template (reuses Phase 1 extracted templates)
- `resolver` — optional TypeScript class that evaluates condition and prepares template variables. Hooks without a resolver are unconditional (always fire when stage fires)
- `inputs` — declares which `AssemblerInput` fields the resolver reads. Enables dependency analysis and makes each hook's data requirements explicit

**Migration from Phase 1:** Each of the 52 `@segment` annotations in `SystemPromptBuilder.ts` becomes a `hook.yaml` + its existing template file. The resolver code is extracted from the inline `if/push` pattern. Zero content change, zero behavior change — same transformation principle as Phase 1's template extraction.

### HookRegistry — Scan, Register, Resolve

Modeled on `PluginRegistry` (scan directory, parse manifests, validate, derive status):

```typescript
interface HookRegistry {
  /** Scan hook directory, parse manifests, validate, register */
  scan(): HookManifest[];
  
  /** Get hooks for a specific stage, ordered by priority */
  getStageHooks(stage: HookStage): RegisteredHook[];
  
  /** Get single hook by ID */
  getHook(hookId: string): RegisteredHook | undefined;
  
  /** All registered hooks */
  getAllHooks(): RegisteredHook[];
  
  /** Runtime enable/disable (persists to manifest) */
  setEnabled(hookId: string, enabled: boolean): void;
  
  /** Switch active version */
  setVersion(hookId: string, version: number): void;
}

interface RegisteredHook {
  manifest: HookManifest;
  resolver: HookResolver | null;     // null = unconditional, always fires
  template: string;                   // raw template content
}
```

**Directory structure:**

```
assets/prompt-hooks/
├── S1-identity/
│   ├── hook.yaml
│   └── s1-identity.md                 # existing Phase 1 template (symlink or move)
├── D5-ping-pong-warning/
│   ├── hook.yaml
│   ├── d5-ping-pong-warning.md
│   └── d5-ping-pong-warning.v2.md     # version 2 template (future)
├── D8-a2a-ball-check/
│   ├── hook.yaml
│   └── a2a-ball-check.md
└── ...
```

### ContextAssembler — Centralized IO

Today, `buildInvocationContext()` receives a 30+ field `InvocationContext` bag where each field is consumed by exactly one segment (e.g., `pingPongWarning` → D5, `crossThreadReplyHint` → D4). The data comes from route-layer queries scattered across `route-serial.ts`, `route-parallel.ts`, and `route-helpers.ts`.

ContextAssembler centralizes this:

```typescript
interface ContextAssembler {
  /** 
   * Gather all inputs needed by active hooks for this stage.
   * Route-layer calls this once; hooks never do their own store queries.
   */
  assemble(stage: HookStage, baseContext: BaseContext): Promise<AssemblerInput>;
}

/** BaseContext = what the route layer already has (catId, threadId, userId, sessionId, etc.) */
interface BaseContext {
  catId: CatId;
  threadId: string;
  userId: string;
  sessionId: string | null;
  dispatch: EffectiveDispatch;
  // ... other route-layer provided values
}

/** AssemblerInput = typed bag of everything hooks might need */
interface AssemblerInput extends BaseContext {
  // Session-init stage inputs
  catConfig: CatConfig;
  mcpAvailable: boolean;
  packBlocks: PackBlocks | null;
  callableMentions: MentionInfo;
  
  // Per-turn stage inputs
  directMessageFrom: CatId | null;
  crossThreadReplyHint: CrossThreadHint | null;
  pingPongWarning: string | null;
  teammates: TeammateInfo[];
  routeMode: RouteMode;
  // ... all current InvocationContext fields, typed
}
```

**Why centralize IO:** Hooks that query stores directly become impossible to test, trace, or mock. By gathering all inputs upfront, we get:
1. **Testability** — unit test any hook with a synthetic `AssemblerInput`
2. **Trace completeness** — the trace record can include which inputs were present
3. **Performance** — one round of queries per stage, not per hook

### Hook Execution Model

Each hook produces `PromptPatch` (content) + `TraceEvent` (observability). No direct context mutation in Phase 2:

```typescript
interface HookResolver {
  /** 
   * Evaluate whether this hook should fire and prepare template variables.
   * Returns null if the hook should be skipped this turn.
   */
  resolve(input: AssemblerInput): HookResolveResult | null;
}

interface HookResolveResult {
  /** Template variables for renderSegment() */
  vars: Record<string, string>;
  /** Optional: override which template version to use */
  templateVersion?: number;
}

/** What a hook produces after resolution + template rendering */
interface PromptPatch {
  hookId: string;
  stage: HookStage;
  content: string;           // rendered template content
  position: 'append';        // Phase 2: append only. Future: prepend, replace
}

interface TraceEvent {
  hookId: string;
  stage: HookStage;
  fired: boolean;             // did the resolver return non-null?
  reason: string;             // why fired or skipped (e.g., "pingPongWarning present")
  contentHash: string;        // SHA-256 of rendered content (not full text)
  tokenEstimate: number;      // approx token count of rendered content
  version: number;            // which version of the hook fired
  durationMs: number;         // resolver execution time
}
```

**Pipeline execution per stage:**

```
for each registered hook in stage (ordered by manifest priority):
  1. Check hook.enabled → skip if false (TraceEvent: fired=false, reason="disabled")
  2. If hook has resolver → call resolver.resolve(input)
     - Returns null → skip (TraceEvent: fired=false, reason=resolver.skipReason)
     - Returns result → continue
  3. If hook has no resolver → unconditional (always fire)
  4. Render template with vars → PromptPatch
  5. Emit TraceEvent (fired=true, contentHash, tokenEstimate)
```

### InjectionTrace — Lightweight Per-Turn Persistence

After each turn, persist a lightweight `InjectionTraceRecord` — not the full `AssemblerInput` or rendered content:

```typescript
interface InjectionTraceRecord {
  turnId: string;
  sessionId: string;
  threadId: string;
  catId: string;
  timestamp: number;
  
  /** Per-hook trace, one entry per registered hook (fired or skipped) */
  hooks: TraceEvent[];
  
  /** Aggregate stats */
  totalTokens: number;
  totalHooksFired: number;
  totalHooksSkipped: number;
  totalDurationMs: number;
}
```

**Persistence strategy:**
- Store to Redis with TTL (configurable, default 7 days) keyed by `injection-trace:{threadId}:{turnId}`
- SessionContext holds only `currentTurnId` + `previousTurnId` references, not full trace data
- Console can query trace history per thread for debugging: "which hooks fired on turn N?"
- Future eval loop reads trace data to correlate segment combinations with outcomes

**Why lightweight:** Full `AssemblerInput` contains runtime objects, config snapshots, and transient state that's expensive to serialize and rarely needed for analysis. The trace record captures what matters for iteration: *which hooks fired, why, with what content fingerprint, at what cost*.

### Transport Assembly Boundary

The following injection mechanics stay **OUTSIDE** the hook pipeline. They are transport-layer concerns, not content-production concerns:

| Mechanism | Location | Why Outside |
|-----------|----------|-------------|
| `injectSystemPrompt` decision | `invoke-single-cat.ts:1639` | Complex resume/force/registry logic that determines WHETHER static identity is sent, not WHAT content to produce |
| `stagingPrepend` | `invoke-single-cat.ts:1674` | ADR-038 contract: "每轮注入生效", independent of prompt content |
| `contextHintPrefix` | `invoke-single-cat.ts:1661` | F225: context management, independent of prompt assembly |
| `missionPrefix` | `invoke-single-cat.ts:1650` | F070: external project dispatch context |
| `M2 transcriptPathHints` | `invoke-single-cat.ts:1680` | Always-appended path hints |

Transport assembly order remains: `stagingPrepend → contextHintPrefix → (systemPrompt + missionPrefix + invocationContext) → M2`.

The hook pipeline produces the **systemPrompt** (from session-init hooks) and **invocationContext** (from per-turn hooks). Transport assembly decides how to deliver them. This separation means:
- The pipeline can evolve content independently of delivery mechanics
- Transport assembly can change (e.g., new prepend layers) without touching hooks
- The `injectSystemPrompt` decision (resume vs force-reinjection) stays clean — it's a delivery decision, not a content decision

### L1-L7 Observation Strategy

L1-L7 segments are compiled at build time by `compile-system-prompt-l0.mjs`, not at runtime. They're frozen into `system-prompt-l0.md` and injected as a monolithic block. The hook pipeline **observes** them but doesn't **produce** them:

- L1-L7 hooks are registered in the `compile-time` stage with `observeOnly: true`
- They don't have resolvers or templates — their content comes from the L0 compiler
- TraceEvents for L1-L7 record: present/absent, content hash of compiled L0 section, token estimate
- This enables the trace record to cover ALL 52 segments, even though only ~40 are produced at runtime

### Versioning Model

Each hook can have multiple template versions:

```
assets/prompt-hooks/D5-ping-pong-warning/
├── hook.yaml                          # version: 2 (active)
├── d5-ping-pong-warning.md            # v1 template
└── d5-ping-pong-warning.v2.md         # v2 template (active)
```

Version lifecycle:
1. **Create** — add `hookname.v2.md` template alongside v1
2. **Activate** — update `version: 2` in `hook.yaml`
3. **Roll back** — set `version: 1` in `hook.yaml`
4. **Archive** — delete old version template when confident

The resolver receives the active version and renders the corresponding template. TraceEvent records which version fired, enabling comparison of v1 vs v2 outcomes.

### What Phase 2 Does NOT Include

- **Eval feedback loop** — automated analysis of trace data to score/iterate segments. This is Phase 3, consuming Phase 2's trace infrastructure
- **Context mutation** — hooks producing side effects beyond PromptPatch (e.g., modifying session state). Future capability tier
- **Arbitrary segment editability** — the 3-segment `.local` overlay pattern from Phase 1 continues. Phase 2 doesn't expand the editable set
- **Custom user hooks** — operators can't register their own hooks yet. This requires security model design beyond Phase 2's scope
- **L0 compiler integration** — L1-L7 remain compiled by `compile-system-prompt-l0.mjs`. Hook pipeline observes but doesn't replace the compiler

### Landing Order

Phase 2 implementation in 4 sub-phases, each independently shippable:

| Sub-phase | Deliverable | Tests |
|-----------|------------|-------|
| **P2-A: HookManifest + Registry** | Hook YAML schema, directory scan, manifest parsing. No runtime wiring — just the registry that can list all hooks | Schema validation tests, scan tests (following PluginRegistry test pattern) |
| **P2-B: ContextAssembler + Resolvers** | Extract resolver logic from `SystemPromptBuilder.ts` `if/push` patterns into standalone resolver classes. ContextAssembler gathers inputs. Dual-path: old code path + new pipeline produce identical output | Snapshot tests: old output === new output for every segment |
| **P2-C: Pipeline Execution** | Wire HookPipeline into `buildStaticIdentity()` and `buildInvocationContext()` as the primary code path. Remove old `if/push` patterns | Integration tests: compiled output identical. Regression: all existing tests pass |
| **P2-D: InjectionTrace** | TraceEvent emission, InjectionTraceRecord persistence, Console trace viewer | Trace record completeness tests. Console: can view which hooks fired per turn |

## Acceptance Criteria — Phase 2

- [ ] AC-P2-1: HookManifest YAML schema defined, validated by `check-hook-manifest.mjs`
- [ ] AC-P2-2: HookRegistry scans `assets/prompt-hooks/`, parses all 52 hook manifests
- [ ] AC-P2-3: ContextAssembler produces typed `AssemblerInput` from route-layer queries
- [ ] AC-P2-4: All 52 resolvers extracted from `SystemPromptBuilder.ts` into standalone classes
- [ ] AC-P2-5: Dual-path validation: old `if/push` output === new pipeline output for all segments (snapshot tests)
- [ ] AC-P2-6: `buildStaticIdentity()` and `buildInvocationContext()` delegate to HookPipeline
- [ ] AC-P2-7: Each hook execution produces TraceEvent (fired/skipped, reason, contentHash, tokenEstimate)
- [ ] AC-P2-8: InjectionTraceRecord persisted per turn (Redis, TTL configurable)
- [ ] AC-P2-9: Console trace viewer: query which hooks fired per turn per thread
- [ ] AC-P2-10: Hook versioning: v1→v2 switch via manifest, TraceEvent records version
- [ ] AC-P2-11: Hook enable/disable: `enabled: false` stops hook from firing, TraceEvent records skip reason
- [ ] AC-P2-12: Transport assembly (staging/contextHint/missionPrefix/M2) unchanged, not in pipeline
- [ ] AC-P2-13: L1-L7 observe-only hooks emit TraceEvents without producing content
- [ ] AC-P2-14: Zero behavior change — compiled prompt output identical pre/post migration

## Upstream Pitch Strategy (Issue #839)

Phase 2 design requires alignment with the upstream maintainer, who previously declined lifecycle abstraction (comment on #839). Our pitch addresses each concern:

### Concern 1: "Schema-driven catalog compresses dynamic injections into static YAML claims"

**Our response:** The hook manifest describes *registration metadata* (which stage, whether enabled, what version), not *content policy*. Content lives in templates and code resolvers, exactly as today. The manifest is the "phone book" — it says where to reach each hook, not what the hook should say. This is the same relationship as `PluginRegistry` (F202) — plugin manifests describe capabilities, not behavior.

### Concern 2: "Pre-freezing N-stage pipeline locks the extension surface"

**Our response:** 5 stages (not 8) are clock signals mapped to existing code execution points (`buildStaticIdentity` = session-init, `buildInvocationContext` = per-turn). They don't define what hooks can do. Adding a hook doesn't require a new stage. This is less "pre-freezing" than the current code, where adding a segment requires modifying specific functions and understanding their call patterns.

### Concern 3: "Build-to-Delete — metadata turns deletion into deprecation"

**Our response:** The opposite. Currently, deleting a segment requires: find all code paths → remove condition + vars + render + push → verify no side effects → remove template → update manifest display entry → test. With hooks: set `enabled: false`, segment stops firing immediately. The code can be deleted at leisure. Build-to-Delete becomes a one-line config change followed by optional cleanup.

### Concern 4: "Injections grow from trajectories, not pre-numbered interfaces"

**Our response:** The hook pipeline IS the substrate for trajectory-based growth. For injections to "grow from real trajectories," the system needs: (1) structured trace data showing which segments fired per turn, (2) correlation between segment combinations and outcomes, (3) versioning to A/B test segment changes. Without a pipeline, there's no measurement infrastructure. Phase 2 delivers the measurement; Phase 3 (eval feedback loop) delivers the iteration.

### Issue #983 (Hook Output Demotion)

Separately accepted upstream. Not blocked by Phase 2 — can land independently as a behavioral fix within the current `if/push` code. Phase 2 would make it a hook-level concern (resolver checks dispatch priority).

## Future Work

- Hook output dispatch-aware demotion (#983, separate behavioral PR)
- Text deduplication across A2A routing sections
- Preview accuracy improvements (native-L0 routing, pack blocks, C1 overlays)
- Manifest documentation refinements (concrete source paths, H1/H3 readonly marking)
- **Phase 3: Eval Feedback Loop** — automated trace analysis, segment scoring, A/B version comparison
- **Custom User Hooks** — operator-registered hooks with security sandboxing
- **Context Mutation Hooks** — hooks that modify session state (requires safety model design)

## Dependencies

- **Extended from**: F203 (read-only L0 viewer to full injection visibility)
- **Related**: F153 (tracing — future observability integration)
- **Related**: F180 (hook health/sync)
- **Related**: F190/F199/F206 (Console settings infrastructure)

## Timeline

| Date | Event |
|------|-------|
| 2026-06-02 | Kickoff: motivating incident analysis + CVO direction |
| 2026-06-02 | Issue #839 created, maintainer triage |
| 2026-06-03 | CVO approved Phase 1, worktree created |
| 2026-06-04-10 | Implementation: 6 rounds of codex local review |
| 2026-06-11 | Gate passed (build + tsc + test + lint), PR #859 opened |
| 2026-06-11-12 | Cloud review: 34 findings processed (1 fixed, 33 pushback) |
| 2026-06-15 | Scope discussion with maintainer on #839 |
| 2026-06-16 | PR #859 merged, Phase 1 complete |
| 2026-06-24 | Phase 2 design: hook pipeline + injection trace spec |
| 2026-06-25 | Phase 2 design review passed (codex R1: 3 P1 + 1 P2 fixed) |
