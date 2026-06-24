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

> **Upstream status**: PROPOSAL — not yet accepted by maintainer. Upstream accepted scope is PR #859 (Phase 1) + #983 (hook demotion). This Phase 2 design requires a new pitch on issue #839 to get lifecycle abstraction accepted. The ACs and landing order below describe the proposed implementation, contingent on upstream alignment. See [Upstream Pitch Strategy](#upstream-pitch-strategy-issue-839) for how we plan to address the maintainer's prior concerns.

### Motivation

Phase 1 delivered visibility — operators can see what's injected. Phase 2 makes **46 content segments** self-contained, dynamically manageable, observable, and versionable via a hook pipeline. The remaining 6 segments (N2 conversation history delta, M1-M2 transport-layer, H1-H3 Claude Code hooks) get observe-only trace adapters. Together, all 52 segments become traceable — the data foundation for automated iteration.

**Why 46:** All segments that follow the condition → content → inject pattern become full hooks. This includes:
- **S/D segments** (34): the original `if/push` patterns in `SystemPromptBuilder.ts`
- **L1-L7** (7): dynamically compiled from template files by `compile-system-prompt-l0.mjs` at runtime — NOT build-time static. Same template → render → inject pattern as S-segments, just delivered via native L0 channel for native providers
- **B1, C1** (2): session bootstrap and MCP callback — standard condition → content pattern
- **R1-R2, N1** (3): route-layer assembly and navigation context

**Why 6 stay observe-only:**
- **N2** (conversation history delta): immutable data assembly (`trigger: always`, `disableable: false`, `governanceTier: immutable`). Just "previous unread messages" — no customization value in hook-ifying it
- **M1-M2** (transport-layer): deliberately outside content pipeline to preserve the produced-vs-delivered boundary
- **H1-H3** (Claude Code hooks): completely different injection system (`.claude/hooks/` shell scripts triggered by Claude Code lifecycle events — SessionStart, PostCompact, SessionStop). H3 explicitly "不进 model prompt" (governance notification only). These are managed by Claude Code's hook infrastructure, not Cat Cafe's content pipeline

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
| Disable a segment | Find code, comment out, deploy | `enabled: false` in hook.yaml, deploy |
| Try a new version | Branch + code change + PR | Add v2 template, switch version in hook.yaml |
| Roll back | Revert commit + deploy | Revert version in hook.yaml |
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
│              Runtime Content Pipeline (46 hooks)                │
│                                                                 │
│  session-init    S1-S13, B1, C1, L1-L7 (identity + rules)      │
│  per-turn        D1-D21, R1-R2, N1     (context + routing)     │
│                                                                 │
│  Each hook: condition → resolve → render                        │
│           → emit PromptPatch + TraceEvent                       │
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

