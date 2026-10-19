---
cell_id: collective-runtime
title: Collective Runtime
summary: Independent Collective Service identity, Human membership, canonical Channel events, public Work/Roadmap/Vote lineage, official Connector, Host ingress, owner-admitted private Work relay, replay/ACK and verifiable Clowder AI Agent provenance boundary.
description: Independent Collective Service with Human auth, canonical Client/Connector, Work/Roadmap/Vote lineage, owner-admitted private Work relay, and Agent provenance.
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-08-29T07:06:24Z
description_confirmed_by: codex-sol
description_updated_at: 2026-10-17T00:00:00-07:00
doc_kind: architecture
created: 2026-08-28
canonical_features: [F290]
code_anchors:
  - packages/shared/src/types/collective.ts
  - packages/shared/src/types/collective-collaboration.ts
  - packages/shared/src/collective-work-assignment.ts
  - packages/shared/src/types/collective-work-policy.ts
  - packages/shared/src/types/collective-work-acceptance.ts
  - packages/shared/src/types/collective-work-matter.ts
  - packages/shared/src/types/collective-project-authoring.ts
  - packages/shared/src/types/collective-accountability-attention.ts
  - packages/shared/src/types/collective-work-wake.ts
  - packages/shared/src/types/collective-work-return.ts
  - packages/shared/src/types/collective-vote.ts
  - packages/shared/src/types/collective-decision-vote.ts
  - packages/collective-service/src/store.ts
  - packages/collective-service/src/collaboration-store.ts
  - packages/collective-service/src/collaboration-commit.ts
  - packages/collective-service/src/collaboration-project-authoring.ts
  - packages/collective-service/src/collaboration-accountability.ts
  - packages/collective-service/src/collaboration-project-suggestion.ts
  - packages/collective-service/src/collaboration-accountability-attention.ts
  - packages/collective-service/src/collaboration-work-wake.ts
  - packages/collective-service/src/work-policy-store.ts
  - packages/collective-service/src/collaboration-agent-acceptance.ts
  - packages/collective-service/src/collaboration-agent-continuation.ts
  - packages/collective-service/src/work-source-context.ts
  - packages/collective-service/src/artifact-authority.ts
  - packages/collective-service/src/artifact-relay.ts
  - packages/collective-service/src/artifact-custody.ts
  - packages/collective-service/src/artifact-media-relay.ts
  - packages/collective-client/src/SharedArtifactReading.tsx
  - packages/collective-connector/src/artifact-owner-relay.ts
  - packages/collective-connector/src/artifact-media-relay.ts
  - packages/collective-service/src/collaboration-work.ts
  - packages/collective-service/src/work-result-files.ts
  - packages/collective-service/src/work-result-file-http.ts
  - packages/collective-service/src/collaboration-revision.ts
  - packages/collective-service/src/collaboration-vote.ts
  - packages/collective-service/src/collaboration-binding-vote.ts
  - packages/collective-service/src/collaboration-binding-vote-settlement.ts
  - packages/collective-service/src/identity-store.ts
  - packages/collective-service/src/github-human-auth-provider.ts
  - packages/collective-service/src/http-server.ts
  - packages/collective-service/src/http-router.ts
  - packages/collective-client/src/CollectiveClient.tsx
  - packages/collective-client/src/CollectiveWorkCard.tsx
  - packages/collective-client/src/RoadmapWorkspace.tsx
  - packages/collective-client/src/ProjectAttentionPanel.tsx
  - packages/collective-client/src/ProjectList.tsx
  - packages/collective-client/src/ProjectBoard.tsx
  - packages/collective-client/src/RoadmapPanel.tsx
  - packages/collective-client/src/ProjectAuthoringForms.tsx
  - packages/collective-client/src/ProjectArtifactSurface.tsx
  - packages/collective-client/src/ProjectSuggestionActions.tsx
  - packages/collective-client/src/WorkAccountabilityActions.tsx
  - packages/collective-client/src/VoteCard.tsx
  - packages/collective-client/src/BindingVoteCard.tsx
  - packages/collective-client/src/work-result-file-link.ts
  - packages/collective-connector/src/connector.ts
  - packages/collective-connector/src/accepted-work-result-file-reconciliation.ts
  - packages/collective-connector/src/outbox-custody.ts
  - packages/collective-connector/src/work-policy-custody.ts
  - packages/collective-connector/src/work-acceptance-custody.ts
  - packages/collective-connector/src/work-continuation-custody.ts
  - packages/collective-connector/src/persistence.ts
  - packages/collective-connector/src/work-result-publication.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-connector-runtime.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-ingress-dispatcher.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-agent-verifier.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work/collective-work-authority.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work/collective-work-admission.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work/collective-work-execution-receipt.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work/collective-work-standing-admission.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work/collective-work-artifact-read.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work/collective-accepted-result-file-reconciler.ts
  - packages/api/src/infrastructure/document/collective-document-scope.ts
  - packages/api/src/routes/callback-document-routes.ts
  - packages/api/src/config/collective-alpha-boundary.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work/collective-work-delegation.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work-dispatcher.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work-revision-reconciler.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-work-wake-reconciler.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-current-context.ts
  - packages/api/src/routes/companion-collective-accountability-source.ts
  - packages/api/src/routes/collective-connector-routes.ts
  - packages/web/src/components/collective/CollectiveLaunchSurface.tsx
  - packages/web/src/components/collective/collective-work-action.ts
  - packages/web/src/components/collective/use-collective-context-bridge.ts
