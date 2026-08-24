---
cell_id: identity-session
title: Identity / Session
summary: Agent identity、connector session binding、bubble identity、runtime session binding、thread access policy、user profile 六个 subcell 的边界。
canonical_features: [F032, F088, F183, F211, F231, F262, F291, F299]
code_anchors:
  - cat-config.json
  - packages/api/src/config/cat-config-loader.ts
  - packages/shared/src/cli-effort.ts
  - packages/shared/src/codex-speed.ts
  - packages/shared/src/types/thread-speed.ts
  - packages/shared/src/types/cat.ts
  - packages/api/src/infrastructure/connectors/ConnectorThreadBindingStore.ts
  - packages/api/src/infrastructure/connectors/connector-binding-keys.ts
  - packages/api/src/routes/thread-cats-core.ts
  - packages/api/src/routes/thread-member-effort.ts
  - packages/api/src/routes/thread-member-speed.ts
  - packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts
  - packages/api/src/domains/cats/services/agents/invocation/request-generation-recorder.ts
  - packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts
  - packages/web/src/components/HubCatEditor.tsx
  - packages/web/src/components/ThreadSidebar/ThreadSpeedSettings.tsx
  - packages/web/src/debug/bubbleIdentity.ts
  - packages/api/src/domains/cats/services/stores/ports/SessionChainStore.ts
  - packages/api/src/domains/cats/services/session/thread-access-policy.ts
  - packages/api/src/domains/cats/services/session/CanonicalInvocationTrajectoryResolver.ts
  - packages/api/src/domains/cats/services/session/RequestGenerationProjector.ts
  - packages/api/src/domains/cats/services/session/request-generation-source-policy.ts
  - packages/api/src/domains/cats/services/session/TranscriptWriter.ts
  - packages/api/src/routes/session-chain.ts
  - packages/api/src/routes/session-transcript.ts
  - packages/api/src/routes/invocation-trajectory-routes.ts
  - packages/shared/src/types/request-generation-envelope.ts
  - packages/web/src/components/workspace/trajectory/request-generation-card.tsx
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
  - packages/shared/src/profile-contract.ts
  - packages/api/src/domains/cats/services/profile/ProfileRepository.ts
  - packages/api/src/domains/cats/services/profile/profile-migration-plan.ts
  - packages/api/src/domains/cats/services/profile/profile-migration.ts
  - packages/api/src/domains/cats/services/agents/providers/l0-compiler.ts
  - packages/api/src/domains/cats/services/agents/providers/l0-profile-cache.ts
  - packages/api/src/routes/callback-read-profile-routes.ts
  - packages/api/src/scripts/migrate-f231-profile.ts
doc_anchors:
  - docs/features/F032-agent-plugin-architecture.md
  - docs/features/F088-multi-platform-chat-gateway.md
  - docs/decisions/033-bubble-pipeline-identity-contract.md
  - docs/features/F211-cross-runtime-session-transparency.md
  - feature-discussions/2026-05-24-f211-design-memo/README.md
  - docs/features/F231-user-profile-capsule.md
  - docs/features/F262-per-thread-cat-effort-overrides.md
  - docs/features/F291-codex-oauth-fast-mode.md
  - docs/features/F299-workspace-invocation-trajectory.md
  - feature-discussions/2026-08-08-f291-codex-oauth-fast-mode/README.md
  - feature-discussions/2026-06-13-f231-phase-c-design-gate.md
  - feature-discussions/2026-07-10-f231-profile-topology-convergence.md
