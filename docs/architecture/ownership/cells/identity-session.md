---
cell_id: identity-session
title: Identity / Session
summary: Agent identity、connector session binding、bubble identity、runtime session binding、user profile 五个 subcell 的边界。
canonical_features: [F032, F088, F183, F211, F231]
code_anchors:
  - cat-config.json
  - packages/api/src/config/cat-config-loader.ts
  - packages/shared/src/types/cat.ts
  - packages/api/src/infrastructure/connectors/ConnectorThreadBindingStore.ts
  - packages/api/src/infrastructure/connectors/connector-binding-keys.ts
  - packages/api/src/routes/thread-cats-core.ts
  - packages/web/src/debug/bubbleIdentity.ts
  - packages/api/src/domains/cats/services/stores/ports/SessionChainStore.ts
  - packages/api/src/domains/cats/services/runtime-session/RuntimeSessionMetadata.ts
  - packages/api/src/domains/cats/services/runtime-session/RuntimeSessionStore.ts
  - packages/api/src/domains/cats/services/runtime-session/RedisRuntimeSessionStore.ts
  - packages/api/src/domains/cats/services/runtime-session/RuntimeSessionStoreFactory.ts
  - packages/api/src/domains/cats/services/runtime-session/ExternalRuntimeSessionRegistration.ts
  - packages/api/src/domains/cats/services/stores/redis-keys/runtime-session-keys.ts
  - packages/api/src/routes/callback-runtime-session-routes.ts
  - packages/api/src/routes/external-runtime-sessions.ts
  - packages/mcp-server/src/tools/external-runtime-session-tools.ts
  - packages/api/src/domains/cats/services/agents/providers/antigravity/AntigravityBridge.ts
  - packages/api/src/domains/cats/services/agents/providers/antigravity/antigravity-runtime-session-import.ts
doc_anchors:
  - docs/features/F032-agent-plugin-architecture.md
  - docs/features/F088-multi-platform-chat-gateway.md
  - docs/decisions/033-bubble-pipeline-identity-contract.md
  - docs/features/F211-cross-runtime-session-transparency.md
  - feature-discussions/2026-05-24-f211-design-memo/README.md
  - docs/features/F231-user-profile-capsule.md
  - feature-discussions/2026-06-13-f231-phase-c-design-gate.md
static_scan_hints: [catId, AgentRegistry, cat-config, roster, ConnectorThreadBindingStore, bubbleIdentity, session, SessionChainStore, cliSessionId, cascadeId, runtimeSession, capsule, "private/profile"]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F193, date: 2026-05-08, delta: Phase B — typed crossThreadReplyHint field on InvocationContext + render block in buildInvocationContext (receiver-side reply hint hydrated from trigger message id)}
  - {feature: F209, date: 2026-05-22, delta: "boundary note — F209 entity_id is a retrievable entity doorway, not roster truth"}
  - {feature: F211, date: 2026-05-24, delta: "new identity-runtime-session subcell for runtime session identity, cascade/conversation binding, lifecycle registration, seal reason, and identity history"}
  - {feature: F211, date: 2026-05-25, delta: "Phase B external runtime registration/list/read surfaces, hidden anchor threads, and agent-key-only IDE-direct session binding"}
  - {feature: F231, date: 2026-06-11, delta: "new identity-user-profile subcell — per-user profile capsule + relationship primer + breed/instance/user/relationship persona layering; data anchors private/profile/ + .cat-cafe/cat-catalog.json personality (gitignored, per-instance); prompt injection anchor pending Design Gate (OQ-1, ADR-038 L0 budget alignment)"}
  - {feature: F231, date: 2026-06-11, delta: "OQ-1 closed (KD-7) — prompt injection layer = L0 compile-time {{USER_CAPSULE}} template (compile-system-prompt-l0.mjs same chain as IDENTITY_BLOCK/TEAMMATE_ROSTER); capsule queued in ADR-038 promote queue #2, injection anchor gated on PR-C landing (codex/gpt52 demote to ≤6000 tokens, ETA 2026-06-13); hard cap 300 chars (~285 tokens); not in Staging / not in SystemPromptBuilder runtime — ADR-038 three-question check: capsule is full-conversation identity (compression loss = harmful gap), must stay L0; decision: feature-discussions/2026-06-11-f231-design-gate.md"}
  - {feature: F231, date: 2026-06-13, delta: "OQ-4 closed (KD-8~11) — Phase C nurturing loop = 3-stage pipeline (collect→distill→digest), system-gives-data / cat-operator-gives-conclusion throughout (F227 KD-8 no-classifier line). KD-9 collection whitelist data contract (deterministic explainable events only; forbids classifier labeling like 'this is a relationship signal'); KD-10 runtime-neutral distill trigger on Cat Café runtime invocation/session-seal/turn-completed events, NOT provider Stop hook (codex exec --json does not dispatch ~/.codex/hooks.json Stop hook, CodexAgentService.ts); KD-11 F231 = bounded profile consolidation pilot (dry-run proposal + provenance, no general dream lane). 46's L0 reflex demoted to a manual digest-stage entry, not main path. Decision: feature-discussions/2026-06-13-f231-phase-c-design-gate.md"}
  - {feature: F231, date: 2026-06-13, delta: "Phase C design deepening (operator co-creation) — KD-12 digest layer = cost-tiered signing + use-to-verify: only high-cost objective facts (health/safety/irreversible) need operator signature; preferences/impressions written autonomously by cats and verified in-use (profile used in a real decision, operator reacts, corrected on the spot), push-approval becomes pull-calibration (solves humans-won't-approve-daily + self-view-is-distorted). KD-13 correction signal = highest-priority collection source but recognized via the participating cat's own understanding, NEVER via system keyword/pattern matching (human phrasing too varied = classifier in disguise); distinct from magic-word (operator's bounded agreed triggers, still matchable). KD-14 profile use = subconscious surfacing (internalized intuition, not table-lookup recitation), anti-class-tone. OQ-5 (open): injection layer / 50k-5k-500 funnel third stage (dynamic vs pull vs static); injection = relevance retrieval not intake judgment, does not break KD-8."}
  - {feature: F231, date: 2026-06-13, delta: "Phase C write-rule cleanup (codex REQUEST-CHANGES P1) — removed stale 'all changes via operator review' wording that conflicted with KD-12; KD-15 added: low-cost autonomous writes target per-cat layer (primer / user-signal lane) ONLY, NOT shared capsule directly (promotion to shared capsule needs high bar: operator signature or multi-cat corroboration); low-cost writes require provenance (source coords + owner cat + status + correction path)."}
