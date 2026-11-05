---
cell_id: identity-session
title: Identity / Session
summary: Agent identity、connector session binding、bubble identity、runtime session binding、context continuity、thread access policy 与 user profile 等 subcell 的边界。
canonical_features: [F032, F088, F136, F171, F183, F211, F231, F262, F291, F296, F299, F320, F322]
code_anchors:
  - packages/api/src/routes/member-canon-response.ts
  - packages/api/src/routes/member-canon-routes.ts
  - packages/web/src/components/settings/members/MemberCanonAvatar.tsx
  - packages/api/src/domains/cats/services/agents/providers/pi/pi-session-store.ts
  - packages/api/src/domains/cats/services/agents/providers/pi/pi-session-runner.ts
  - packages/api/src/domains/cats/services/cloud-bridge/dot/dot-identity.ts
  - cat-config.json
  - packages/api/src/config/cat-config-loader.ts
  - packages/api/src/config/member-identity-sources.ts
  - packages/shared/src/member-profiles.ts
  - packages/shared/src/member-identity.ts
  - packages/shared/src/l0-input.ts
  - packages/shared/src/l0-input-capture.ts
  - packages/api/src/domains/cats/services/agents/providers/l0-input-capture.ts
  - packages/api/src/domains/cats/services/agents/providers/member-execution-preferences.ts
  - packages/api/src/domains/cats/services/agents/invocation/execution-account-binding.ts
  - packages/api/src/domains/cats/services/agents/invocation/host-execution-boundary.ts
  - packages/api/src/domains/cats/services/agents/invocation/execution-workspace.ts
  - packages/api/src/domains/cats/services/agents/invocation/invocation-service-scope.ts
  - packages/api/src/domains/cats/services/agents/registry/AgentRegistry.ts
  - packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts
  - packages/api/src/domains/cats/services/agents/session-contract/implementation-registry.ts
  - packages/api/src/domains/cats/services/agents/session-contract/registered-session-agent-service.ts
  - packages/api/src/domains/cats/services/agents/invocation/shared-mcp-launch.ts
  - packages/api/src/config/codex-cli.ts
  - packages/api/src/domains/cats/services/agents/providers/acp/AcpAgentService.ts
  - packages/api/src/domains/cats/services/agents/providers/acp/AcpServiceFactory.ts
  - packages/api/src/domains/cats/services/agents/providers/claude-mcp-config.ts
  - packages/api/src/domains/cats/services/agents/providers/kimi-mcp-config.ts
  - packages/api/src/domains/cats/services/agents/providers/opencode-config-writer.ts
  - packages/web/src/components/settings/members/member-save-record.ts
  - packages/web/src/components/settings/members/member-save-extras.ts
  - packages/api/src/config/account-resolver.ts
  - packages/api/src/config/account-store-snapshot.ts
  - packages/api/src/config/account-routing-capacity.ts
  - packages/api/src/config/codex-account-launch.ts
  - packages/api/src/config/codex-login-manager.ts
  - packages/api/src/config/codex-managed-layout.ts
  - packages/api/src/config/codex-shared-state.ts
  - packages/api/src/config/codex-account-reuse.ts
  - packages/api/src/config/codex-managed-support.ts
  - packages/api/src/config/codex-account-binding.ts
  - packages/api/src/config/local-account-selection.ts
  - packages/api/src/routes/accounts-native-view.ts
  - packages/api/src/config/cat-registry-reconciliation.ts
  - packages/api/src/config/codex-account-duplicates.ts
  - packages/shared/src/codex-account.ts
  - packages/api/src/config/codex-account-environment.ts
  - packages/api/src/config/codex-launch-config.ts
  - packages/api/src/config/codex-project-config-projection.ts
  - packages/api/src/config/codex-account-native-validation.ts
  - packages/api/src/domains/cats/services/agents/providers/codex-app-server-account-configuration.ts
  - packages/api/src/domains/cats/services/agents/providers/CodexUnixWebSocketSession.ts
  - packages/api/src/domains/cats/services/agents/providers/codex-app-server-control-options.ts
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
  - packages/api/src/domains/runtime-interaction/ports/RuntimeInteractionPort.ts
  - packages/api/src/domains/runtime-interaction/RuntimeInteractionService.ts
  - packages/api/src/domains/runtime-interaction/RuntimeConversationDecisionService.ts
  - packages/api/src/domains/runtime-interaction/ports/RuntimeConversationReturnGateway.ts
  - packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts
  - packages/api/src/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.ts
  - packages/api/src/domains/cats/services/agents/providers/agy-native/agy-native-continuity.ts
  - packages/api/src/domains/cats/services/agents/providers/agy-native/agy-native-skills.ts
  - packages/api/src/domains/cats/services/agents/providers/agy-native/agy-native-profile-turn.ts
  - packages/web/src/components/HubCatEditor.tsx
  - packages/web/src/components/ThreadSidebar/ThreadSpeedSettings.tsx
  - packages/web/src/debug/bubbleIdentity.ts
  - packages/api/src/domains/cats/services/stores/ports/SessionChainStore.ts
  - packages/api/src/domains/cats/services/session/context/ContextEpochOwner.ts
  - packages/api/src/domains/cats/services/session/context/PresentationLedger.ts
  - packages/api/src/domains/cats/services/session/context/authoritative-compaction.ts
  - packages/api/src/domains/cats/services/session/context/content-revision.ts
  - packages/api/src/domains/cats/services/session/context/context-continuity-telemetry.ts
  - packages/api/src/domains/cats/services/session/context/context-presentation.ts
  - packages/api/src/domains/cats/services/session/context/context-projection-telemetry-contract.ts
  - packages/api/src/domains/cats/services/session/context/context-surface-projection.ts
  - packages/api/src/domains/cats/services/session/context/delivery-receipt.ts
  - packages/api/src/domains/cats/services/session/context/ledger-key.ts
  - packages/api/src/domains/cats/services/session/thread-access-policy.ts
  - packages/api/src/domains/cats/services/session/CanonicalInvocationTrajectoryResolver.ts
  - packages/api/src/domains/cats/services/session/transcript-index/RequestGenerationProjector.ts
  - packages/api/src/domains/cats/services/session/transcript-index/request-generation-source-policy.ts
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
  - packages/api/src/domains/cats/services/runtime-session/LegacyAntigravitySessionImport.ts
  - packages/api/src/domains/cats/services/runtime-session/LegacyAntigravityLifecycle.ts
  - packages/shared/src/profile-contract.ts
  - packages/api/src/domains/cats/services/profile/ProfileRepository.ts
  - packages/api/src/domains/cats/services/profile/profile-migration-plan.ts
  - packages/api/src/domains/cats/services/profile/profile-migration.ts
  - packages/api/src/domains/cats/services/agents/providers/l0-compiler.ts
  - packages/api/src/domains/cats/services/agents/providers/l0-profile-cache.ts
  - packages/api/src/routes/callback-read-profile-routes.ts
  - packages/api/src/scripts/migrate-f231-profile.ts