static_scan_hints: [catId, relationshipKey, AgentRegistry, cat-config, roster, ConnectorThreadBindingStore, bubbleIdentity, session, SessionChainStore, cliSessionId, cascadeId, runtimeSession, serviceTier, CodexSpeed, memberSpeed, capsule, CAT_CAFE_DATA_DIR, cat-cafe-profile, "private/profile"]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F193, date: 2026-05-08, delta: Phase B — typed crossThreadReplyHint field on InvocationContext + render block in buildInvocationContext (receiver-side reply hint hydrated from trigger message id)}
  - {feature: F209, date: 2026-05-22, delta: "boundary note — F209 entity_id is a retrievable entity doorway, not roster truth"}
  - {feature: F211, date: 2026-05-24, delta: "new identity-runtime-session subcell for runtime session identity, cascade/conversation binding, lifecycle registration, seal reason, and identity history"}
  - {feature: F211, date: 2026-05-25, delta: "Phase B external runtime registration/list/read surfaces, hidden anchor threads, and agent-key-only IDE-direct session binding"}
  - {feature: F231, date: 2026-06-11, delta: "new identity-user-profile subcell — per-user profile capsule + relationship primer + breed/instance/user/relationship persona layering; data anchors private/profile/ + .cat-cafe/cat-catalog.json personality (gitignored, per-instance); prompt injection anchor pending Design Gate (OQ-1, ADR-038 L0 budget alignment)"}
  - {feature: F231, date: 2026-06-11, delta: "OQ-1 closed (KD-7) — prompt injection layer = L0 compile-time {{USER_CAPSULE}} template (compile-system-prompt-l0.mjs same chain as IDENTITY_BLOCK/TEAMMATE_ROSTER); capsule queued in ADR-038 promote queue #2, injection anchor gated on PR-C landing (codex/gpt52 demote to ≤6000 tokens, ETA 2026-06-13); hard cap 300 chars (~285 tokens); not in Staging / not in SystemPromptBuilder runtime — ADR-038 three-question check: capsule is full-conversation identity (compression loss = harmful gap), must stay L0; decision: feature-discussions/2026-06-11-f231-design-gate.md"}
  - {feature: F231, date: 2026-06-13, delta: "OQ-4 closed (KD-8~11) — Phase C nurturing loop = 3-stage pipeline (collect→distill→digest), system-gives-data / cat-operator-gives-conclusion throughout (F227 KD-8 no-classifier line). KD-9 collection whitelist data contract (deterministic explainable events only; forbids classifier labeling like 'this is a relationship signal'); KD-10 runtime-neutral distill trigger on Clowder AI runtime invocation/session-seal/turn-completed events, NOT provider Stop hook (codex exec --json does not dispatch ~/.codex/hooks.json Stop hook, CodexAgentService.ts); KD-11 F231 = bounded profile consolidation pilot (dry-run proposal + provenance, no general dream lane). 46's L0 reflex demoted to a manual digest-stage entry, not main path. Decision: feature-discussions/2026-06-13-f231-phase-c-design-gate.md"}
  - {feature: F231, date: 2026-06-13, delta: "Phase C design deepening (operator co-creation) — KD-12 digest layer = cost-tiered signing + use-to-verify: only high-cost objective facts (health/safety/irreversible) need operator signature; preferences/impressions written autonomously by cats and verified in-use (profile used in a real decision, operator reacts, corrected on the spot), push-approval becomes pull-calibration (solves humans-won't-approve-daily + self-view-is-distorted). KD-13 correction signal = highest-priority collection source but recognized via the participating cat's own understanding, NEVER via system keyword/pattern matching (human phrasing too varied = classifier in disguise); distinct from magic-word (operator's bounded agreed triggers, still matchable). KD-14 profile use = subconscious surfacing (internalized intuition, not table-lookup recitation), anti-class-tone. OQ-5 (open): injection layer / 50k-5k-500 funnel third stage (dynamic vs pull vs static); injection = relevance retrieval not intake judgment, does not break KD-8."}
  - {feature: F262, date: 2026-07-10, delta: "identity-agent config extension — thread-scoped raw cat effort override, projected through current provider/model capability and consumed at every invocation after actual-cat routing"}
  - {feature: F291, date: 2026-08-08, delta: "identity-agent config extension — OAuth Codex member and thread-scoped speed intent, projected after actual-cat routing and mapped to carrier-specific service-tier wire states"}
  - {feature: F231, date: 2026-06-13, delta: "Phase C write-rule cleanup (codex REQUEST-CHANGES P1) — removed stale 'all changes via operator review' wording that conflicted with KD-12; KD-15 added: low-cost autonomous writes target per-cat layer (primer / user-signal lane) ONLY, NOT shared capsule directly (promotion to shared capsule needs high bar: operator signature or multi-cat corroboration); low-cost writes require provenance (source coords + owner cat + status + correction path)."}
  - {feature: F231, date: 2026-07-10, delta: "Phase D topology repair (KD-18/19) — relationship continuity is per-persona relationshipKey, canonical private truth lives under CAT_CAFE_DATA_DIR/profiles/<userId>, L0 emits cat-cafe-profile://relationship/current, authenticated read/propose/approve share FileProfileRepository, legacy private/profile is migration input only."}
  - {feature: F299, date: 2026-08-21, delta: "Phase B.2 thread-access-policy authority — Sessions / Transcript / Invocations / Theater share one read decision; user-indexed system threads expose only the current user's session-backed records."}
  - {feature: F299, date: 2026-08-23, delta: "Phase D transcript-owned request-generation evidence — immutable provider-bound bytes are durably appended before launch; TurnExecution joins generations across replacement Sessions; exact reveal inherits thread and segment source ownership."}