doc_anchors:
  - docs/features/F290-ai-native-collective.md
  - feature-specs/2026-08-28-f290-collective-runtime-vertical.md
  - feature-specs/2026-08-29-f290-collective-vision-correction.md
  - docs/architecture/f290-communication-model.md
  - feature-specs/2026-09-11-f290-usable-release.md
static_scan_hints: [CollectiveServiceStore, CollectiveCollaborationStore, CollectiveWorkCard, RoadmapPanel, RoadmapWorkspace, ProjectAttentionPanel, ProjectList, ProjectBoard, ProjectAuthoringForms, WorkAccountabilityActions, accountability_assigned, accountabilityRequestId, projectSuggestion, collectiveWorkWakeNotice, collectiveAccountabilityRequest, InformalVoteCard, BindingVoteSection, CollectiveDecisionRecord, HumanAuthBinding, serviceInstanceId, collectiveId, connectionId, CollectiveConnector, CollectiveIngressDispatcher, CollectiveWorkAuthority, CollectiveWorkRevisionReconciler, CollectiveWorkWakeReconciler, collectiveWorkDelegationV1, workRevisionNotice, resultRevision, assignmentCatId, pairingIntent, endpointCredential, canonical order, lastAckedSequence, Agent provenance, CollectiveLaunchSurface]
cited_by:
  - {feature: F290, date: 2026-08-28, delta: new cell — first independent Service + canonical Client + official Connector runtime vertical}
  - {feature: F290, date: 2026-09-11, delta: Service-owned public Work/Roadmap lineage, exact Cat assignment and result-return projection}
  - {feature: F290, date: 2026-09-13, delta: source-linked named informal Vote with mutable ballots, deadline and explicit non-binding effect}
  - {feature: F290, date: 2026-09-13, delta: Roadmap-scoped binding Vote freezes Human eligibility and majority rules, then emits an authority-backed Decision without mutating the route}
  - {feature: F290, date: 2026-09-27, delta: owner-admitted private Work can be delegated to explicitly named home Cats while Task ownership and exact Channel return authority remain unchanged}
  - {feature: F290, date: 2026-09-28, delta: accountable Human feedback resumes the same admitted Task for a versioned result round; prior results and feedback remain in Work history and only the current result may be accepted}
  - {feature: F290, date: 2026-09-30, delta: registered owner delegation is separate from matter address; real Cat commitment and durable Host admission consume independent current execution authority on the same immutable Work/Task}
  - {feature: F290, date: 2026-10-17, delta: "W4 branch supplies fresh Artifact domain constraints, content-free version/access/custody records and bounded owner relays; content/review owners remain canonical. Implementation is not yet merged or accepted."}
  - {feature: F290, date: 2026-10-17, delta: "A Host-sealed small UTF-8 file may become an immutable Service Work-result attachment only under the exact current result authority; current Collective membership is rechecked at read time and SharedArtifact/content ownership is unchanged."}
  - {feature: F290, date: 2026-10-18, delta: "Human acceptance may persist one committed-but-unassigned Work without execution; a later Human or authorized Cat claims that same Work with immutable assignment lineage, while the canonical Client projects deduplicated Project list/dependency/board views and terminal Work dependencies remain immutable."}
  - {feature: F290, date: 2026-10-18, delta: "Project-page commands atomically bind public source events to new Projects/Tasks; cross-Human accountability remains a target-Human request, Cat Project suggestions stay pending until revalidated Human acceptance, prerequisite/comment wakes resume only the existing Task, and Host unified attention reads pending accountability through endpoint/owner-fenced Connector authority."}
---

# Collective Runtime

## Canonical Owner

F290 owns the cross-Café world truth implemented by the independent Collective Service: immutable Service
identity, one-time owner bootstrap, Human auth bindings/sessions, memberships and invitations, endpoint connection authority,
per-Collective ordered events, source-linked public Work/Roadmap/Vote records and histories, delivery cursor/ACK validation, and the canonical browser client served from the
Service origin. The Service persists these objects without Redis and remains independently deployable from Cat
Café runtime ports and lifecycle.