doc_anchors:
  - docs/census/issue-1704-pi-native-state.md
  - docs/features/F320-multi-oauth-account-switching.md
  - feature-specs/2026-10-06-f320-codex-backend.md
  - docs/features/F032-agent-plugin-architecture.md
  - docs/features/F088-multi-platform-chat-gateway.md
  - docs/decisions/033-bubble-pipeline-identity-contract.md
  - docs/features/F211-cross-runtime-session-transparency.md
  - feature-discussions/2026-05-24-f211-design-memo/README.md
  - docs/features/F231-user-profile-capsule.md
  - docs/features/F262-per-thread-cat-effort-overrides.md
  - docs/features/F291-codex-oauth-fast-mode.md
  - docs/features/F296-continuity-aware-context-injection.md
  - docs/features/F299-workspace-invocation-trajectory.md
  - docs/features/F306-codex-app-capability-parity.md
  - feature-discussions/2026-08-08-f291-codex-oauth-fast-mode/README.md
  - feature-discussions/2026-06-13-f231-phase-c-design-gate.md
  - feature-discussions/2026-07-10-f231-profile-topology-convergence.md
static_scan_hints: [catId, relationshipKey, AgentRegistry, cat-config, roster, ConnectorThreadBindingStore, bubbleIdentity, session, SessionChainStore, ContextEpochOwner, PresentationLedger, cliSessionId, cascadeId, runtimeSession, runtimeInteractionPort, interactionId, serviceTier, CodexSpeed, memberSpeed, capsule, CAT_CAFE_DATA_DIR, cat-cafe-profile, "private/profile"]
cited_by:
  - {feature: F325, date: 2026-10-14, delta: "Native binds the canonical session to L0/cwd/mode and seals/rebuilds on proven preflight mismatch; retires Gemini CLI/IDE execution while preserving historical imports"}
  - {feature: F247, date: 2026-10-10, delta: dot G1 source-bound Events and private original image consumer}
  - {feature: F320, date: 2026-10-06, delta: "P2a provider-account boundary: existing resolver/store supplies a credential-free launch snapshot; final OAuth environment and native capability launch share selected account input; original host/resource owners retain control authority. Managed layout remains disabled pending P2b fixture blockers."}
  - {feature: F325, date: 2026-09-29, delta: "P1 compiles owner-bound native L0 through the existing shared compiler on each turn, keeps dynamic pack prepend out of that slot, and scopes operator coding grants to the exact live entrusted Task"}
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
  - {feature: F231, date: 2026-09-06, delta: "Phase E Design Gate closed — third profile layer: owner-wide shared corpus (profiles/<userId>/corpus/shared-facts.md) as proposal target 'corpus'; revision (profileRevisionOf) exposed on read/approve; F312 cue gains corpus anchor (memory cell reference); no new store/engine/authority. Contract: feature-discussions/2026-09-06-f231-phase-e-design-gate.md"}
  - {feature: F299, date: 2026-08-21, delta: "Phase B.2 thread-access-policy authority — Sessions / Transcript / Invocations / Theater share one read decision; user-indexed system threads expose only the current user's session-backed records."}
  - {feature: F299, date: 2026-08-23, delta: "Phase D transcript-owned request-generation evidence — immutable provider-bound bytes are durably appended before launch; TurnExecution joins generations across replacement Sessions; exact reveal inherits thread and segment source ownership."}
  - {feature: F296, date: 2026-09-30, delta: "continuity / presentation modules extracted as the session/context subdomain; canonical owners and runtime contracts unchanged"}
  - {feature: F306, date: 2026-08-27, delta: "Phase B invocation-bound runtime interaction identity — immutable user/thread/cat/invocation owner comes from AuditContext; provider thread/turn/item/request coordinates remain provenance; restart never reconstructs a waiter."}
  - {feature: F322, date: 2026-10-14, delta: "J3 runtime-interaction identity extension — one canonical record has either provider_request/provider_waiter or explicit conversation_decision/conversation_turn binding; only the latter remains pending across host restart and recovers its idempotent Message/Queue return."}