---

# Identity / Session

Architecture cell: identity-session

## Canonical Owner

This is a top-level routing cell with six subcells. It exists to prevent identity concerns from becoming a garbage bin.

- `identity-agent`: F032 owns dynamic CatId, roster, AgentRegistry, roles, and reviewer matching.
- `identity-agent config`: F127 owns per-cat runtime defaults and provider/model capability; F262 extends that chain with raw `(threadId, catId)` effort overrides, and F291 adds OAuth Codex speed intent with carrier-specific projection. The thread store owns persistence, but effective effort/speed are derived after actual-cat routing at invocation time and are not navigation or session-strategy state.
- `identity-connector`: F088 owns connector principal link and external chat/thread binding.
- `identity-bubble`: F183 / ADR-033 own frontend bubble identity within a thread.
- `identity-runtime-session`: F211 owns runtime session identity and binding for long-lived or external runtimes: cascade/conversation IDs, SessionChainStore bridge records, lifecycle registration, hidden external-runtime anchor threads, seal reason, and per-session identity history.
- `thread-access-policy`: F299 Phase B.2 owns the canonical read decision for session-backed thread resources. Owner threads are thread-scoped; shared default, user-indexed system threads, and matching external-runtime anchors are current-user-scoped. Sessions, Transcript, Invocations, and Theater must consume this authority instead of spelling owner/default checks in each route.
- `request-generation evidence`: F299 Phase D is an immutable event family inside the existing Session transcript, not a new store. The active Session at each launch owns that generation's assembled event; the durable child `TurnExecution` is the cross-Session join coordinate. Provider adapters must await the transcript commit before launch, and the invocation-scoped projector must reuse `thread-access-policy` plus each segment's source owner before revealing exact bytes.
- `identity-user-profile`: F231 owns the per-user capsule and per-(user×persona) relationship primer. `catId` routes work, F208/model identity describes capability, and `relationshipKey` names stable relationship continuity. Canonical private content lives at `${CAT_CAFE_DATA_DIR}/profiles/<userId>/`; tracked code owns the repository/authentication contract, never the private bytes. L0 keeps the ≤300-char capsule plus `cat-cafe-profile://relationship/current`; the authenticated read surface derives user/persona from its principal. Profile proposals, approvals, provenance, L0 compilation, and cache invalidation share `FileProfileRepository`. Worktree-local `private/profile/` is legacy migration input only, with hash-guarded conflict resolution and rollback backup.

F209's entity registry is adjacent but not canonical for agent identity. Its `entity_id` / aliases are retrievable memory anchors with provenance; they may point to cats, humans, features, or external concepts, but they do not decide roster membership, current model, role, reviewer eligibility, or who a cat is.

## Use This When

- Changing who a cat is, how cats are loaded from roster/config, or how cat IDs are validated.
- Changing connector user/chat/thread binding, connector permission ownership, or external sender mapping.
- Changing frontend bubble identity, canonical invocation ID, or bubble kind identity rules.
- Changing runtime session binding, external conversation registration, cascade/session ownership, runtime-session list/read surfaces, or how `cliSessionId` maps to runtime-specific session IDs.
- Changing whether an identity may list or read session-backed resources for a thread, or how shared/system threads filter records by user.
- Changing provider request-generation identity, pre-launch transcript durability, cross-Session generation resolution, or exact segment reveal.
- Changing what cats know about their human at startup: user profile capsule content/injection, relationship primers, or which persona layer (breed/instance/user/relationship) a piece of identity data belongs to.

