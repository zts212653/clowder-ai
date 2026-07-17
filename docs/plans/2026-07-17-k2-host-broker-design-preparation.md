---
doc_kind: plan
status: draft
created: 2026-07-17
topics: [plugin-platform, host-broker, control-plane, grants, messaging, reconciliation]
related_features: [F202, F240]
---

# K-2 Host Broker design preparation

## Outcome

K-2 extends F202 into the single plugin control plane and introduces one Host
Broker execution boundary. It does not add a second plugin registry beside
F202, and it does not preserve F240's external same-process loader as the
community runtime path.

The first production implementation remains gated on K-1 landing upstream.
This document fixes the target seams, state ownership, recovery rules, and
conformance responsibilities so implementation can begin without reopening the
architecture.

## Scope and gates

This preparation covers:

- mapping the published `@clowder-ai/plugin-contract@0.1.0-beta.2` onto the
  current F202 and F240 host surfaces;
- package, installation-instance, grant, runtime-session, and transport
  ownership;
- handshake, call, callback, deadline, acknowledgement, dead-letter, ledger,
  and restart reconciliation semantics;
- the Host-owned route from connector binding or thread handle to the K-1
  messaging domain;
- a reuse, migrate, and replace decision for the current host components;
- allocation of all 18 signed P-2 behavior fixtures to production Host
  responsibilities.

This preparation does not:

- implement a production Host Broker;
- add stdio or IPC framing to the core repository;
- spawn external plugin processes;
- migrate existing connectors, schedules, or foreground-cat;
- define the K-3a signal ingress or K-3b window/presence domains;
- assign a feature number to K-1 or K-2.

Production K-2 work starts only after all of these are true:

1. K-1 is rebased onto upstream `main`, has a formal upstream PR, and is
   independently approved and merged.
2. K-1 consumes the exact published contract package instead of maintaining a
   hand-written contract mirror.
3. Host and SDK transport/handshake structures have one machine-readable owner
   in `@clowder-ai/plugin-contract`; the core repository does not define a
   parallel public wire schema.

## Grounded baseline

### Published contract

`@clowder-ai/plugin-contract@0.1.0-beta.2` is the current machine-readable
truth source for:

- the plugin manifest, feature, data-class, runtime, and capability schemas;
- the L0/L1/L2 capability table;
- messaging drafts, canonical envelopes, handles, receipts, output events,
  subscription reads, snapshots, and bounds;
- the reusable behavior executor and 18 signed messaging behavior cases.

The current contract intentionally does not define Host Broker handshake or
transport frames. Those structures must be added to the contract package
before a stdio or IPC implementation treats them as public protocol.

### K-1 dependency

The current public K-1 branch is
`mindfn/feat/k1-messaging-domain@9fb37310ab5bd22ee262d09135a157bc161cbd90`.
At preparation time it is 25 commits ahead of and 4 commits behind upstream
`main`, with no upstream pull request.

Its intended seam is good: `createMessagingDomain({ messageStore, redis })`
returns the facade that K-2 should call. Its merge preparation still needs two
truth-source corrections:

- replace `packages/api/src/domains/messaging/contract/types.ts` with imports
  from the exact published contract package and run the package conformance;
- resolve concrete drift such as `maxElementsPerMessage`: the branch mirror
  uses 32 while beta.2's generated contract uses 128.

The branch's tentative F258 label also collides with an existing feature line.
K-2 references it as **K-1 messaging domain** until maintainers assign a
non-conflicting feature anchor.

### Existing Host surfaces

| Surface | Current truth | Useful seam | Gap K-2 must close |
|---|---|---|---|
| F202 discovery | `PluginRegistry` scans repository-local `plugin.yaml` | deterministic discovery, ID/path checks | schema is not the published contract manifest |
| F202 activation | `PluginResourceActivator` owns skill/MCP/limb/schedule activation | ownership checks, persist-before-cleanup, rollback | no package, install-instance, grant, or runtime-session model |
| F202 config | `.cat-cafe/plugin-config/<pluginId>.json` | atomic 0600 writes and declared-key filtering | pluginId-only namespace cannot distinguish reinstall instances |
| F202 API | `plugin-routes.ts` | loopback, owner identity, audit | exposes one linear derived status instead of orthogonal state |
| F240 package install | `.cat-cafe/plugins/<id>` tar extraction | archive bounds, symlink/path checks, same-origin owner gate | dynamically imports community `index.js` into the API process |
| F240 connector runtime | `IMConnectorPlugin` plus gateway registries | clear connector adapter seam and lifecycle handles | separate management plane, config store, and runtime authority |
| F240 binding | `ConnectorThreadBindingStore` | durable connector/chat/thread/user binding | not yet issued as a scoped Host handle |
| K-1 messaging | `createMessagingDomain(...)` on the pending branch | canonical message, ledger, handles, cursor, snapshot | not upstream and not pinned to beta.2 |