---

# Identity / Session

## Member identity and execution projections

The member catalog remains the identity owner. RoleProfile and ExecutionProfile are read-time views of its existing resolved member; field provenance comes from the same template/catalog read and is carried into the frozen binding. L0, teammate routing and the existing compiled preview share one dossier suppression decision. Explicit complete-config input remains authoritative; template-only legacy members retain a labelled dossier fallback. The official member page reconciles uncertain member writes by the original catId before retry, and saves strategy overrides and global Codex keys independently through their resource revisions. This adds no member database, approval authority or session store. Completing the admission/compiler consumer snapshot and native session compatibility remains a separate implementation step.

Architecture cell: identity-session

## Canonical Owner

This is a top-level routing cell with explicit, separately owned subcells. It exists to prevent identity and session concerns from becoming a garbage bin.

- `identity-agent`: F032 owns dynamic CatId, roster, AgentRegistry, roles, and reviewer matching.
- `identity-agent config`: F127 owns per-cat runtime defaults and provider/model capability; F262 extends that chain with raw `(threadId, catId)` effort overrides, and F291 adds OAuth Codex speed intent with carrier-specific projection. The thread store owns persistence, but effective effort/speed are derived after actual-cat routing at invocation time and are not navigation or session-strategy state.
- `provider-account`: F136/F171 own the existing account store snapshot and client/account resolver; F320 extends their consumption with a credential-free Codex launch descriptor. Account selection comes from `resolveForClient` and `readAccountStoreSnapshot`, with canonical home/state paths fixed for that invocation. Display names and token renewal are not account identity revisions. Final OAuth env/actual-carrier argv and RPC overlays are checked after composition. A bounded sensitive-field projection retains layer/path origin; the same initialized app-server supplies native config, requirements and read-only account observations before business RPC. This does not prove safe authentication access before bootstrap and does not enable unknown managed-policy/carrier combinations. `prepareCodexHostLaunch`, the original host leases remain the owners of execution, control and recovery authority; the descriptor cannot grant resource access. No second account store or routing authority is introduced.
- `identity-connector`: F088 owns connector principal link and external chat/thread binding.
- `identity-bubble`: F183 / ADR-033 own frontend bubble identity within a thread.
- `identity-runtime-session`: F211 owns runtime session identity and binding for long-lived or external runtimes: cascade/conversation IDs, SessionChainStore bridge records, lifecycle registration, hidden external-runtime anchor threads, seal reason, and per-session identity history.
- `context-continuity`: F296 owns the context epoch, presentation ceiling, content-free delivery ledger and authoritative-compaction admission. These modules decide what can enter one prompt generation without taking ownership of source bodies, Session transcript persistence or provider session identity.
- `thread-access-policy`: F299 Phase B.2 owns the canonical read decision for session-backed thread resources. Owner threads are thread-scoped; shared default, user-indexed system threads, and matching external-runtime anchors are current-user-scoped. Sessions, Transcript, Invocations, and Theater must consume this authority instead of spelling owner/default checks in each route.
- `request-generation evidence`: F299 Phase D is an immutable event family inside the existing Session transcript, not a new store. The active Session at each launch owns that generation's assembled event; the durable child `TurnExecution` is the cross-Session join coordinate. Provider adapters must await the transcript commit before launch, and the invocation-scoped projector must reuse `thread-access-policy` plus each segment's source owner before revealing exact bytes.
- `runtime-interaction identity`: F306 binds one provider-neutral interaction port from the invocation's authenticated `AuditContext`. The immutable owner is exact `(userId, threadId, catId, invocationId)`. A provider request binds opaque provider coordinates to a process-local `provider_waiter`, which is never restored after restart. F322 J3 adds an explicit `conversation_decision` source bound instead to a durable `conversation_turn`: it keeps the same canonical detail/owner index, monotonic revision, card liveness fence, and single lifecycle writer, but survives host restart and recovers the winning idempotent Message/Queue return. The two binding kinds are mutually validated and never inferred from a missing waiter. One Redis namespace still has one active API lifecycle writer; multi-instance provider waiter routing remains unsupported and fails closed as `transport_lost` instead of guessing which process owns the provider run.
- `identity-user-profile`: F231 owns three per-user profile layers: the ≤300-char capsule anchor (operator-manual), the per-(user×persona) relationship primer, and the owner-wide **shared corpus** (`corpus/shared-facts.md`, proposal target `targetLayer: 'corpus'`, operator-approved via the same Approval Hub writer; Phase E, gate closed 2026-09-06). `catId` routes work, F208/model identity describes capability, and `relationshipKey` names stable relationship continuity. Canonical private content lives at `${CAT_CAFE_DATA_DIR}/profiles/<userId>/`; tracked code owns the repository/authentication contract, never the private bytes. L0 keeps the ≤300-char capsule plus `cat-cafe-profile://relationship/current`; the authenticated read surface derives user/persona from its principal. Profile proposals, approvals, provenance, L0 compilation, and cache invalidation share `FileProfileRepository`. Worktree-local `private/profile/` is legacy migration input only, with hash-guarded conflict resolution and rollback backup.

