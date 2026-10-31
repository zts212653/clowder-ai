---
cell_id: collective-runtime
title: Collective Runtime
summary: Collective 插件拥有 Service、Connector、监听端口、认证与客户端静态资产；Host 页面调用普通插件 action，线程和 Task 仍由 Host 通用能力承接。
doc_kind: architecture
created: 2026-08-28
canonical_features: [F290, F202]
code_anchors:
  - packages/shared/src/types/collective.ts
  - packages/shared/src/types/collective-collaboration.ts
  - packages/collective-client/src/CollectiveClient.tsx
  - packages/collective-client/scripts/build.mjs
  - packages/web/src/components/collective/CollectiveLaunchSurface.tsx
  - packages/web/src/components/collective/collective-client.ts
  - packages/web/src/components/collective/use-collective-connector-launch.ts
  - packages/api/src/domains/plugin/runtime-composition.ts
  - packages/api/src/domains/collaborative-content/collective-artifact/owner-port.ts
  - packages/api/src/domains/plugin/host-surface/collective-artifact-owner.ts
doc_anchors:
  - docs/features/F202-plugin-framework.md
  - docs/architecture/plugin-architecture.md
cited_by: [F202]
static_scan_hints: [CollectiveClient, CollectiveLaunchSurface, official.collective-connector, serviceInstanceId, canonicalClientUrl]
---

# Collective Runtime

## Ownership

The `official.collective-connector` plugin owns the Collective Service and Connector. In the plugin
repository, `packages/collective-connector/src/business/service/` implements service persistence,
authentication, HTTP routing and business operations. Plugin lifecycle starts and stops its loopback
listener, owns its port configuration and serves the canonical client assets. Internal communication
does not dispatch through a Host browser-service registry or a Host-assigned binding.

The client source in `packages/collective-client` builds the static assets packaged with the plugin.
Clowder AI's Collective page is a launch surface for that client. It obtains service state and a
launch URL through the plugin's ordinary authenticated actions. Direct and embedded clients share
one service origin, client build and persistent state.

## Identity, Access and Data

Service identity, Human authentication and sessions, memberships, endpoint credentials, Channel
ordering, public Work/Roadmap/Vote history and artifact access remain Collective business data.
The plugin retains its service data across stop/start. A restart changes neither service identity nor
stored user content. Bootstrap, owner authorization and endpoint authority remain separate checks.

The plugin serves the GitHub OAuth callback at `/api/auth/github/callback` on its own listening origin.
The authenticated owner registers the Host page origin; arbitrary origins cannot acquire that trust.
Client assets are served from the package's public asset directory, not from its private data directory.

The Connector maintains durable inbox/outbox, replay and acknowledgement state. A transport receipt
is not evidence that a cat acted or that a Work was accepted. Work assignment, messages, result history
and Human acceptance remain distinct facts.

## Host Integration

- Ordinary plugin actions expose service status, launch, pairing and connection controls.
- Thread participants, messages and Task data use the normal SDK interfaces and current grants.
  Entrusted Work data writes retain the existing Task authorization requirements.
- Host routes incoming messages through its ordinary conversation queue. It supplies no Collective
  invocation executor, review completion port or private browser dispatch channel.
- Service port changes take effect when the user stops and starts the plugin; config refresh does
  not implicitly restart it.

The Host retains local content, review, media and custody authority. The verified Collective module
receives one late-bound owner proxy, fenced by installation, package, grant and activation identity.
It supports background publication/recovery without a Human session; fresh remote authority is checked
at the local effect boundary. Retained-media listing and share preparation additionally require the
current Host-authenticated owner HTTP request. The plugin cannot supply a local principal or obtain
raw stores, private paths or session credentials. Disabling the activation cancels open media streams.

Document results use the existing message and media-read carrier. The Connector verifies response,
trigger, invocation, Work revisions and bytes, then rewrites the local upload link to a Service sidecar.
New Service file records carry only public file coordinates and content; local upload locators stay in
the Connector. Legacy result recovery remains separate from new publication.

## Boundaries

The Host plugin manager owns installation and activation. The plugin owns resources created during
that activation and closes its listener when stopped. Neither owns the other's persistent data.
The launch page must not duplicate the Collective client or reinterpret a transport ACK as Task
completion. Content owners continue to authorize artifact bytes; Collective metadata alone does not
grant access to private Host content.

## Retained cross-boundary invariants

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
