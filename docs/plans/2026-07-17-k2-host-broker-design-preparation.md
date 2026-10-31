---
doc_kind: plan
status: draft
created: 2026-07-17
topics: [plugin-platform, host-broker, control-plane, grants, messaging, reconciliation, wire-protocol]
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
4. Every production registry row marked ready has contract-owned UTF-8 byte
   bounds and a generated request/result/error encoding proof below the v0
   frame ceiling. A row without that proof remains reserved but unpublished.

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
| `requestId` / settlement key | one attempt / one logical effect | requestId may change on retry; the registry-extracted domain key remains stable |

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
2. `candidate_received`: the runtime reports candidate `pluginId`,
   `packageDigest`, `contractVersion`, and `wireVersion`. They are claims to
   validate, not trust inputs or authority.
3. `host_bound`: the Host accepts only an exact compatible contract/wire pair,
   generates `brokerSessionId` and a one-use `bindingNonce`, and sends the
   authoritative `pluginId`, `packageDigest`, `contractVersion`, `wireVersion`,
   `pluginInstanceId`, `brokerSessionId`, current `grantRevision`, effective
   grants, and binding nonce.
4. `runtime_acked`: the runtime acknowledges the binding with only that nonce;
   it does not echo or choose identity, session, or grant fields. No ordinary
   call or callback is accepted before this transition completes.
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

All post-activation plugin-to-Host calls carry a method, requestId, and
deadline. JSON-RPC `id` is the attempt-scoped requestId. There is no second
generic operationId in the wire envelope: the method registry identifies the
authoritative domain field or Host-resolved value from which the Broker derives
settlement identity. The transport adapter supplies the broker session; the
runtime does not supply `pluginInstanceId` inside the method payload.

```text
received
  -> validated
  -> authorized
      |-> replay_safe_dispatch -> returned
      \-> claimed
          -> dispatched
          -> settled_success | settled_error
                             \-> dead_letter (only when recovery requires operator action)
```

Processing rules:

1. reject an inactive or stale broker session;
2. validate against the negotiated contract schema;
3. reject an expired deadline before claiming or dispatching work;
4. authorize against the current grant revision and scoped handles;
5. inspect the registry-declared settlement source. `none` is valid only for a
   schema-declared replay-safe method whose repeated execution cannot duplicate
   a domain action or hide undelivered data. That path may return newer current
   state and does not claim an effect ledger. A settled-effect method extracts
   its domain settlement key, then claims a durable ledger key
   `(pluginInstanceId, method, settlementKey)` with an input digest;
6. for an effectful method, the same key plus the same input returns the
   existing terminal settlement;
7. the same effect key plus the same input and no terminal settlement never blindly
   dispatches again. If the durable phase is `claimed` but not `dispatched`, a
   fenced recovery owner may advance it and dispatch once. If it is already
   `dispatched`, the Broker queries the domain ledger first; it links any
   terminal domain receipt, otherwise it returns a retryable in-flight result
   and lets reconciliation continue;
8. the same effect key plus different input returns `CONFLICT` without
   dispatch;
9. dispatch a settled effect to a domain service such as K-1 only after the
   claim succeeds; a replay-safe method dispatches after authorization without
   an effect claim;
10. persist an effect settlement before replying to the runtime.

Domain-specific keys remain authoritative where the contract already defines
them: messaging send uses `(pluginInstanceId, idempotencyKey)` and append uses
`(pluginInstanceId, Host-resolved messageId, input.operationId)`. Subscribe preserves
K-1's atomic `(pluginInstanceId, Host-resolved handleId)` create-or-get key;
acknowledgement uses the subscription-local ackToken; callback delivery uses a
Broker-minted deliveryId.
The domain eventId remains content inside the delivered envelope and is never
conflated with delivery settlement. The generic broker ledger records transport
settlement and points to the domain receipt; it must not transmit or invent
another unconstrained idempotency value, and it must not execute the domain
action a second time.

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
- delivery is at least once; the Broker-minted deliveryId is the consumer
  idempotency key. A domain eventId may be present in the envelope but is not a
  lease or acknowledgement identity;
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

## Wire-shape assessment for issue #1165