F209's entity registry is adjacent but not canonical for agent identity. Its `entity_id` / aliases are retrievable memory anchors with provenance; they may point to cats, humans, features, or external concepts, but they do not decide roster membership, current model, role, reviewer eligibility, or who a cat is.

## Use This When

- Changing who a cat is, how cats are loaded from roster/config, or how cat IDs are validated.
- Changing provider account selection, canonical credential/state paths, launch env or the account snapshot consumed by native probes and controls.
- Changing connector user/chat/thread binding, connector permission ownership, or external sender mapping.
- Changing frontend bubble identity, canonical invocation ID, or bubble kind identity rules.
- Changing runtime session binding, external conversation registration, cascade/session ownership, runtime-session list/read surfaces, or how `cliSessionId` maps to runtime-specific session IDs.
- Changing context epoch transitions, presentation ceilings, delivery dedupe, authoritative compaction admission or their bounded telemetry contract.
- Changing whether an identity may list or read session-backed resources for a thread, or how shared/system threads filter records by user.
- Changing provider request-generation identity, pre-launch transcript durability, cross-Session generation resolution, or exact segment reveal.
- Changing how a mid-run human interaction is bound to its authenticated invocation owner or exact provider request coordinates.
- Changing what cats know about their human at startup: user profile capsule content/injection, relationship primers, or which persona layer (breed/instance/user/relationship) a piece of identity data belongs to.