## Ownership model

K-2 uses five identities that must not be collapsed:

| Identity | Lifetime | Authority |
|---|---|---|
| `pluginId` | declared package identity | candidate only until package verification binds it |
| `packageDigest` | immutable artifact | package verifier; never runtime self-report |
| `pluginInstanceId` | one installation, survives runtime restart | Host-minted and durable; changes on reinstall |
| `brokerSessionId` | one transport connection | Host-minted and ephemeral; fences stale connections |
| `requestId` / `operationId` | one attempt / one logical action | requestId may change on retry; operationId remains stable |

The stable installation-scoped `pluginInstanceId` is required for K-1
idempotency across process restarts. Reinstalling the same package creates a
new instance and therefore a new ledger and handle namespace.

The Host binds every call context. A runtime may present candidates during
handshake, but it cannot choose its plugin identity, digest, instance,
effective grant set, connector binding, thread handle, actor, or wake target.

## Target component layout

```text
PluginControlPlane                     existing F202 evolves here
├── PackageInventory + PackageVerifier
├── PluginInstanceStore
├── GrantStore
├── Config/Secret/State ownership
├── ResourceAdapterRegistry
│   ├── ConnectorResourceAdapter       wraps F240 during migration
│   ├── ScheduleResourceAdapter        wraps TaskRunner
│   ├── ServiceResourceAdapter
│   └── BuiltinResourceAdapter
└── HostBroker
    ├── TransportRegistry              builtin / stdio / ipc
    ├── SessionRegistry + Liveness
    ├── CallRouter
    ├── CallbackDispatcher
    ├── SettlementLedger
    ├── DeadLetterStore
    └── BrokerReconciler
          │
          └── K-1 MessagingDomain      canonical messaging state machine
```

Resource adapters translate control-plane lifecycle requests into the
appropriate existing runtime. They do not define independent package,
identity, grant, or audit truth.

## Orthogonal state

One linear `installed -> configured -> enabled -> healthy` enum is invalid
because the facts are independent. The control plane persists these axes:

| Axis | States |
|---|---|
| package | `absent / staged / verified / installed / quarantined` |
| config readiness | `incomplete / ready` |
| activation | `disabled / enabling / enabled / disabling / error` |
| runtime | `stopped / starting / handshaking / healthy / degraded / crashed` |
| grant revision | monotonically increasing effective grant snapshot |

A verified package may be disabled. An enabled plugin may be degraded. A
configured package is not necessarily installed, and a healthy process is not
proof that its requested capabilities were granted.

Persistence happens before destructive runtime cleanup. If disabling cannot
be persisted, the runtime remains active and the operation fails visibly. If
runtime cleanup fails after persistence, activation enters `error` and the
reconciler retries cleanup; it never rewrites the package or grant truth to
pretend success.

Every non-terminal Broker state has a Host-owned progress rule: an absolute
deadline, a fenced lease, or a deterministic reconciliation transition. A
runtime frame or process-local timer is never the only thing that can release
durable Broker state.

## Package and grant admission

Installation is the only path that creates an instance:

1. stage the exact package bytes without executing them;
2. compute and persist the digest;
3. validate the manifest with the exact contract package;
4. reject unknown capabilities and invalid data-class/strategy pairs;
5. record requested capabilities separately from effective grants;
6. require explicit approval for community executable packages;
7. mint `pluginInstanceId` and atomically mark the package installed;
8. leave activation disabled until the user enables it.

Effective grants are:

```text
manifest requested capabilities
  intersect operator-approved capabilities and scopes
  intersect the capability table for the negotiated contract version
```

Rules:

- a manifest declaration is a request, never authority;
- no unknown capability is stored as an effective grant;
- first-party presets may populate only generated L1 capabilities;
- preset grants remain visible and independently revocable;
- no L2 capability is silently added by a first-party preset;
- the default whisper target set is empty;
- every grant mutation increments `grantRevision` and is audited;
- every call reads the current grant revision. The handshake snapshot alone is
  not authorization after a grant is revoked.