┌─────────────────────────────────────────────────────────────────┐
│              Surface Trace Adapters (observe only — 6 segments) │
│                                                                 │
│  N2      conversation history delta (immutable data assembly)   │
│  M1-M2   transport-layer (missionPrefix, transcriptPathHints)   │
│  H1-H3   Claude Code hooks (external lifecycle events)          │
│                                                                 │
│  No resolvers, no enable/disable, no versioning.                │
│  Only emit TraceEvents for observability.                       │
└─────────────────────────────────────────────────────────────────┘
```

### Two Tiers: Runtime Content Pipeline + Surface Trace Adapters

Phase 2 splits the 52 segments into two tiers with different treatment:

**Tier 1 — Runtime Content Pipeline (46 segments)**

These segments follow the condition → content → inject pattern and benefit from full hook-ification: manifest, resolver, override store, versioning, trace. The pipeline has two stages:

| Stage | When | Segments | Source |
|-------|------|----------|--------|
| `session-init` | New session / re-injection / registry change | S1-S13, B1, C1, L1-L7 (22 hooks) | `buildStaticIdentity()`, `SessionBootstrap`, `McpPromptInjector`, `compile-system-prompt-l0.mjs` |
| `per-turn` | Every invocation, before model call | D1-D21, R1-R2, N1 (24 hooks) | `buildInvocationContext()`, route layer, `route-helpers.ts` |

Why these segments unify:
- **S1-S13, D1-D21** (34): original `if/push` patterns in `SystemPromptBuilder.ts` — the core use case
- **L1-L7** (7): dynamically compiled from `assets/prompt-templates/l*.md` template files at runtime by `compileL0()`. Same template → render → inject pattern as S-segments. Delivery channel = `native-l0` for native providers. The L0 compiler is refactored to consume pipeline output rather than independently loading templates
- **B1** (1): session bootstrap — condition (new session?) → content. Joins `session-init`
- **C1** (1): MCP callback — condition (MCP available?) → content. Existing `.local` overlay migrates to override store. Joins `session-init`
- **R1-R2** (2): route assembly — condition → content at route layer. Joins `per-turn`
- **N1** (1): navigation context — condition → content. Joins `per-turn`

Hook contract:
- **Input**: `AssemblerInput` — typed context data gathered by ContextAssembler
- **Output**: `PromptPatch` (rendered content) + `TraceEvent` (observability record)

**Tier 2 — Surface Trace Adapters (6 segments: N2, M1-M2, H1-H3)**

These segments are genuinely different from the hook pipeline pattern:

| Surface | Source | Why observe-only |
|---------|--------|-----------------|
| N2 (1) | `route-helpers.ts` | **Immutable data assembly**. Conversation history delta = "previous unread messages." `trigger: always`, `disableable: false`, `governanceTier: immutable`. No customization value — not something you'd version, disable, or template-ify |
| M1 (1) | `invoke-single-cat.ts` | **Transport-layer** (missionPrefix, F070). Deliberately outside content pipeline to preserve produced-vs-delivered boundary |
| M2 (1) | `invoke-single-cat.ts` | **Transport-layer** (transcriptPathHints). Always appended, always delivered. Same reason as M1 |
| H1-H3 (3) | `.claude/hooks/user-level/` | **Claude Code hooks** — completely different injection system. Shell scripts triggered by Claude Code lifecycle events (SessionStart, PostCompact, SessionStop). Injection via event stdout → tool_result, not content pipeline. H3 explicitly "不进 model prompt" (governance notification only). Managed by Claude Code's hook infrastructure, not Cat Cafe's content pipeline |

Total: 1 + 2 + 3 = **6 segments**. Combined with Tier 1's 46 hooks = all 52 segments covered.

Trace adapters have no resolvers, no enable/disable toggle, no versioning. They only produce `TraceEventObserved`.

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

**Migration from Phase 1:** Each of the 46 pipelined segments becomes a `hook.yaml` + its existing template file. For S/D segments, the resolver code is extracted from the inline `if/push` pattern. For L1-L7, the existing template files (`l1-parallel-world.md` etc.) become hook templates and the L0 compiler is refactored to consume pipeline output. For B1/C1/R1-R2/N1, resolvers wrap existing execution logic. Zero content change, zero behavior change — same transformation principle as Phase 1's template extraction. The 6 observe-only segments (N2, M1-M2, H1-H3) are not migrated into the hook directory.

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
  
  /** Effective enabled state: runtime override ?? manifest baseline */
  isEnabled(hookId: string): boolean;
  
  /** Effective active version: runtime override ?? manifest baseline */
  getActiveVersion(hookId: string): number;
  
  /** Get effective state for a hook (resolved override chain) */
  getEffective(hookId: string): EffectiveHookState;
}

interface EffectiveHookState {
  enabled: boolean;
  version: number;
  templateOverride: string | null;   // null = use baseline template
  source: 'baseline' | 'operator' | 'auto-eval';  // who set the current override
}

interface RegisteredHook {
  manifest: HookManifest;              // baseline, from repo YAML
  resolver: HookResolver | null;       // null = unconditional, always fires
  template: string;                    // baseline template content
}
```

**State model — baseline + runtime override:**

Hook state uses a two-layer resolution chain: **runtime override** (Redis-persisted) takes precedence over **manifest baseline** (git-tracked YAML). This separates product-level concerns from user-level concerns:

```
Effective state = runtime override ?? manifest baseline
```

| Layer | What it controls | Who changes it | How |
|-------|-----------------|----------------|-----|
| **Manifest baseline** | Which hooks exist, default templates, default enabled/version | Product team | git commit + deploy |
| **Runtime override** | Enable/disable, version switch, template edits, auto-eval iterations | Operator / auto-eval | Console API / auto-eval API |