---

# Identity / Session

Architecture cell: identity-session

## Canonical Owner

This is a top-level routing cell with five subcells. It exists to prevent identity concerns from becoming a garbage bin.

- `identity-agent`: F032 owns dynamic CatId, roster, AgentRegistry, roles, and reviewer matching.
- `identity-connector`: F088 owns connector principal link and external chat/thread binding.
- `identity-bubble`: F183 / ADR-033 own frontend bubble identity within a thread.
- `identity-runtime-session`: F211 owns runtime session identity and binding for long-lived or external runtimes: cascade/conversation IDs, SessionChainStore bridge records, lifecycle registration, hidden external-runtime anchor threads, seal reason, and per-session identity history.
- `identity-user-profile`: F231 owns per-user profile capsule, relationship primer, and the breed/instance/user/relationship layering of persona data (breed = tracked/shared; instance/user/relationship = per-user private). Private data lives at gitignored paths (`private/profile/`, `.cat-cafe/cat-catalog.json` personality) — intentionally NOT listed in `code_anchors`, which only carries tracked checker-verifiable paths; tracked fixture paths join `code_anchors` in Phase A. OQ-1 closed (KD-7): prompt injection via L0 compile-time `{{USER_CAPSULE}}` template (same chain as `IDENTITY_BLOCK`/`TEAMMATE_ROSTER`); capsule queued in ADR-038 promote queue #2, injection anchor gated on PR-C landing (ETA 2026-06-13); hard cap 300 chars (~285 tokens); not in Staging / not in SystemPromptBuilder runtime per ADR-038 three-question check. See *(internal reference removed)*. OQ-4 closed (KD-8~11, 2026-06-13): Phase C nurturing loop = 3-stage pipeline — collect (KD-9 whitelist data contract: deterministic explainable events only, no classifier intent labeling; F221 no-background-surveillance) → distill (KD-10 runtime-neutral trigger on runtime invocation/session-seal/turn-completed events, not provider Stop hook; consolidation per opus47 dream-consolidation research, organize candidates not judge) → digest (cat/operator claims candidates into proposals; write-rule is layered per KD-12/15 below, NOT all-gated). F231 is a bounded profile consolidation pilot (KD-11), not a general dream lane. 46's L0 reflex demoted to a manual digest entry. See *(internal reference removed)*. Design deepening 2026-06-13 (KD-12~14, OQ-5): digest layer = cost-tiered signing + use-to-verify (only high-cost objective facts need operator signature; preferences written by cats, verified when used in real decisions and corrected on the spot); correction signals recognized via the participating cat's own understanding, never system keyword/pattern matching (KD-13); profile use = subconscious surfacing not table recitation (KD-14); injection layer (5k-to-500 funnel third stage) open as OQ-5 — injection is relevance retrieval, not intake judgment, does not break KD-8. Write-rule clarified (KD-15): low-cost autonomous writes go to per-cat layer (primer / user-signal lane) only, never directly into shared capsule (promotion needs operator signature or multi-cat corroboration); low-cost writes carry provenance (source coords + owner + status + correction path).