## Handshake state machine

The semantic handshake is fixed here; its public frame schema belongs in the
contract package.

```text
disconnected
  -> transport_connected
  -> candidate_received
  -> host_bound
  -> runtime_acked
  -> active
  -> draining
  -> closed
```

Each pre-active state has a Host-owned absolute deadline recorded with the
session candidate. Expiry fails closed: the Host closes the transport,
invalidates the candidate and session fence, and releases transient resources
without granting authority. Runtime traffic cannot extend that deadline by
itself. The concrete durations remain policy, but the deadline transition is
part of Broker semantics.

1. `transport_connected`: the Host accepts a connection only for an installed,
   enabled package and binds the connection to that install record.
2. `candidate_received`: the runtime may report supported contract and delivery
   modes. Identity fields are candidates, not trust inputs.
3. `host_bound`: the Host selects an exact compatible contract, generates
   `brokerSessionId`, and sends Host-bound `pluginId`, `packageDigest`,
   `contractVersion`, `pluginInstanceId`, current `grantRevision`, and effective
   grants.
4. `runtime_acked`: the runtime acknowledges the exact bound tuple before any
   call or callback is accepted.
5. `active`: the Host persists the active session fence and then allows work.
6. `draining`: no new calls and no new callback leases; in-flight settlement
   and acknowledgements for already leased callbacks may finish until the Host
   deadline.
7. `closed`: the session fence is invalid. Late frames from it fail closed.

Any identity, digest, contract, or session mismatch closes the connection and
records a trace. It never falls back to plugin-reported identity.

An active session remains valid only while Host-observed transport liveness is
current. Transport loss or liveness expiry closes the session fence and hands
durable recovery work to the reconciler.

Builtin plugins use an in-process transport adapter but traverse the same
handshake, authorization, ledger, and callback state machines. In-process is an
optimization, not a first-party backdoor.

## Call state machine

All plugin-to-Host calls carry a method, requestId, stable operationId, and
deadline. The transport adapter supplies the broker session; the runtime does
not supply `pluginInstanceId` inside the method payload.

```text
received
  -> validated
  -> authorized
  -> claimed
  -> dispatched
  -> settled_success | settled_error
                     \-> dead_letter (only when recovery requires operator action)
```

Processing rules:

1. reject an inactive or stale broker session;
2. validate against the negotiated contract schema;
3. reject an expired deadline before claiming or dispatching work;
4. authorize against the current grant revision and scoped handles;
5. claim a durable ledger key `(pluginInstanceId, method, operationId)` with an
   input digest;
6. the same key plus the same input returns the existing terminal settlement;
7. the same key plus the same input and no terminal settlement never blindly
   dispatches again. If the durable phase is `claimed` but not `dispatched`, a
   fenced recovery owner may advance it and dispatch once. If it is already
   `dispatched`, the Broker queries the domain ledger first; it links any
   terminal domain receipt, otherwise it returns a retryable in-flight result
   and lets reconciliation continue;
8. the same key plus different input returns `CONFLICT` without dispatch;
9. dispatch to a domain service such as K-1 only after the claim succeeds;
10. persist the settlement before replying to the runtime.

Domain-specific keys remain authoritative where the contract already defines
them: messaging send uses `(pluginInstanceId, idempotencyKey)` and append uses
`(pluginInstanceId, messageId, operationId)`. The generic broker ledger records
transport settlement and points to the domain receipt; it must not execute the
domain action a second time.

A deadline is not permission to erase an action that may already have committed.
After dispatch, the reconciler queries the domain ledger and returns its real
terminal state. It never converts an unknown in-flight action into a blind
retry.

## Callback, acknowledgement, and dead-letter

Host-to-plugin responsibilities such as `onMessage` are durable deliveries:

```text
enqueued -> leased -> delivered -> acked
              |          |
              |          +-> retry_wait -> leased
              +-> lease_expired -> available
                         \-> dead_letter
```

- enqueue requires a current scoped grant; `onMessage` is L2 and never implied
  by `messaging.send`;
- delivery is at least once; the callback event ID is the consumer idempotency
  key;
- an ack token is callback/subscription-local and bound to the installation and
  broker session;
- lease ownership is fenced. A stale session cannot acknowledge or settle a
  successor's delivery;
- retry backoff, attempt count, and absolute `nextAttemptAt` are persisted, not
  process timers only;
- grant revocation prevents new delivery and closes queued deliveries with a
  visible capability-revoked settlement; old sensitive data is not replayed
  automatically after re-grant;