**Why two layers:**
- **Baseline** is the product's factory default — it defines which hooks ship and their default behavior. Adding or removing a built-in hook is a product-level change that goes through git. This is the "file + git + restart" channel.
- **Runtime override** is the user's workspace — operators can disable hooks they don't want, edit templates to customize behavior, switch versions. Auto-eval (Phase 3) writes to the same override layer. Override and auto-eval use the same mechanism; there's no distinction between manual and automated customization.
- **Package-install users** never touch git. Their entire interaction is through runtime overrides on top of the shipped baseline.

**Safety boundary:** Phase 1's `safetyTier` constrains which hooks accept template overrides — `readonly` hooks (49/52) reject template writes, `limited-edit` and `editable` hooks (3/52) accept them. Enable/disable override is allowed for all hooks regardless of safety tier (disabling a hook doesn't alter its content, just silences it).

**Runtime override store:**

```typescript
interface HookOverrideStore {
  /** Get override for a hook (null = use baseline) */
  getOverride(hookId: string): HookOverride | null;
  
  /** Set override (operator or auto-eval) */
  setOverride(hookId: string, override: HookOverride): void;
  
  /** Clear override (revert to baseline) */
  clearOverride(hookId: string): void;
  
  /** List all active overrides */
  listOverrides(): Array<{ hookId: string; override: HookOverride }>;
}

interface HookOverride {
  enabled?: boolean;              // override enabled state
  version?: number;               // override active version
  templateContent?: string;       // override template (safetyTier gated)
  source: 'operator' | 'auto-eval';
  updatedAt: number;
  reason?: string;                // why this override was set
}
```

Keyed by `hook-override:{hookId}`. TTL=0 (persistent) — user customizations must survive restart (LL-048). Audit trail: each override records `source` and `reason`, enabling "who changed this and why" queries.

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
   * Returns a discriminated union — no mutable state on the resolver instance,
   * safe for concurrent invocations sharing a registry singleton.
   */
  resolve(input: AssemblerInput): ResolveResult;
}

type ResolveResult =
  | { status: 'fired'; vars: Record<string, string>; templateVersion?: number }
  | { status: 'skipped'; reasonCode: string; reason: string };

/** What a hook produces after resolution + template rendering */
interface PromptPatch {
  hookId: string;
  stage: HookStage;
  content: string;           // rendered template content
  position: 'append';        // Phase 2: append only. Future: prepend, replace
}

/** Discriminated union — status determines which fields are present */
type TraceEvent =
  | TraceEventFired
  | TraceEventSkipped
  | TraceEventDisabled
  | TraceEventObserved;

interface TraceEventBase {
  hookId: string;
  stage: HookStage;
  durationMs: number;        // resolver execution time (0 for disabled/observed)
}

interface TraceEventFired extends TraceEventBase {
  status: 'fired';
  version: number;            // which version of the hook fired
  contentHash: string;        // SHA-256 of rendered content
  tokenEstimate: number;      // approx token count
}

interface TraceEventSkipped extends TraceEventBase {
  status: 'skipped';
  reasonCode: string;         // e.g., "no_ping_pong_warning", "condition_false"
  reason: string;             // human-readable: "pingPongWarning not present"
}

interface TraceEventDisabled extends TraceEventBase {
  status: 'disabled';
  disabledBy: 'manifest' | 'operator' | 'auto-eval';  // which layer disabled it
}

/** For Tier 2 surface trace adapters (L/B/C/R/N/H) */
interface TraceEventObserved extends TraceEventBase {
  status: 'observed';
  contentHash: string | null; // hash of observed content, null if not available
  tokenEstimate: number;
}
```

**Pipeline execution per stage (Tier 1 — S/D hooks only):**

```
for each registered hook in stage (ordered by manifest priority):
  1. Check effective enabled (override ?? manifest) → false?
     → emit TraceEvent { status: 'disabled', disabledBy: source }
  2. If hook has resolver → call resolver.resolve(input)
     - Returns { status: 'skipped', reasonCode, reason }
       → emit TraceEvent { status: 'skipped', reasonCode, reason }
     - Returns { status: 'fired', vars, templateVersion? }
       → continue to step 4
  3. If hook has no resolver → unconditional (always fire with empty vars)
  4. Render template with vars → PromptPatch
  5. Emit TraceEvent { status: 'fired', contentHash, tokenEstimate, version }