F209's entity registry is adjacent but not canonical for agent identity. Its `entity_id` / aliases are retrievable memory anchors with provenance; they may point to cats, humans, features, or external concepts, but they do not decide roster membership, current model, role, reviewer eligibility, or who a cat is.

## Use This When

- Changing who a cat is, how cats are loaded from roster/config, or how cat IDs are validated.
- Changing connector user/chat/thread binding, connector permission ownership, or external sender mapping.
- Changing frontend bubble identity, canonical invocation ID, or bubble kind identity rules.
- Changing runtime session binding, external conversation registration, cascade/session ownership, runtime-session list/read surfaces, or how `cliSessionId` maps to runtime-specific session IDs.
- Changing what cats know about their human at startup: user profile capsule content/injection, relationship primers, or which persona layer (breed/instance/user/relationship) a piece of identity data belongs to.

## Extend By

- For agent identity, update roster/config/schema contracts and keep CatId runtime-dynamic.
- For connector binding, use `ConnectorThreadBindingStore` and connector binding keys instead of ad hoc thread maps.
- For bubble identity, follow ADR-033 and route through `bubble-pipeline` contracts and tests.
- For runtime session binding, use Session Chain / runtime-session metadata keyed by Cat Cafe session id and runtime session id. IDE-direct registration belongs behind the external runtime registration contract and agent-key authorization, not ad hoc JSON maps.
- When a feature touches more than one subcell, declare each one in the feature's Architecture cell note and explain the boundary.
- If a feature consumes F209 `entity_id`, keep the direction one-way: identity/session truth may be referenced as provenance for entity aliases, but entity aliases must not rewrite roster or connector bindings.

## Do NOT Unify With

- `identity-agent` is not `identity-connector`. A roster cat ID does not prove an external user owns a connector binding.
- `identity-connector` is not `identity-bubble`. External chat/thread binding does not decide frontend bubble grouping.
- `identity-bubble` is not `identity-agent`. Bubble identity uses `(catId, canonicalInvocationId, bubbleKind)` inside a thread; it is not the source of roster truth.
- `identity-runtime-session` is not `identity-agent`. A runtime can switch model/profile inside one cascade; the session records identity history but does not decide roster truth.
- `identity-runtime-session` is not `memory`. Memory consumes transcript/digest evidence after runtime sessions are materialized; it does not own active cascade/conversation binding.
- `identity-user-profile` is not `memory`. The capsule is push-mode startup truth (injected every invocation); memory is pull-mode retrievable evidence. Shared capsule promotions are high-gate changes (operator signature or multi-cat corroboration per KD-15); low-cost per-cat primer/user-signal updates may be cat-authored with provenance and correction path (KD-12). Per-cat memory still does not auto-promote into shared capsule (KD-5 data minimization).
- `identity-user-profile` instance/user/relationship layers must never enter tracked shared assets (cat-template.json, public test baselines, outbound sync). Tracked tests verify the overlay mechanism via fixtures only (F231 KD-6).
- F209 `entity_id` is not `identity-agent`. Entity aliases such as `landy` / `operator` / `operator` or `gemini` / `Siamese` are retrieval anchors, not roster truth.
- `ConnectorThreadBindingStore` is an intentional shared touchpoint with `transport`: transport uses it for routing, while `identity-connector` uses it as the binding contract. Shared file ownership does not merge the cells.
- Do not add a generic `IdentityStore` to cover all subcells. Shared vocabulary is not shared ownership.

## Static Scan Hints

Watch for new or renamed `catId`, `CatId`, `AgentRegistry`, `cat-config`, `roster`, `ReviewerMatcher`, `ConnectorThreadBindingStore`, `Binding`, `bubbleIdentity`, `canonicalInvocationId`, `session`, `SessionChainStore`, `cliSessionId`, `cascadeId`, `runtimeSession`, and agent-facing `entity_id` code.