[Issue #1165](https://github.com/zts212653/clowder-ai/issues/1165) is a
shape-only co-sign anchor, not implementation or publication authority. The
current verdict is **corrections required**; K-2 does not reply
`shape-approved` on the issue's initial body.

### Grounding correction

The issue says K-1 is pinned to `plugin-contract@0.1.0-beta.1`. The exact K-1
branch assessed here, `9fb37310ab5bd22ee262d09135a157bc161cbd90`, has no
plugin-contract package dependency. It still owns a hand-written mirror based
on an older candidate and already drifts from beta.2. The truthful gate is:

1. contract changes land through a co-signed contract PR and an exact new
   artifact is registry-verified;
2. K-1 and K-2 explicitly pin that exact artifact version;
3. neither consumer follows `next` or another mutable dist-tag;
4. K-1 removes its mirror before merge.

### Row-by-row verdict

| Requested decision | Verdict | K-2 decision |
|---|---|---|
| reject taxonomy | revise | one `HANDSHAKE_REJECTED` class with a closed reason enum; detailed Host audit remains private |
| framing and limits | accept with constraints | JSON-RPC 2.0 over UTF-8 NDJSON, one non-batch object per line, 1 MiB hard frame ceiling, method-level pagination only |
| package digest form | revise | one canonical `sha512-<base64>` SRI token over exact staged artifact bytes for every package source |
| operation and settlement identity | revise | JSON-RPC id is attempt-only; each method registry row points to the one authoritative domain settlement key |
| session and resume carrier | defer resume | every reconnect performs a fresh handshake and receives a new brokerSessionId; durable ledgers, not a resume token, recover work |
| SendReceipt to MessageHandle | revise | receipt carries an explicit opaque Host-minted `messageHandle`; messageId is never reused as capability token |
| public wire registry | conditional accept | names below are reserved; no row publishes without request/result/error byte-budget proof, and read/snapshot/delivery stay blocked until their bounded page or callback schemas close |

### Handshake field direction

The public contract adds these generated structures:

```text
CandidateHello (plugin -> Host, candidate claims only)
  pluginId
  packageDigest
  contractVersion
  wireVersion

SessionBinding (Host -> plugin, authoritative)
  pluginId
  packageDigest
  contractVersion
  wireVersion
  pluginInstanceId
  brokerSessionId
  grantRevision
  effectiveGrants
  bindingNonce
```

`broker.hello` carries CandidateHello. The Host validates it against the exact
installed record before returning SessionBinding. The plugin then calls
`broker.ready` on the same connection with only the one-use bindingNonce. A
successful response is the runtime acknowledgement that moves the session to
active. CandidateHello and ready params reject additional identity, instance,
grant, or session fields; the runtime never selects authority by echoing them.

The bindingNonce is connection-bound and activation-only. It is not a session
resume carrier and cannot authorize a new connection.

### Framing and artifact digest

- stdio uses UTF-8 JSON-RPC 2.0 over NDJSON; stdout is protocol-only and logs
  go to stderr;
- v0 output is compact UTF-8 JSON with no BOM or insignificant whitespace and
  uses LF as the frame terminator. Non-control Unicode is encoded directly as
  UTF-8, while required JSON escaping counts toward the budget. A decoder may
  assemble one logical line from multiple operating-system reads, but a
  JSON-RPC object never spans multiple NDJSON frames;
- JSON-RPC batch arrays, compression, blank frames, invalid UTF-8, and trailing
  non-whitespace data are rejected in v0;
- `maxFrameBytes = 1_048_576`, counted on raw UTF-8 bytes excluding the LF.
  This is four times beta.2's 262,144-byte total element-payload limit, leaving
  bounded room for schema and JSON overhead. The decoder stops buffering and
  closes the connection when an unterminated frame crosses the ceiling. A
  future schema that cannot prove a result fits must paginate or negotiate a
  later wire version rather than silently raising this v0 limit;
- the decoder ceiling is the last fail-closed defense, not the normal way to
  reject a schema-valid value. Inbound request bytes are checked before
  business dispatch, and outbound result/error bytes are checked before they
  enter the write queue. An over-budget value produces zero business side
  effects and never becomes a partial frame;
- JSON Schema `maxLength` alone is not a byte proof: it counts characters,
  while UTF-8 encoding and JSON escaping change the wire size. The contract
  therefore owns both structural limits and semantic raw-byte validators for
  every free string, identifier, handle/token, error payload, and collection;
- an oversized domain result is not split by the transport. A method that can
  return a collection must assemble a bounded page and stop before adding the
  first item that would cross its generated result budget. A single item must
  itself be provably encodable. `messaging.read`, `messaging.snapshot`, and
  `host.messaging.deliver` remain unpublished until bounded read/snapshot pages
  and callback request/ack/rejection data are contract-owned;
- packageDigest is one canonical `sha512-<base64>` SRI token over the exact
  staged archive bytes. An npm artifact must also pass its registry integrity
  check. A local external package must become an exact archive before install;
  an unpacked-tree normalization algorithm is not a second digest truth.

### Wire-byte publication invariant

The contract schema and generator own one `wireBounds` truth whose frame cap is
the v0 `maxFrameBytes`. A registry row may be marked ready only when all of the
following are generated and mechanically checked:

1. every variable-length request, result, notification, acknowledgement, and
   public error field has a structural limit plus an exact UTF-8/JSON byte
   validator;
2. the row declares `maxEncodedRequestBytes`, `maxEncodedResultBytes`, and
   `maxEncodedErrorBytes`, each no greater than `maxFrameBytes` under the v0
   compact JSON-RPC encoding profile, including shared `CallMeta` and escaping;
3. collection assemblers admit an item only if the encoded page would remain
   within the row result budget, preserve continuation/watermark state when the
   next item does not fit, and can prove that one individually valid item fits;
4. request validation and the row's result/error proof are checked before
   authorization-visible business dispatch. Dynamic page assembly completes
   within budget before it advances a delivered watermark, callback lease, or
   settlement state. The final encoded frame is checked again before write
   queue mutation; an over-budget value is a contract violation, never a
   partially emitted success.

This proof covers requestId, plugin/package/version/session identifiers,
bindingNonce, message/thread/subscription identifiers, handles, cursors,
deliveryId, callback acknowledgements, and closed public error data. A method
name may be reserved without this proof, but the method cannot be published or
advertised as ready.

### Settlement identity

Every ordinary call uses:

```text
JSON-RPC id = requestId                 attempt correlation only
params.meta.deadlineUnixMs              Host-capped absolute deadline
params.input                            method-owned schema
registry.settlementKeySource            authoritative field/composite or "none"
```

The registry mapping is fixed as follows:

| Method | Settlement key source |
|---|---|
| `messaging.send` | `input.idempotencyKey` |
| `messaging.appendElements` | `(Host-resolved messageId from input.handle, input.operationId)` |
| `messaging.subscribe` | Host-resolved `input.handle` identity; K-1 create-or-get is authoritative |
| `messaging.read` | none; repeated fetch is at-least-once safe; bounded page assembly advances `lastDeliveredSequence` only through the last emitted event, while only ack advances `ackedSequence` |
| `messaging.ack` | `(input.subscriptionId, input.ackToken)` |
| `messaging.snapshot` | none; current projection may replay and cursor catch-up is monotonic |
| `host.messaging.deliver` | `input.deliveryId` |

The Broker extracts rather than duplicates that value. A retry may use a new
requestId, but the same settlement key plus the same input converges on the
existing terminal or in-flight result; the same key plus different input is a
conflict. Rows marked `none` deliberately do not promise byte-identical retry
responses: their schemas must prove at-least-once replay and monotonic cursor
updates before publication.

### Initial production method registry

Fixture verbs remain conformance-only. The first public registry reserves these
exact method names and directions. Reservation does not imply publication: each
row remains blocked until its request/result/error byte proof satisfies the
wire-byte publication invariant.

| Method | Direction | Grant | Input -> result | Error set |
|---|---|---|---|---|
| `broker.hello` | plugin -> Host | protocol-intrinsic | CandidateHello -> SessionBinding | HANDSHAKE_REJECTED |
| `broker.ready` | plugin -> Host | protocol-intrinsic | bindingNonce -> null | HANDSHAKE_REJECTED |
| `messaging.send` | plugin -> Host | messaging.send | MessageDraft -> SendReceipt with messageHandle | MessagingErrorCode + deadline |
| `messaging.appendElements` | plugin -> Host | messaging.appendElements | AppendElementsRequest -> AppendReceipt | MessagingErrorCode + deadline |
| `messaging.subscribe` | plugin -> Host | message.event.subscribe | handle -> subscriptionId | MessagingErrorCode + deadline |
| `messaging.read` | plugin -> Host | message.event.subscribe | bounded SubscriptionReadPageRequest -> SubscriptionReadPageResponse | blocked until byte-budget proof closes |
| `messaging.ack` | plugin -> Host | message.event.subscribe | subscriptionId + ackToken -> null | MessagingErrorCode + deadline |
| `messaging.snapshot` | plugin -> Host | message.event.subscribe | bounded SnapshotPageRequest -> SnapshotPageResponse | blocked until schema closes |
| `host.messaging.deliver` | Host -> plugin | onMessage | bounded deliveryId + threadHandle + envelope -> bounded deliveryId ack | blocked until callback request/ack/rejection byte proof closes |
| `host.grants.changed` | Host -> plugin | protocol-intrinsic | GrantSnapshot notification | none |
| `host.lifecycle.ping` | Host -> plugin | protocol-intrinsic | nonce -> nonce | protocol errors only |
| `host.lifecycle.drain` | Host -> plugin | protocol-intrinsic | deadlineUnixMs -> null | deadline |

There is no production method for fixture setup/observe, grant presets,
revocation, permission-matrix inspection, or replay deletion. There is also no
grant-introspection RPC: SessionBinding and `host.grants.changed` are the
authoritative snapshots, while every Host call still reads current grants.

### Rejection and reconnect semantics

Handshake rejection uses one public class with one of these reasons:

```text
MALFORMED_HELLO
PACKAGE_MISMATCH
CONTRACT_INCOMPATIBLE
WIRE_INCOMPATIBLE
AUTHORITY_VIOLATION
DEADLINE_EXPIRED
BINDING_REPLAY
```

Wrong digest maps to PACKAGE_MISMATCH. A caller-supplied instance, session, or
grant field maps to AUTHORITY_VIOLATION. The contract harness asserts the
closed public reason and zero side effects; the Host audit may record a more
specific internal diagnostic without exposing installed state.

V0 defines no resume token. Disconnect invalidates brokerSessionId and all
connection leases. Reconnect starts from `broker.hello`; in-flight calls
converge through their domain settlement keys and callbacks through deliveryId.
Therefore the contract does not claim a session/instance-resume replay oracle.
It does test stale-connection fencing and one-use bindingNonce replay.

### Shape-gate disposition

Issue #1165 remains corrections-required until a revision incorporates this
matrix and closes all of the following:

1. replace the false K-1 beta.1 pin claim with the live mirror state;
2. generate CandidateHello, SessionBinding, CallMeta, GrantSnapshot, explicit
   SendReceipt.messageHandle, registry rows, closed error data, and `wireBounds`
   proof metadata from one contract schema;
3. define bounded SubscriptionReadPageRequest/SubscriptionReadPageResponse,
   SnapshotPageRequest/SnapshotPageResponse, callback request/ack/rejection
   data, and byte caps for every CallMeta/identifier/handle/token/cursor/error
   field under the 1 MiB ceiling. No registry row may be ready without generated
   request/result/error encoding proof;
4. demonstrate per-ready-row max-boundary and one-byte-oversize behavior under
   multibyte UTF-8 and JSON escaping, bounded-page continuation, split-read,
   invalid-frame, authority-violation, binding-replay, and zero-side-effect
   inbound/outbound oversize conformance;
5. publish only after contract review and registry verification, then re-pin
   K-1 and K-2 explicitly.

No production implementation, package publication, or dependency re-pin is
authorized by this assessment.

## Implementation slices after the gates

1. **K-2A — contract-native inventory and stores**: exact contract dependency,
   manifest verifier, package/instance/grant stores, orthogonal state, and
   migration tests. No external runtime execution.
2. **K-2B — Broker state machine with builtin loopback transport**: handshake,
   call ledger, callback delivery, dead-letter, and reconcile using the same
   semantics required of external transports. This slice requires a subsequent
   contract package version that owns the public handshake structures and
   row-level wire byte proofs; builtin loopback does not license a core-local
   parallel schema or an unbounded result path.
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
- the 1 MiB v0 frame ceiling is fixed, and every ready registry row has a
  generated request/result/error encoding proof below it;
- builtin and external runtimes traverse the same Broker semantics;
- raw thread IDs and arbitrary wake targets are structurally unavailable;
- action and callback settlement is durable and restart-reconcilable;
- user-visible, relationship, and interaction-history data does not disappear
  on uninstall by default.