## Extend By

- For agent identity, update roster/config/schema contracts and keep CatId runtime-dynamic.
- For thread-scoped agent runtime config, persist only raw intent and project it through the current roster/provider/model capability after actual-cat routing; keep typed invocation options and provider argv validation as the execution boundary.
- For connector binding, use `ConnectorThreadBindingStore` and connector binding keys instead of ad hoc thread maps.
- For bubble identity, follow ADR-033 and route through `bubble-pipeline` contracts and tests.
- For runtime session binding, use Session Chain / runtime-session metadata keyed by Clowder AI session id and runtime session id. IDE-direct registration belongs behind the external runtime registration contract and agent-key authorization, not ad hoc JSON maps.
- For session-backed thread reads, call `thread-access-policy`; a user index grants current-user-scoped reads, never access to every user's records under that thread id.
- For request-generation evidence, append to the generation's active Session and join through the exact child invocation. Keep source bodies behind their existing owner resolvers; typed `unknown` is the safe result when no owner resolver exists.
- When a feature touches more than one subcell, declare each one in the feature's Architecture cell note and explain the boundary.
- If a feature consumes F209 `entity_id`, keep the direction one-way: identity/session truth may be referenced as provenance for entity aliases, but entity aliases must not rewrite roster or connector bindings.

## Do NOT Unify With

- `identity-agent` is not `identity-connector`. A roster cat ID does not prove an external user owns a connector binding.
- `identity-connector` is not `identity-bubble`. External chat/thread binding does not decide frontend bubble grouping.
- `identity-bubble` is not `identity-agent`. Bubble identity uses `(catId, canonicalInvocationId, bubbleKind)` inside a thread; it is not the source of roster truth.
- `identity-runtime-session` is not `identity-agent`. A runtime can switch model/profile inside one cascade; the session records identity history but does not decide roster truth.
- `thread-access-policy` is not sidebar presentation. The durable user index is one policy input; a route must still apply the returned record scope before reading sessions, transcripts, invocations, or Theater replay data.
- Request-generation evidence is not a second prompt store or context ledger. F296 owns presentation/continuity decisions, source domains own their bodies and lifecycle, and F299 records only the immutable provider-bound assembly plus refs and typed capability.
- `identity-runtime-session` is not `memory`. Memory consumes transcript/digest evidence after runtime sessions are materialized; it does not own active cascade/conversation binding.
- `identity-user-profile` is not `memory`. The capsule is push-mode startup truth; the persona primer is an authenticated profile read, while memory is pull-mode retrievable evidence. Shared capsule promotions are high-gate changes (KD-15); low-cost persona-primer/user-signal updates carry proposer provenance and correction paths (KD-12/18). Memory does not auto-promote into either profile layer (KD-5 data minimization).
- `identity-user-profile` instance/user/relationship layers must never enter tracked shared assets (cat-template.json, public test baselines, outbound sync). Tracked tests verify the overlay mechanism via fixtures only (F231 KD-6).
- F209 `entity_id` is not `identity-agent`. Entity aliases such as `landy` / `operator` / `operator` or `gemini` / `Siamese` are retrieval anchors, not roster truth.
- `ConnectorThreadBindingStore` is an intentional shared touchpoint with `transport`: transport uses it for routing, while `identity-connector` uses it as the binding contract. Shared file ownership does not merge the cells.
- Do not add a generic `IdentityStore` to cover all subcells. Shared vocabulary is not shared ownership.

## Static Scan Hints

Watch for new or renamed `catId`, `relationshipKey`, `ProfileRepository`, `CAT_CAFE_DATA_DIR`, `cat-cafe-profile`, `AgentRegistry`, `cat-config`, `roster`, `ReviewerMatcher`, `ConnectorThreadBindingStore`, `Binding`, `bubbleIdentity`, `canonicalInvocationId`, `session`, `SessionChainStore`, `cliSessionId`, `cascadeId`, `runtimeSession`, and agent-facing `entity_id` code.