- exhaustion or a non-retryable runtime rejection enters dead-letter with the
  payload reference, reason, attempts, and trace IDs;
- dead-letter entries are persistent until explicit retry, resolution, or user
  deletion. They are not silently TTL-deleted.

Notification callbacks may be intentionally ignored when the contract says so.
Responsibility callbacks must ack or reach a visible terminal failure.

## Restart reconciliation

Broker restart recovery is deterministic:

1. load installed instances, current grants, activation state, callback
   deliveries, ledger entries, and dead letters;
2. mark every pre-restart broker session disconnected and invalidate its fence;
3. expire runtime and window leases using Host time, never plugin-reported time;
4. reclaim callback delivery leases whose session fence is no longer current;
5. restore `retry_wait` from its persisted attempt count and `nextAttemptAt`:
   keep it waiting when the Host deadline is in the future, or make it
   available when due; never reset the attempt count or restart a full delay;
6. for in-flight calls, read the durable Broker phase and domain ledger before
   dispatching, retrying, or settling;
7. resume only unacked, still-authorized callbacks;
8. do not revive disabled packages or revoked grants;
9. keep retained and ask-on-uninstall data independent of runtime state;
10. report unresolved recovery work through health and dead-letter surfaces.

Reconciliation is idempotent and safe to repeat. A second pass with no external
state change produces no new call, callback, grant, or deletion.

## Messaging and Host-owned routing

K-2 wraps K-1; it does not reimplement K-1's message state machines.

For a thread-handle call:

1. Host control plane resolves the caller's durable installation identity and
   current grant;
2. Host resolves the opaque handle, scope, owner user, and live revocation
   state;
3. Broker calls K-1 with a Host-created `PluginCallContext`;
4. K-1 validates address, audience, provenance, reply target, idempotency,
   revision, cursor, and replay semantics;
5. Broker records the transport settlement and returns the K-1 receipt.

For a connector binding, F240's durable binding store remains the mapping truth
for connector/chat/thread/user. A ConnectorResourceAdapter issues an opaque K-1
binding handle for that record. Plugins never receive or self-report a raw
thread ID.

K-2 does not expose arbitrary cat, thread, invocation, or wake targets. K-3a
later adds Host-owned signal routes whose concrete consumers, filters, and wake
policy live only in Host configuration.

## The 18 signed cases as production responsibilities

Host tests consume the published fixture IDs and executor. They do not copy the
case definitions into a second suite.

| Fixture | Production owner |
|---|---|
| `raw-thread-id-rejection` | Broker accepts only contract addresses; K-1 resolves Host-issued handles |
| `system-audience-dual-rejection` | contract validation plus K-1 canonical audience derivation |
| `cross-instance-handle-rejection` | Host-bound call context plus K-1 handle ownership |
| `origin-forgery-rejection` | Broker injects instance identity; K-1 validates provenance |
| `base-revision-conflict-zero-change` | K-1 append CAS and domain ledger |
| `stale-cursor-snapshot-roundtrip` | K-1 cursor/snapshot store; Broker exposes the result unchanged |
| `cross-subscription-ack-rejection` | K-1 subscription-local ack; Broker session fencing adds defense |
| `reply-to-cross-thread-leakage` | K-1 canonical message/thread validation |
| `epistemic-status-upgrade-rejection` | contract semantic validation plus K-1 append validation |
| `preset-l2-rejected` | control-plane grant policy derived from the generated capability table |
| `preset-visible-revocable` | GrantStore, Settings projection, and grantRevision invalidation |
| `whisper-target-beyond-default-empty-grant-rejected` | GrantStore supplies empty default scope; K-1 enforces subset |
| `append-without-grant-rejected` | Broker denies before K-1 dispatch |
| `denied-on-message-rejected` | CallbackDispatcher requires an explicit scoped L2 grant |
| `permission-matrix-complete` | control plane imports the generated capability table without a local copy |
| `delete-replay-events-preserves-canonical-messages` | replay store cannot delete MessageStore or ThreadStore records |
| `snapshot-without-grant-rejected` | Broker authorizes every snapshot call, not only subscribe creation |
| `foreign-replay-delete-rejected` | replay ownership is installation and subscription scoped |

K-2 adds broker-level cases that P-2 intentionally does not claim: handshake
identity/digest mismatch, stale session fencing, deadline expiry, identical and
conflicting operation replay, callback retry/dead-letter, restart reconcile,
grant revocation during queued delivery, and plugin crash isolation.