Bootstrap creates an identity-limited initial owner session that may establish only the first Collective and
steward, breaking the self-host provider-configuration cycle. A provider-authenticated Human binding is required
before invitations, pairing or ordinary messaging. Provider subjects remain adapter keys; the stable domain
identity is the Service-generated `humanId`.

The official Collective Connector is the Clowder AI endpoint adapter. It owns Host-side endpoint credential
custody, durable outbox/inbox, reconnect, replay, ACK, Host-route disposition and revoke. It may turn a Clowder AI
Agent into a structured extension of the connection-bound Human only after Host verification of a known `catId`
and a durable invocation execution receipt. Agent targets are mapped explicitly to local Cats/Threads; their
Collective Agent IDs need not equal local Cat IDs. It does not grant Agent/tool permissions, authenticate Humans,
or start the Service.

Clowder AI `/collective` is a launch surface around the Service client, not a second Collective product. Direct
Web and embedded entry share the same Service build and state. The launch surface may show redacted Host
connection health and pairing/revoke controls; Channel, identity and membership remain Service-owned.

## Use This When

- Changing Service/Collective/connection stable identifiers or coordinate-bearing DTOs.
- Adding Human bootstrap/auth binding, membership, invite, endpoint pairing/revocation or Service session behavior.
- Changing Channel event order, idempotency, delivery replay, inbox/outbox durability or ACK semantics.
- Changing public Work/Roadmap source lineage, Human commitment, dependency state or result-return history.
- Changing public informal Vote lineage, ballot eligibility/visibility, deadline, result effect or closing authority.
- Changing binding Vote voter snapshots, majority rules, Roadmap authority validation, invalidation or Decision provenance.
- Changing direct/embedded canonical client behavior or Clowder AI Collective launch/pairing controls.
- Adding a Service-routed Cat Agent signal, typed target, Host ingress route or endpoint/session provenance.
- Changing owner admission, private Work execution binding, same-thread home delegation or exact result-return authority.
- Changing result feedback, revision rounds, current-result acceptance or Host Task resumption from Service Work truth.
- Changing immutable Work-result file publication, authenticated member reads or result-file retry/replay semantics.
- Changing shared Artifact source/version/access, owner custody handoff, or bounded Markdown/media owner transport.

## Extend By

- Preserve `serviceInstanceId`, `collectiveId` and `connectionId` across wire, store and projection even when a
  v1 UI presents one connection.
- Let the Service construct actors from authenticated Human or endpoint context; reject caller-nominated
  provenance and cross-coordinate payloads.
- Keep endpoint credential, provider subject and `humanId` as separate authorities. Agent Service permission is
  the bound Human membership; Agent identity adds provenance and Host routing, never a second login.
- Persist event acceptance/order atomically, outbox before send and inbox before ACK. Retry using the same
  scoped client event ID and never equate delivery with Agent action.
- Keep Service, Host Connector and browser client auth subjects separate. Route typed targets only through
  owner-authored Host config; never infer a local Cat or Thread from a remote identifier. Remove endpoint credentials locally
  only after Service revoke succeeds or returns canonical already-revoked truth.
- Keep public participation, private owner admission and home delegation as separate typed authorities. A home Cat may
  continue only the exact same-thread Task/revision explicitly delegated by the admitted owner; re-read the Task, source
  and owner receipt before execution and return under the actual executing Cat identity without changing Task ownership.
- Keep the Service Work assignment and actual result author distinct: the Connector preserves the original assignment
  source, verifies both the accountable and executing Cats against current participation, and the Service issues a receipt
  naming both before recording the executing Cat in Work history.
- Treat result revision as a coordinate on the same Work, not a new Work or replacement history. Human feedback must name
  the exact current result; the Service retains prior result/feedback entries, emits a signed revision notice, and the Host
  revalidates Work, assignment, source and the unique open Task before dispatching the next round. Connector outbox keys
  separate Work result rounds while preserving the legacy key for ordinary public replies.
- Let only the authenticated bound Human register delegation at the Service. Local owner adoption consumes the exact
  registered policy; endpoint credentials may read or contract it, never issue or expand it. Permission scope has no Thread.
- Keep first acceptance/assignment/Task admission immutable. A newly valid continuation records current execution authority,
  a fresh exact source and grant revision, then reuses the same Task; old callbacks and sealed operations cannot cross epochs.
- Treat delivery, public commitment, actual Host Task, execution, progress, result publication and Human Work acceptance as
  separate facts. Record and recover cross-boundary admission before executing; progress is not a result or closure.
