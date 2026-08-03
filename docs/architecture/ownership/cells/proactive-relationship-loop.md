---
cell_id: proactive-relationship-loop
title: Proactive Relationship Loop
summary: F272-owned intent, foreground visit, household budget claim, canonical-message delivery custody, and echo orchestration that lets a cat act from private F255 seeds and return to its existing stable home.
description: F272 boundary for cat-owned intent, durable proactive visits, household attention ceilings, one canonical home message, and cross-wake relationship echoes.
description_source: human
description_author: codex-sol
description_updated_at: "2026-07-22T00:05:00-07:00"
canonical_features: [F272]
code_anchors:
  - packages/shared/src/types/auto-dream.ts
  - packages/api/src/domains/auto-dream/PresentLoopService.ts
  - packages/api/src/domains/auto-dream/ProactiveRelationshipService.ts
  - packages/api/src/domains/auto-dream/ProactiveRelationshipStore.ts
  - packages/api/src/domains/auto-dream/private-seed-contract.ts
  - packages/api/src/domains/auto-dream/private-seed-operations.ts
  - packages/api/src/domains/auto-dream/AutoDreamStore.ts
  - packages/api/src/infrastructure/scheduler/templates/present-loop.ts
  - packages/api/src/domains/cats/services/stores/ports/MessageStore.ts
  - packages/api/src/routes/callback-auto-dream-routes.ts
  - packages/api/src/routes/auto-dream.ts
  - packages/mcp-server/src/tools/auto-dream-tools.ts
doc_anchors:
  - docs/features/F272-cat-jumps-on-the-table.md
  - feature-discussions/2026-07-20-cat-jumps-on-the-table.md
  - feature-specs/2026-07-21-f272-phase-a-first-jump.md
static_scan_hints: [ProactiveRelationshipService, proactive_intents, proactive_visits, foreground_visit_budget_claims, proactive_echoes, private_cues, owned_seeds, visitId, canonicalMessageRef, F255PendingCueSink]
cited_by:
  - {feature: F272, date: 2026-07-21, delta: "Phase A registers the integrator boundary before runtime implementation; existing F255, F139, MessageStore, F258, F229, F246 and F263 ownership does not move"}
  - {feature: F272, date: 2026-07-22, delta: "Phase A implements the typed cue/seed port, durable intent/visit/budget/echo state, canonical MessageStore delivery, natural-reply reconciliation, and owner-session typed echoes"}
---

# Proactive Relationship Loop

Architecture cell: proactive-relationship-loop

## Canonical Owner

F272 owns the relationship-loop orchestration that begins after a cat owns a private seed: one cat-authored intent, its reversible first action, a durable foreground visit, the household attention claim, canonical-message delivery custody, and the echo that returns on a later wake. The visit ledger is the cross-surface orchestration truth. Every visible projection must name an already-persisted `visitId`; later message, body-language, doorbell, or trace adapters attach to that visit instead of creating parallel lifecycles.

This cell does not own the seed body, the cat's home, generic schedule execution, the message body, UI presence, action authorization, or observability. It integrates those owners under the invariants below.

## Adjacent Ownership Boundaries

- **F255 private store** owns `cue` and `owned seed`, plus the existing per-owner/per-cat life config and stable `deliveryThreadId`. F272 may consume those records but cannot copy their body or create a second home/config store.
- **F139** executes the Present Loop projection. A scheduler wake can start the loop but cannot adopt a cue, invent an intent, or spend foreground attention.
- **MessageStore** owns the canonical home-thread message body. F272 owns only the pending delivery custody before append and the attached message reference afterwards.
- **F258 / F229** may later project body language or a doorbell that references the same visit. They do not own private intent or duplicate the canonical message.
- **F246** remains the only authority boundary for purchasing, publishing, devices, permissions, or other external side effects. Ordinary `我想要 / 我发现 / 我惦记` expression does not enter Approval Hub.
- **F263** may consume body-free lifecycle IDs, stages, and outcomes. It must not read cue reasons, seed claims, pending message content, or natural-reply bodies.

## Durable Invariants

1. A system producer may persist a pending cue and receive only `{cueId}`. Only the matching cat inside a live private-time invocation may adopt, rewrite, reject, or originate an owned seed.
2. A visible expression first commits one visit and one idempotent household-local-day claim in the same SQLite transaction. Silence creates no visit and spends no foreground claim.
3. The F255 life config is the only source of the canonical home thread. Work, decision, and implementation threads may contribute cues but can never be selected as proactive landing targets.
4. One `visitId` maps to at most one MessageStore idempotency key and one canonical message reference. Crash recovery reuses that identity; it does not repost or recharge.
5. `foreground_visit_budget` is a ceiling, not a quota. Private thinking, cue review, owned-seed incubation, diary writing, and silence do not consume it, and no prompt advertises a remaining count to fill.
6. Echoes retain history. `not_now` and `wrong` may make the related seed dormant, but never delete its cue, seed, intent, visit, message reference, or echo lineage.
7. One owner-authored home message may echo at most one visit. Explicit `replyTo` wins; otherwise reconciliation selects only the latest un-echoed canonical visit preceding that message, and stores the message reference without copying its body.

## Use This When

- Adding or changing F272 intent, first-action, visit, budget-claim, canonical-delivery, or echo transitions.
- Attaching F258/F229/F263 projections to a proactive visit.
- Changing retry, startup reconciliation, local-day accounting, quiet-hour, or repeated-approach suppression semantics.
- Auditing why a proactive message landed in a particular thread or whether it consumed household attention once.

## Extend By

- Add new visible surfaces as `projectedSurfaces` references on the existing visit; do not create per-surface visits or counters.
- Add new echo kinds through the F272 echo state machine and preserve the source reference; do not collapse them into a single proactive score.
- Keep pending canonical delivery as temporary custody on an unprojected visit. Clear the body after MessageStore attach so there is one long-lived message truth.
- Keep every store query scoped by owner and cat, and derive home/local-day inputs server-side from F255 configuration rather than callback payloads.
- Emit audit/trace events with IDs, stage, expression kind and outcome only. Private claims and message/reply bodies stay out of public evidence.

## Do NOT Unify With

- Do not move cues or owned seeds into the F272 visit ledger; F255 private storage remains their single truth.
- Do not add `homeThreadId`, rhythm, quiet hours, or scheduler settings to F272 configuration.
- Do not use Approval Hub to approve ordinary expression, or treat a reversible-action note as authority to perform an external side effect.
- Do not let MessageStore become the visit/budget/echo state machine, and do not retain a second canonical message body after attach.
- Do not let F258/F229 invent desire from animation state or cache private intent in frontend stores.
- Do not optimize number of visits, response rate, or a blended "heart" score. Silence and "陪着就好" remain healthy terminal outcomes.

## Static Scan Hints

Watch for `ProactiveRelationshipService`, `proactive_intents`, `proactive_visits`, `foreground_visit_budget_claims`, `proactive_echoes`, `private_cues`, `owned_seeds`, `visitId`, `canonicalMessageRef`, `F255PendingCueSink`, or any direct proactive append to MessageStore. New landing targets, budget counters, seed stores, or message copies outside this cell require an explicit ownership review.
