---
feature_ids: [F237]
related_features: [F203, F153, F180, F190, F199, F206]
topics: [system-prompt, injection, visibility, console, settings, trust, governance]
doc_kind: spec
created: 2026-06-02
updated: 2026-06-16
---

# Prompt Injection Visibility

> **Status**: in-progress (Phase 1 PR #859) | **Owner**: Ragdoll Opus 4.6
> **Issue**: [#839](https://github.com/zts212653/clowder-ai/issues/839)
> **Feature ID**: F237 (assigned by maintainer; branch/PR retain original naming)

## Why

### Motivating Example

Thread `thread_mpuxhppp0vzl2y16`: opus47 was dragged off-task by a startup hook's hygiene warning, dropping a review ball. Root cause: no visibility into what's injected into agent prompts, no way to audit or prioritize competing injections.

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

## Future Work

- Hook output dispatch-aware demotion (separate behavioral PR)
- Text deduplication across A2A routing sections
- Preview accuracy improvements (native-L0 routing, pack blocks, C1 overlays)
- Manifest documentation refinements (concrete source paths, H1/H3 readonly marking)

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