## Reuse, migrate, replace

| Existing component | Decision | Reason |
|---|---|---|
| F202 `PluginRegistry` | migrate into package discovery adapters | preserve repository-local manifests while the package verifier becomes contract-native |
| F202 `PluginResourceActivator` | reuse orchestration pattern; split by resource adapter | its ownership/rollback rules are sound, but one switch cannot own every runtime |
| F202 capability writes and owner guards | reuse | already provide lock, local owner boundary, CLI regeneration, and audit seams |
| F202 `.cat-cafe/plugin-config` | migrate | config survives, but storage must be installation-scoped and schema-versioned |
| F202 `ScheduleFactoryRegistry` | legacy builtin adapter | target plugins receive declared tasks through Broker callbacks, not arbitrary factories |
| F240 archive validation and write guards | reuse in PackageVerifier | bounds, path, symlink, same-origin, and owner checks remain useful |
| F240 `im-connector-loader` external `import()` | replace for community packages | same-power execution in the API process is not the target runtime boundary |
| F240 `IMConnectorPlugin` | wrap during migration | a practical ConnectorResourceAdapter seam; not the final public SDK authority |
| F240 config and plugin management routes | migrate into F202 control plane | two management planes violate the single control-plane rule |
| F240 `ConnectorThreadBindingStore` | reuse | durable binding truth becomes the input to opaque Host handle issuance |
| `ConnectorRouter` and outbound hooks | reuse | platform ingress/egress and degradation stay in the connector domain |
| K-1 `createMessagingDomain` | consume after upstream merge | it is the canonical messaging facade, not a Broker responsibility |
| local contract mirrors | remove | P15 requires one machine-readable package truth |

## Data migration requirements

Before replacing a current path, implementation must map and test:

- `.cat-cafe/capabilities.json` plugin ownership and enabled state;
- `.cat-cafe/plugin-config/*.json`;
- `.cat-cafe/im-connector-config/*.json`, including operation state;
- `.cat-cafe/plugins/*` installed package bytes and manifests;
- existing plugin audit records and their actor/owner provenance;
- Redis connector bindings and connector permission state;
- K-1 messaging handles, cursor, ledger, replay, and append state once merged.

Imported grant state starts at an explicit baseline `grantRevision` and emits a
migration audit event. Migration does not invent historical revisions or erase
pre-K-2 audit continuity.

Migration is copy-and-verify before cutover. Failure leaves the old data and
authority intact. Uninstall never deletes retained or ask-on-uninstall data
without the user's explicit choice.

## Implementation slices after the gates

1. **K-2A — contract-native inventory and stores**: exact contract dependency,
   manifest verifier, package/instance/grant stores, orthogonal state, and
   migration tests. No external runtime execution.
2. **K-2B — Broker state machine with builtin loopback transport**: handshake,
   call ledger, callback delivery, dead-letter, and reconcile using the same
   semantics required of external transports. This slice requires a subsequent
   contract package version that owns the public handshake structures; builtin
   loopback does not license a core-local parallel schema.
3. **K-2C — K-1 messaging adapter**: Host-issued handles, current-grant checks,
   exact package conformance, and all 18 signed cases against the real facade.
4. **K-2D — contract-owned stdio/IPC transport**: only after its schema is
   published from `plugin-contract`; add process crash isolation and minimal
   environment injection.
5. **K-2E — F202/F240 migration adapter**: unified Settings projection and
   connector package transition without data loss.

Each slice lands with a non-author final-head review. No slice claims K-3a
signals, K-3b windows, foreground-cat, or complete M1.

## Open implementation choices

The architecture does not require early commitment on these details:

- Redis key layout versus a repository-local store abstraction;
- stdio versus IPC as the first external transport;
- the exact retry backoff values, provided they are persisted and bounded;
- process sandbox technology, provided community same-power risk remains
  explicit until a sandbox is verifiably enforced;
- UI presentation of orthogonal state, provided the underlying axes are not
  collapsed.

These are not open architecture questions:

- identity and effective grants are Host-owned;
- `pluginInstanceId` survives runtime restart and changes on reinstall;
- the published contract package is the only public schema/type/capability
  truth;
- builtin and external runtimes traverse the same Broker semantics;
- raw thread IDs and arbitrary wake targets are structurally unavailable;
- action and callback settlement is durable and restart-reconcilable;
- user-visible, relationship, and interaction-history data does not disappear
  on uninstall by default.