## Extend By

- For agent identity, update roster/config/schema contracts and keep CatId runtime-dynamic.
- For provider accounts, resolve through the existing account store, pass one launch snapshot into the existing execution boundary, and finalize authentication env after all overlays. Control and reconnect reuse the accepted launch options and validate the same initialized connection before business RPC. API/custom probes and calls share a stable account/config/private execution root; Collective remains separately isolated. Collective keeps its isolated instructions, skills, history and SQLite root while projecting only the selected existing file login. Managed account layout is not enabled by P2a; its remaining continuity/configuration checks are in the F320 plan and fixture evidence.
- For thread-scoped agent runtime config, persist only raw intent and project it through the current roster/provider/model capability after actual-cat routing; keep typed invocation options and provider argv validation as the execution boundary. Existing execution admission captures member model/effort and thread effort/speed before leases; the provider consumes that snapshot while adopted values remain separate observations. Workspace capture copies the ThreadStore record rather than retaining a mutable in-memory store reference.
- ACP admission consumes the existing MCP resolver through the concrete pinned service and stores owned descriptors in the execution binding. Session ownership still materializes the current turn's callback credentials; descriptor capture does not move credential or tool authority.
- Host admission also captures the existing shared MCP context and transport in that binding. Invocation creation and callback materialization consume the same immutable deployment, data/workspace roots and admitted families; they do not repeat discovery after admission. This does not replace the MCP request authority or its revocation checks.
- Implementation registration and concrete service generations remain process-local to their existing registry owners. Invocation pins inherit the concrete service token; registered views validate their captured registration and service again before admission completes. The binding carries only the owned key/generation pair. This is neither a persistent client version nor proof of cross-restart session compatibility, and it does not replace the existing launch fence or lease lifecycle.
- Admission rechecks the same existing account/execution projection after asynchronous provider discovery. Changed consumed account or launch-policy values reject that admission; unrelated account metadata excluded by the existing runtime resolver does not become a new execution input. This adds no account store, credential hash or global revision service, and is not the remaining multi-owner reparse protocol.
- Router refresh updates its owned service and unavailability tables in place. Retained strategy dependencies therefore resolve later members against the current registry at dequeue, while an invocation already holding a concrete service keeps that reference. Registry publication remains synchronous; no polling, event bus or new execution authority is introduced.
- Codex native declares its construction client; the ACP factory captures the member clientId before asynchronous preparation and passes that provenance into its concrete service. Registered views preserve the child's declared client and generation. Admission rejects a declared client mismatch before discovery, independently of model, display name or command spelling. This does not authenticate a remote executable or imply unported native-client coverage.
- For connector binding, use `ConnectorThreadBindingStore` and connector binding keys instead of ad hoc thread maps.
- For bubble identity, follow ADR-033 and route through `bubble-pipeline` contracts and tests.
- For runtime session binding, use Session Chain / runtime-session metadata keyed by Clowder AI session id and runtime session id. IDE-direct registration belongs behind the external runtime registration contract and agent-key authorization, not ad hoc JSON maps.
- Managed invocation records selected Host client/carrier, process-local implementation generation, account reference and normalized workspace/project in the existing SessionRecord before provider entry. SessionChainStore owns write-once/CAS comparison; a changed or unknown native binding uses the existing seal/rebuild flow, while an unproven explicit import fails in place. These facts are not native adoption evidence, a stable implementation version, native state-root proof, credential revision or the complete CompatKey. AGY Native binding checks remain independent.
- Codex contributes adapter-provided `accountStateRoot` and `accountOwnerRoot` when its selected launch descriptor proves them; generic adapters omit these fields until they expose equivalent verified facts. The projection never derives a state root from arbitrary environment variables or persists credentials.
- For context continuity, extend `session/context/` and preserve its separation from transcript persistence, Session lifecycle and F299 request-generation evidence. Source domains retain body/revision/invalidator truth; provider receipt is the only delivery-commit authority.
- For session-backed thread reads, call `thread-access-policy`; a user index grants current-user-scoped reads, never access to every user's records under that thread id.
- For request-generation evidence, append to the generation's active Session and join through the exact child invocation. Keep source bodies behind their existing owner resolvers; typed `unknown` is the safe result when no owner resolver exists.
- For runtime interactions, derive owner identity from `AuditContext`, pass only the provider-neutral port through `AgentServiceOptions`, and invalidate process-local waiters on provider cancellation, transport loss, or host restart. Keep one active API lifecycle writer per Redis namespace; any future multi-instance topology needs a separate owner-lease and waiter-routing Design Gate. Never accept owner coordinates from a response body; browser reads and writes require the same strict authenticated owner, while the exact canonical `(threadId, messageId, blockId)` card ref is an additional response fence rather than the identity principal. Provider requests must also match the active app-server thread and every turn coordinate the upstream protocol supplies before publication; MCP's protocol-defined standalone `turnId:null` remains explicit provenance rather than a guessed turn. The canonical message/block must still be live immediately before terminal CAS.
- When a feature touches more than one subcell, declare each one in the feature's Architecture cell note and explain the boundary.
- If a feature consumes F209 `entity_id`, keep the direction one-way: identity/session truth may be referenced as provenance for entity aliases, but entity aliases must not rewrite roster or connector bindings.

