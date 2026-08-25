---
cell_id: self-sensing-management
title: Self-Sensing / Self-Management
doc_kind: architecture
created: 2026-08-25
summary: F300-owned evidence admission, capability-state interpretation, friction-to-proposal policy, authority-bounded episode coordination, and feedback semantics across existing capability and interaction owners.
canonical_features: [F300]
code_anchors: []
doc_anchors:
  - docs/features/F300-self-sensing-home-state-awareness.md
static_scan_hints: [HomeStateDeltaV1, HomeStateSnapshot, InteractionEpisode, capability-match, friction-evidence, affects_current_obligation, affects_next_side_effect, first-successful-action]
cited_by:
  - {feature: F300, date: 2026-08-25, delta: "new architecture-truth cell before runtime implementation; source facts, delivery, execution, authorization, and surface rendering stay with adjacent owners"}
---

# Self-Sensing / Self-Management

Architecture cell: self-sensing-management

## Canonical Owner

F300 owns the policy that turns bounded, provenance-bearing capability,
availability, and user-friction evidence into one governed Interaction Episode.
That policy includes evidence admission and relevance, multi-axis capability-state
interpretation, friction-to-capability matching, proposal and user-decision stage
semantics, receipt-gated episode transitions, and the feedback meanings
`retained | edited | dismissed | reverted`.

This cell currently registers architecture truth only. F300 has no runtime code
anchors at `origin/main@dd86a802`; later phases must add their concrete anchors as
they land. The absence of code is not permission to infer state from model
introspection, UI visibility, a plugin manifest, or a stale message.

## Adjacent Ownership Boundaries

- `plugin` owns plugin/package discovery, installation, configuration, grants,
  Host Broker/runtime readiness, audit, mutation commands, and their receipts.
  F300 consumes those facts and receipts; it does not copy their ledger or gain
  a second mutation path.
- F223 / `hub-action-surface` owns the capability-surface registry and typed
  first-party Hub presentation actions. F300 may select an appropriate surface
  for an episode, but a rendered surface is not capability, authority, readiness,
  or effectiveness truth.
- F283 retains the frozen experience-runtime hypothesis for resolving runtime
  objects and judgment points into UI states. If that work resumes, it consumes
  F300 episode/capability refs; it does not own the episode policy.
- `routing-context` and F293 own route/preflight truth. F300 may require an
  authoritative preflight before a relevant side effect, but cannot rewrite the
  route owner or derive availability from a previous attempt.
- F296 owns context epoch, presentation, dedupe, and provider-minted receipt.
  F300 owns whether a delta is relevant to the current obligation; it does not
  create a second delivery channel or equate persistence with model visibility.
- F233, F220, F153, and runtime-specific domains retain custody,
  execution/liveness, health, and recovery truth. F299 retains durable
  request-generation and trajectory evidence. F300 references their source IDs
  and freshness; it does not absorb their state machines.
- Authority owners execute installation, configuration, permission, and external
  side effects. F300 may form an authority envelope and route an approved intent,
  but only the owning domain's receipt may advance an execution-dependent stage.

## Durable Invariants

1. Every sensing claim names a canonical source, observation time, freshness or
   invalidator, and scope. `unknown`, `stale`, and `conflicted` remain first-class.
2. `installed`, `configured`, `authorized`, `ready`, `applicable`, and
   `effective` are distinct axes; no UI, manifest, registry entry, or prior
   success may collapse them into one `enabled` claim.
3. No inferred friction or proposal grants authority. An episode cannot cross
   `proposal` without an explicit user decision and cannot cross an execution
   stage without the canonical owner's receipt.
4. A proposal, install, render, or tool registration is not a successful
   outcome. `first-successful-action` plus later friction evidence determine
   whether the change is retained, edited, dismissed, or reverted.
5. F300 stores orchestration refs and policy state only. Source-domain facts,
   user-visible message bodies, plugin lifecycle, delivery custody, and surface
   state remain single-owned by their existing cells.

## Use This When

- Adding or changing `HomeStateDeltaV1`, `HomeStateSnapshot`, a capability graph
  projection, friction evidence admission, capability matching, or Interaction
  Episode transitions.
- Deciding whether a capability or availability fact is relevant to the current
  obligation or next side effect.
- Coordinating a proposal, explicit user decision, owner command/receipt,
  interaction adaptation, first use, and feedback as one auditable episode.
- Auditing a claim that an Agent “knows what it can do” or “managed itself” and
  determining which canonical facts and authority receipts actually support it.

## Extend By

- Add typed read projections over existing owner APIs; do not enumerate UI,
  parse prompt prose, or introduce a central shadow copy of household state.
- Carry source refs, freshness, scope, uncertainty, authority decision, and owner
  receipt through every episode transition.
- Bind user configuration and interaction preference to stable capability
  identity while keeping provider lifecycle and migration checks with their
  canonical owners.
- Add a surface adapter only after the episode contract can express why the
  surface is relevant and which stable route lets the user recall, edit, or
  revert it.
- Update `code_anchors`, consumer evidence, and claim guards in the same change
  that lands each runtime phase.

## Do NOT Unify With

- Do not turn F300 into a second Plugin Manager, capability registry, route
  store, delivery ledger, permission center, runtime supervisor, telemetry
  platform, or UI state machine.
- Do not infer readiness from installation, availability from a previous call,
  user need from catalog presence, or effectiveness from exposure/click/install
  counts.
- Do not auto-install, auto-authorize, widen scope, or perform external effects
  because the Agent formed a high-confidence hypothesis.
- Do not build an unbounded monitoring or user-profile pipeline. Friction evidence
  is task-scoped, provenance-bearing, and subject to explicit retention owners.
- Do not require Dynamic UI for the episode; conversation, CLI, voice, and future
  surfaces must project the same capability, authority, and receipt truth.

## Static Scan Hints

Watch for `HomeStateDeltaV1`, `HomeStateSnapshot`, `InteractionEpisode`,
`capability-match`, `friction-evidence`, `affects_current_obligation`,
`affects_next_side_effect`, `first-successful-action`, or any new store/controller
that combines plugin, route, custody, delivery, authority, or surface truth. New
runtime anchors require an ownership-map update and a claim guard proving that
adjacent canonical owners were consumed rather than copied.