```

### InjectionTrace — Dual-Layer Persistence

After each turn, persist injection trace data in two layers with different retention strategies:

**Layer 1: InjectionTraceSummary (persistent)**

Lightweight structural record — which hooks fired/skipped, aggregate stats. This is the data substrate for Phase 3 eval and long-term trend analysis. Default TTL=0 (persistent), consistent with the iron law that user-visible, traceable state defaults to persistent (LL-048).

```typescript
interface InjectionTraceSummary {
  turnId: string;
  sessionId: string;
  threadId: string;
  catId: string;
  timestamp: number;
  
  /** Per-hook summary, one entry per hook (fired/skipped/disabled/observed) */
  hooks: TraceEventSummary[];
  
  /** Per-stage delivery decision — did produced content reach the model? */
  delivery: StageDeliveryDecision[];
  
  /** Aggregate stats (of produced content, not delivered) */
  totalTokens: number;
  totalHooksFired: number;
  totalHooksSkipped: number;
  totalDurationMs: number;
}

/** Compact per-hook entry — no content, just identity + outcome */
interface TraceEventSummary {
  hookId: string;
  status: 'fired' | 'skipped' | 'disabled' | 'observed';
  version?: number;           // only for fired
  tokenEstimate?: number;     // only for fired/observed
  reasonCode?: string;        // only for skipped
}
```

Keyed by `injection-trace-summary:{threadId}:{turnId}`. Queryable for trend analysis: "how often does D5 fire across the last 100 turns?"

**Layer 2: InjectionTraceDetail (debug, short TTL)**

Full `TraceEvent` records including content hashes, durations, human-readable reasons. For debugging "what exactly happened on turn N?" Default TTL = 7 days (configurable), consistent with F153's pattern for debug-level span data.

```typescript
interface InjectionTraceDetail {
  turnId: string;
  threadId: string;
  catId: string;
  timestamp: number;
  
  /** Full TraceEvent array (discriminated union, all fields) */
  hooks: TraceEvent[];
}
```

Keyed by `injection-trace-detail:{threadId}:{turnId}`.

**Why dual-layer:** Full `TraceEvent` records with content hashes and durations are valuable for debugging but expensive to store indefinitely and rarely needed after the immediate debugging window. The summary layer captures the structural signal (which hooks, what outcome) needed for eval correlation and trend analysis without storing transient debug detail. This mirrors F153's approach: structured pointers persist, debug captures expire.

SessionContext holds only `currentTurnId` + `previousTurnId` references, not trace data itself.

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

**Produced vs Delivered — critical trace distinction:**

Session-init hooks (S1-S13) fire inside `buildStaticIdentity()`, which runs on every invocation. But the produced content is only delivered to the model when `injectSystemPrompt` is true (new session, force-reinjection, or registry change). On resumed turns with `canSkipOnResume`, the S-segment content is produced but **not sent**. If the trace only records "S1 fired", it creates false observability — the operator sees "S1 was active this turn" when the model never received it.

To fix this, the `InjectionTraceSummary` includes a per-stage **delivery decision** record that is channel-aware:

```typescript
interface StageDeliveryDecision {
  stage: 'session-init' | 'per-turn';
  delivered: boolean;
  channel: DeliveryChannel;
  reason: string;       // e.g., "injectSystemPrompt=false (resume, canSkipOnResume)"
}

type DeliveryChannel =
  | 'message-prepend'    // non-native: S-content prepended to prompt string
  | 'native-l0'          // native providers (Claude/Codex/OpenCode): L0 via --system-prompt-file / developer_instructions
  | 'pack-only'          // native L0 with hasNativeL0=true: only pack blocks via buildStaticIdentityPackOnly()
  | 'always-delivered';  // per-turn D-segments, transport-layer M1/M2