## Do NOT Unify With

- `identity-agent` is not `identity-connector`. A roster cat ID does not prove an external user owns a connector binding.
- Provider account configuration is not proof of the account that executed a historical reply. Actual execution evidence owns that attribution. A display name is user text, and neither renaming nor token renewal changes the launch identity. Sharing native session state does not authorize sharing secrets or changing the native same-thread single-writer contract.
- `identity-connector` is not `identity-bubble`. External chat/thread binding does not decide frontend bubble grouping.
- `identity-bubble` is not `identity-agent`. Bubble identity uses `(catId, canonicalInvocationId, bubbleKind)` inside a thread; it is not the source of roster truth.
- `identity-runtime-session` is not `identity-agent`. A runtime can switch model/profile inside one cascade; the session records identity history but does not decide roster truth.
- `thread-access-policy` is not sidebar presentation. The durable user index is one policy input; a route must still apply the returned record scope before reading sessions, transcripts, invocations, or Theater replay data.
- Request-generation evidence is not a second prompt store or context ledger. F296 owns presentation/continuity decisions, source domains own their bodies and lifecycle, and F299 records only the immutable provider-bound assembly plus refs and typed capability.
- Runtime-interaction identity is not a provider session store. The durable record proves who may answer and what provider request it came from; it does not replace `SessionChainStore`, reconstruct a provider waiter, or authorize replay after restart.
- `identity-runtime-session` is not `memory`. Memory consumes transcript/digest evidence after runtime sessions are materialized; it does not own active cascade/conversation binding.
- `identity-user-profile` is not `memory`. The capsule is push-mode startup truth; the persona primer is an authenticated profile read, while memory is pull-mode retrievable evidence. Shared capsule promotions are high-gate changes (KD-15); low-cost persona-primer/user-signal updates carry proposer provenance and correction paths (KD-12/18). Memory does not auto-promote into either profile layer (KD-5 data minimization).
- `identity-user-profile` instance/user/relationship layers must never enter tracked shared assets (cat-template.json, public test baselines, outbound sync). Tracked tests verify the overlay mechanism via fixtures only (F231 KD-6).
- F209 `entity_id` is not `identity-agent`. Entity aliases such as `operator` / `operator` / `operator` or `gemini` / `Siamese` are retrieval anchors, not roster truth.
- `ConnectorThreadBindingStore` is an intentional shared touchpoint with `transport`: transport uses it for routing, while `identity-connector` uses it as the binding contract. Shared file ownership does not merge the cells.
- Do not add a generic `IdentityStore` to cover all subcells. Shared vocabulary is not shared ownership.