- Treat “accepted into the Project” and “someone accepted accountability” as separate facts on the same Work. A Human may
  persist a committed Work with no accountable Human, assignment event or execution; a later authenticated Human or a Cat
  inside current owner delegation may establish accountability exactly once without creating a second Work. Host bootstrap
  accepts the resulting `accountability_assigned` lineage only when the current Service Work, inbox event, participant and
  acceptance notice all match. Completed, declined and cancelled Work dependencies are immutable; new follow-up belongs in
  a sourced new Work. Project list, cross-project dependencies and board are read projections over stable Work IDs, so one
  Work referenced by several Projects renders once in global task views and never becomes a duplicate execution authority.
- Bind direct Project/Task creation and its public Channel source inside one Service transaction and one replay identity.
  A cross-Human accountability request is append-only pending truth addressed to the named Human; only that Human may accept
  or decline, and any selected Cat must come from that Human's current Café participation. Cat project suggestions are separate
  pending candidates built from invocation-bound opaque Project/Work refs. Human acceptance rechecks current revisions,
  membership, dependency cycles and accountability, then commits the candidate, Roadmap membership and optional prerequisite
  edge atomically. A prerequisite completion or exact Work comment may issue one typed wake to the current assignment, but Host
  must resolve the unique existing private Task and current execution authority; it never creates a replacement Task. If a local
  Cat is temporarily unavailable, retain the visible comment and retry the same wake/message identity after recovery.
- Treat pending cross-Human accountability as a separate F310 source, not as a private Host Task or approval. Service reads use
  the endpoint credential's current authorized Human and current Project membership; Connector rechecks connection, Human and
  local owner route after every async read. Stable item identity includes Service/Collective/Work/accountability-request ID;
  Work revision is version only. Unified-attention action refs navigate to the exact Project Task and grant no authority;
  accept/decline remains a canonical Service write, and resolved or inoperable requests disappear on the next authoritative read.
- Shared Artifacts retain exact public source, content identity, immutable version and Work linkage. The Service owns
  current membership/access/custody constraints; the retained content owner owns bytes and final authorization. Metadata
  owner RPC and binary ranges remain transient and bounded, with fresh validation before disclosure. Neither a patch
  receipt nor Human content adoption completes a Work. Handoff activates one exact destination only after durable source
  preparation, target readiness and owner installation; prior owner generations cannot resume effects.
- Private delegated execution remains unknown owner provenance and consumes only its protected Work binding. Callback/native
  guards own scoped enforcement; the Collective Service does not grant a local owner session or general private history.
- The existing document producer binds immutable Markdown bytes to Task/execution/result scope. Canonical Artifact-ref
  registration uses the existing entrusted-work revision CAS, including an authorized same-Task delegate's evidence;
  it does not transfer ownership, change deadlines or accept the Work. Prior body reads consume that accepted scope and digest.
- A public Work-result file is an immutable attachment to the accepted result event, not a SharedArtifact or private Task
  projection. The Host may publish only its current Task/execution/result-sealed `cwork` UTF-8 bytes; Connector rewrites
  only that exact Markdown destination and persists the same file with its outbox retry. The Service stores it atomically
  with the result, serves it only to a currently authenticated member, and never permits browser caching to bypass that
  membership check. For a current result accepted before this attachment capability existed, the Host may re-seal the
  unchanged Task publication and idempotently bind one Service sidecar to the same event; the Work, event ID, result
  revision and stored event body remain unchanged, while Human event reads project the authenticated Service destination.
  Unsupported or unrelated old events remain no-file events.
- A named isolated Alpha may parameterize the Service's existing loopback/data-origin pins only through the installation's
  current validated launch coordinates. Default Alpha pins and F324's deployment identity remain enforced; the descriptor
  cannot authorize a foreign directory, process stop, implicit writer or restored incident data.
- Add future multi-Service/federation or production identity behind these stable boundaries; do not retrofit UI
  route identity into stored coordinates.

## Do NOT Unify With

- Do not merge Service lifecycle into the `plugin` cell. Plugin inventory controls Connector installation and
  activation only; the Service is not a plugin child process.
- Do not merge with F307 Workbench layout/tab/restore or create a second Collective Workbench inside Clowder AI.
- Do not absorb F309 content anchors, annotation/patch mechanics, Office/media editors or canonical content.
- Do not let Service signals invoke Clowder AI Agents/tools or treat an ACK as evidence that an Agent acted.
- Do not use Clowder AI Redis `6399`, runtime ports `3003/3004`, fixture-only pages or prompt-derived fake Agents.

## Static Scan Hints

Watch new/renamed `CollectiveServiceStore`, `CollectiveConnector`, `CollectiveLaunchSurface`, pairing intent and
endpoint credential code, coordinate DTOs, event sequence allocation, `lastAckedSequence`, outbox/inbox state,
Agent provenance construction, Service child-process launch, Redis imports and duplicated Channel clients.