```

Delivery semantics per stage and provider:

- **session-init (non-native providers)**: `delivered = injectSystemPrompt`, `channel = 'message-prepend'`
- **session-init (native L0 providers — Claude/Codex/OpenCode)**: S-content is delivered via native L0 channel (compiled `system-prompt-l0.md`), NOT via `injectSystemPrompt`. Route code uses `buildStaticIdentityPackOnly()` when `hasNativeL0=true` — only pack blocks go through `buildStaticIdentity()`. So `injectSystemPrompt` is not the delivery truth for native providers; the native L0 channel is.
- **per-turn**: `delivered = true`, `channel = 'always-delivered'` (D-segments are always part of the prompt regardless of provider)

This means `TraceEventSummary` records what the pipeline *produced*, and `StageDeliveryDecision` records what transport *delivered and through which channel*. Together they answer "what did we prepare?", "what did the model actually see?", and "how was it delivered?" — the distinction needed for accurate eval correlation in Phase 3.

For Tier 2 transport-layer adapters (M1/M2), delivery is inherent (`channel = 'always-delivered'`). L1-L7 delivery depends on whether the provider uses native L0 (`channel = 'native-l0'`) or message-prepend (`channel = 'message-prepend'`, gated by `injectSystemPrompt`).

### Surface Trace Adapters (Tier 2 — 6 segments)

The 6 segments that genuinely don't fit the runtime content pipeline get lightweight observe-only adapters:

- **N2 (conversation history delta)**: Adapter at `route-helpers.ts` records conversation history assembly. Immutable, always-on, no customization value.
- **M1-M2 (transport-layer)**: M1 adapter records dispatch mission context (missionPrefix, F070). M2 adapter records transcript path hints. Both at `invoke-single-cat.ts` transport assembly point — they remain outside the content pipeline to preserve the produced-vs-delivered boundary.
- **H1-H3 (Claude Code hooks)**: Adapters leverage F180 hook health infrastructure to record fire/skip of external shell scripts. These are managed by Claude Code's hook system (`.claude/hooks/`), not Cat Cafe's content pipeline. H3 is governance-only and doesn't enter the model prompt.

Trace adapters produce `TraceEventObserved` only — no `PromptPatch`, no enable/disable, no versioning. This ensures the trace record covers all 52 segments (46 Tier 1 + 6 Tier 2) for complete observability.

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

- **Eval feedback loop** — automated analysis of trace data to score/iterate segments. This is Phase 3, consuming Phase 2's trace + override infrastructure
- **Context mutation** — hooks producing side effects beyond PromptPatch (e.g., modifying session state). Future capability tier
- **Custom user hooks** — operators can't register their own hooks yet. This requires security model design beyond Phase 2's scope
- **L0 compiler integration** — L1-L7 remain compiled by `compile-system-prompt-l0.mjs`. Hook pipeline observes but doesn't replace the compiler

### Landing Order

Phase 2 implementation in 5 sub-phases, each independently shippable:

| Sub-phase | Deliverable | Tests |
|-----------|------------|-------|
| **P2-A: HookManifest + Registry** | Hook YAML schema for all 46 pipelined segments, directory scan, manifest parsing. Registry lists S1-S13, B1, C1, L1-L7, D1-D21, R1-R2, N1 | Schema validation tests, scan tests (following PluginRegistry test pattern) |
| **P2-B: ContextAssembler + Resolvers** | Extract resolver logic: S/D from `if/push` patterns, L1-L7 from L0 compiler templates, B1/C1/R/N1 wrapping existing execution points. ContextAssembler gathers inputs. Dual-path: old code path + new pipeline produce identical output. L0 compiler refactored to consume pipeline output | Snapshot tests: old output === new output for all 46 hooks |
| **P2-C: Pipeline Execution + Trace Adapters** | Wire HookPipeline into session-init and per-turn stages. Remove old patterns. Add Tier 2 trace adapters for N2 + M1-M2 + H1-H3 (6 observe-only) | Integration tests: compiled output identical. Regression: all existing tests pass. Trace adapter coverage tests |
| **P2-D: Runtime Override Store** | Redis-backed override layer (`HookOverrideStore`). Console UI: enable/disable hooks, switch versions, edit templates (safetyTier-gated). Overrides persist across restart (TTL=0). Same write API for operator and future auto-eval | Override resolution tests (override ?? baseline). Safety tier gate tests. Persistence tests |
| **P2-E: InjectionTrace Persistence** | Dual-layer persistence (summary persistent + detail short TTL). Console trace viewer. Trace records override source (`disabledBy: 'operator'` etc.) | Trace record completeness tests. Console: can view which hooks fired per turn, who overrode what |

## Acceptance Criteria — Phase 2

- [ ] AC-P2-1: HookManifest YAML schema defined for S/D segments, validated by `check-hook-manifest.mjs`
- [ ] AC-P2-2: HookRegistry scans `assets/prompt-hooks/`, parses all 46 hook manifests (S1-S13, B1, C1, L1-L7, D1-D21, R1-R2, N1)
- [ ] AC-P2-3: ContextAssembler produces typed `AssemblerInput` from route-layer queries for session-init and per-turn stages
- [ ] AC-P2-4: 46 content hooks have standalone resolvers (S/D from `if/push`, L1-L7 from L0 compiler templates, B1/C1/R/N1 wrapping existing execution points); N2 + M1-M2 + H1-H3 have observe-only trace adapters
- [ ] AC-P2-5: Dual-path validation: old `if/push` output === new pipeline output for all S/D segments (snapshot tests)
- [ ] AC-P2-6: `buildStaticIdentity()` and `buildInvocationContext()` delegate to HookPipeline
- [ ] AC-P2-7: Each S/D hook execution produces TraceEvent (discriminated union: fired/skipped/disabled)
- [ ] AC-P2-8: InjectionTraceSummary persisted per turn (persistent, TTL=0); InjectionTraceDetail persisted with configurable TTL (default 7 days)
- [ ] AC-P2-8a: InjectionTraceSummary includes per-stage `StageDeliveryDecision` distinguishing produced vs delivered (session-init delivery = `injectSystemPrompt` decision)
- [ ] AC-P2-9: Console trace viewer: query which hooks fired per turn per thread
- [ ] AC-P2-10: Hook versioning: v1→v2 switch via runtime override or manifest baseline, TraceEvent records version
- [ ] AC-P2-11: Hook enable/disable via runtime override (any hook) or manifest baseline, TraceEvent records disabled status + source
- [ ] AC-P2-12: Transport assembly (staging/contextHint/missionPrefix/M2) unchanged, not in pipeline
- [ ] AC-P2-13: Tier 2 trace adapters emit `TraceEventObserved` for N2 + M1-M2 + H1-H3 (6 observe-only segments)
- [ ] AC-P2-14: Zero behavior change — compiled prompt output identical pre/post migration (with no overrides active)
- [ ] AC-P2-15: Runtime override store (Redis, TTL=0) with two-layer resolution: override ?? manifest baseline
- [ ] AC-P2-16: Template override gated by safetyTier — readonly hooks reject template writes, limited-edit/editable hooks accept
- [ ] AC-P2-17: Override audit trail: each override records source (operator/auto-eval), timestamp, reason

## Upstream Pitch Strategy (Issue #839)

Phase 2 design requires alignment with the upstream maintainer, who previously declined lifecycle abstraction (comment on #839). Our pitch addresses each concern:

### Concern 1: "Schema-driven catalog compresses dynamic injections into static YAML claims"

**Our response:** The hook manifest describes *registration metadata* (which stage, whether enabled, what version), not *content policy*. Content lives in templates and code resolvers, exactly as today. The manifest is the "phone book" — it says where to reach each hook, not what the hook should say. This is the same relationship as `PluginRegistry` (F202) — plugin manifests describe capabilities, not behavior.

### Concern 2: "Pre-freezing N-stage pipeline locks the extension surface"

**Our response:** Phase 2 defines 2 runtime pipeline stages (session-init, per-turn), not the 8-10 stage lifecycle from the original proposal. These stages are the minimal observation boundary around existing execution points — they formalize what's already there, not invent new boundaries. Only 6 segments (N2, M1-M2, H1-H3) get observe-only trace adapters — the rest all join the pipeline. Adding a hook to a stage doesn't require a new interface; the stages are registration categories, not extension APIs.

### Concern 3: "Build-to-Delete — metadata turns deletion into deprecation"

**Our response:** The opposite. Currently, deleting a segment requires: find all code paths → remove condition + vars + render + push → verify no side effects → remove template → update manifest display entry → test. With hooks: set `enabled: false` in the hook's YAML manifest, commit, deploy — segment stops firing immediately. The resolver code and template can be deleted at leisure in a cleanup pass. The manifest file itself is just a YAML file in git — deleting the hook directory removes it completely. Build-to-Delete becomes: disable → observe trace confirms no regressions → delete directory. No "deprecation" metadata survives deletion.

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