## Static Scan Hints

Watch for new or renamed `catId`, `relationshipKey`, `ProfileRepository`, `CAT_CAFE_DATA_DIR`, `cat-cafe-profile`, `AgentRegistry`, `cat-config`, `roster`, `ReviewerMatcher`, `ConnectorThreadBindingStore`, `Binding`, `bubbleIdentity`, `canonicalInvocationId`, `session`, `SessionChainStore`, `cliSessionId`, `cascadeId`, `runtimeSession`, and agent-facing `entity_id` code.

### Codex account journey

The existing account store owns managed account metadata, immutable principal coordinates, notes, login attempt revisions and per-account read-only quota observations. Official Codex owns PKCE, callback validation and credential writing; `CodexLoginManager` only retains live carrier cancellation handles and persists facts through the existing store. Staged results require current attempt identity before adoption, and cannot replace an established principal silently. The running member catalog owns `selectedAccountRefs` and each member's follow/override intent; account metadata stays in its persistent workspace owner. A confirmed preview and one catalog write switch the enabled local Codex followers across families, with explicit inclusion of exceptions and exclusion of disabled/cloud members. Invocation, usage and realtime transcripts retain their accepted execution snapshot. Native default rows are read-only projections of the existing resolver and actual credential home; listing or logging into a backup account does not switch members.

F293 consumes a credential-free projection of that same store: canonical account label, opaque pool/binding/evidence refs and exact-principal observations. The projection neither selects accounts nor proves that a model/execution consumes a particular pool. Pool applicability remains unknown without a provider-issued proof on the frozen execution binding; no accountRef, principal ID or credential path crosses into F293 subjects or evidence. A frozen execution continues to use its accepted account when the live member selection later changes.

The measured first managed combination is macOS + official native Codex 0.159.0 + private file authentication, without forced MDM or legacy managed/requirements policy and without cloud-eligible enterprise/business/education plans. Native personal and team-like plans remain eligible. Unsupported combinations are rejected before credential-bearing launch; no policy is disabled. Shared session/SQLite/memory/image/config state has explicit roots, while auth, secrets, temporary/control state and plugin/browser authentication stay private. Installed-native layout and source-consumer fixtures cover this implementation; real OAuth and cross-account server compaction require owner authorization and remain unclaimed until exercised.

## F325 Native continuity and retirement

Native uses the existing SessionManager/SessionChainStore for durable resume bindings, not an in-memory session authority. A verified preflight L0/cwd/permission mismatch can seal the old session and rebuild from canonical history before starting a new one; partial output and exact imported-resume requests cannot silently fall back. Profile serialization protects per-turn credential/config binding. Skills come from the existing mount resolver. Historical Antigravity session import/lifecycle remain readable; Gemini CLI, IDE bridge and SQLite polling are no longer execution carriers.

Official CLI init is verified before stdin delivery; only then does the existing F296 preflight settle the final generation and F299 record its bytes. A prior unsupported scope adopts a newly observed runtime through one unconsumed cold epoch; it becomes hot only after actual generation consumption and another verified resume. Compaction checkpoints advance the existing epoch owner. The raw cumulative result/error and transport diagnostics remain separate from current-turn completion evidence.

## Frozen L0 Input

L0 input capture remains with the existing invocation/compiler owner. Shared Node-only capture and pure rendering are used by the diagnostic CLI and API without bootstrapping a second registry in the invocation child. The admission binding carries private immutable input in memory; the child receives it through its existing stdin pipe and caches by content digest plus compiler version. Native provider and AGY control consumers must receive that input, while standalone live diagnostics label their revision. This does not create another identity store or session authority; complete execution/MCP/policy/implementation freezing is a separate remaining boundary.

The existing invocation scope owns failed admission pins. Serial and parallel routes release a failed pin and resolve one fresh view only for an owned configuration conflict before provider invocation; a second conflict is terminal for this admission. Provider sends and opaque status codes do not enter that retry. This does not establish persistent session compatibility or a new retry owner.

Generic ACP's explicit account reference is resolved by the existing account owner at admission. The existing ACP factory checks its private construction-time account source around MCP capture; stale pool inputs reject new admission, while an admitted invocation keeps its captured service. No private account body is added to session compatibility or durable audit by this guard.

Catalog ACP construction retains owned launch settings and its existing catalog accessor. Invocation capture validates that source before and after MCP capture; admitted plans and the L0 child do not call the accessor. Plugin lifecycle remains with implementation registration rather than a new launch registry.

## 会话取消与终态边界

现有 session bridge 在取消时关闭补充输入，但继续收束原 provider 事件；取消回包不作为终态。ACP session provider 在原源迭代器清理完成之后才发布终态和解除 active；清理失败不被本地 cancelled 覆盖，也不能经包装器二次 return 清除 busy。该边界复用现有 session/iterator owner，不新增取消状态库。传输层提前 done、未知执行恢复、原生停机证明与完整 C12 仍须在各自 owner 闭环。

## Canon Member Avatar Consumer

F326 Phase D resolves the existing member id, then projects its one member-avatar slot from collaborative-content-plane. The direct Human selects it with its own receipt; mixed avatar/profile PATCH is rejected before either write. Linked members keep the canon projection after profile-only saves, clear remains linked, and unreadable bound bytes never fall back to catalog or another image. This consumer does not move roster or member authority.

单飞 ACP 的 lease.release 由既有 retirement barrier 证明实际进程关闭，service finally 必须等待；重复或过代 lease 仍观察该关闭结果。排队退休与移除 pool entry 不等于原生已停止，关闭失败不能由 Bridge 转成成功取消。本切片未改变 multiplexed carrier 的 session sealing 或 Host 路由的有界清理策略。

Host 通过现有 AgentService 的内部 cancellationMode:drain 声明识别 adapter 对取消及清理的所有权，不用 vendor 名推断。invocation 对该流等待清理，parallel merge 不提前合成其终态；声明固定在 Registered invocation view。未声明的 legacy 继续原有有界退出。该声明不是对未知/失败停止或全部平台的认证。

并行 invocation 的局部 AbortController 合入 batch/per-cat 信号；merger 对声明 drain 的 child 拥有退出取消与等待责任，所有受控 child 清理结束后再报告错误。原生 ACP 提前 return 时必须先在仍有活动请求的内层边界取消，再关闭 promptStream，不能把移除本地监听误认成上游停止。关闭失败的 unknown/恢复仍由既有执行 owner 待闭环。

启动恢复的原 interruptRunningBefore 不以 Host 年龄证明 native 停止：providerLifecycleTracked 且已有 providerStartedAt、没有 providerTeardownAt 的 child 继续 running，不进入 response 终态收尾。停止证明由原执行 owner 写回原字段之后，才可沿已有恢复收敛；这是原记录的判断，不是新的取消状态权威。

ACP 进程 error 仅标记连接不可复用；真实 exit 才能设置 exited。close 对已经取得 PID 的原生进程继续受控停止并等待，不能因更早的 error 跳过；启动失败从未取得 PID 则无进程可发信号。连接 closed 与进程退出仍是不同事实。
