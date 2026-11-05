---
feature_ids: [F202, F247]
topics: [plugins, dot, migration, integration, compatibility]
doc_kind: implementation-plan
created: 2026-10-20
---

# Dot migration C: cutover, compatibility and acceptance

Accepted source: `thread_mu8dg6h7l2x4ohsk#0001792496572158-000196-0a0473ac`.
Canonical product scope: `docs/features/F202-plugin-framework.md`, “Follow-up direction:
addressable plugins and Dot” and its completion checklist.

This lane consumes two independently reviewed candidates:

- A: Host addressable-plugin target discovery and ordinary queue delivery.
- B: installable `official.chatgpt-dot` package and its external connection protocol.

C does not reproduce either implementation. It owns the exact paired revision, the non-destructive
legacy-data handoff, removal of superseded Host branches, compatibility surfaces that still have live
data consumers, and the end-to-end acceptance evidence.

## Baseline Host census

Rerunnable source census:

```sh
rg -l -i \
  "gpt-dot|dispatchDot|DotEventsBridge|DotAskService|dot_reply|dot_ask|chatgpt-dot" \
  packages scripts | sort
```

### Identity and dispatch

| Current owner | Current implementation | Cutover condition |
| --- | --- | --- |
| Synthetic member | `dot-identity.ts` creates `gpt-dot`; `builtin-cloud-identity.ts` and `routes/cats.ts` reserve/protect it | Installed plugin instance is the stable message target; alias/icon are editable projections; existing `gpt-dot` message attribution remains renderable without keeping a runnable cat |
| Cloud bridge | `cloud-invoke-bridge.ts` branches on `gpt-dot` and receives `dispatchDot` from `index.ts` | Ordinary queue resolves the stable plugin instance and Plugin Manager acknowledges addressed input; member cloud dispatch has no Dot branch |
| Return grant/callback | `cloud-return-grant.ts`, `callback-auth-prehandler.ts`, `callbacks.ts`, and `callback-a2a-trigger.ts` admit Dot AgentKey posts and Dot-only metadata | Package verifies its source-bound event and uses ordinary `messaging.send`; Host callback auth no longer accepts a Dot facade key |
| Receipt text | `cloud-bridge-fallback.ts` emits Dot-specific sent/unavailable receipts | Addressed-plugin delivery receipt is transport admission only; async reply is a later ordinary plugin message |

### Runtime and external protocol

`packages/api/src/domains/cats/services/cloud-bridge/dot/` currently owns connection, pairing,
webhook signing, dispatch evidence, source-read/reply authority, proactive asks, connection tests,
image publication, and plugin-state projection. `packages/api/src/index.ts` assembles all of it and
registers four dedicated route groups:

| Route group | Current paths |
| --- | --- |
| Connection | `GET /api/plugins/chatgpt-dot/connection`; `POST .../prepare`; `POST .../disconnect` |
| MCP | `POST /api/plugins/chatgpt-dot/mcp`; `POST /api/plugins/chatgpt-dot/shared-mcp` |
| Test/receipt | `GET /api/plugins/chatgpt-dot/delivery/:eventId`; `GET/POST .../test` |
| Original image | `GET /api/plugins/chatgpt-dot/images/:file` |

The remote MCP process has two distinct consumers:

- `/dot/mcp` accepts the existing Dot Bearer/query credential and currently forwards it as
  `Authorization` to the dedicated Host route.
- shared `/mcp` retains the existing Pro password/tools and adds the four `cat_cafe_dot_*` tools;
  it currently sends a gpt-pro AgentKey to the dedicated `shared-mcp` route.

The replacement keeps these public journeys but not those internal credentials:

- Dedicated proxy consumes the external Bearer/query token and forwards only
  `x-dot-credential` to the package-declared generic webhook. Generic webhook stripping of
  `authorization` and `x-agent-key-secret` remains unchanged.
- Shared `/mcp` keeps Host-side remote-principal authentication. A business-neutral relay resolves
  that owner’s enabled plugin instance and calls the package-declared action. The raw Pro key is
  neither a Dot credential nor package input.

### Settings and media consumers

- `DotConnectionDetail.tsx` directly calls the five connection/test endpoints above.
- Plugin Manager list/detail/live components select that dedicated detail by package ID.
- `CloudDotReceipt.tsx` polls the dedicated delivery endpoint.
- `Lightbox.tsx`, `useGalleryMediaUrls.ts`, content review, video-studio media ownership, and
  `rich-media-urls.ts` recognize `/api/plugins/chatgpt-dot/images/...`.
- Historical message blocks persist that old image URL. Those messages must not be rewritten just
  to remove code.

The new package may serve current UI through declared owner webhooks/actions, but the old image URL
remains a read-compatibility path until every persisted consumer has an equally durable replacement.
It must resolve through the new plugin-owned data and retain the current session-user and
message-visibility checks.

## Legacy data handoff

Host-owned source coordinates are fixed and read-only during migration:

| Source | Contents |
| --- | --- |
| `.cat-cafe/plugin-host/dot-connection.json` | owner, legacy instance, AgentKey reference, external credential, pairing attempt/code, paired callback, signed subscription, evidence timestamps |
| `.cat-cafe/plugin-host/dot-dispatches/*.json` | deterministic event IDs, source/dispatch coordinates, webhook/read/reply evidence, image IDs/reservations |
| `.cat-cafe/plugin-host/dot-images/dot_img_*.json` | owner/thread/event/publication metadata and original-byte digest |
| `.cat-cafe/plugin-host/dot-images/files/dot_img_*.png` | retained original PNG bytes |

The destination is the active instance data directory, currently expected to be
`.cat-cafe/plugin-host/official.chatgpt-dot/` unless B declares another valid non-reserved
`runtime.dataDirectory`.

The importer is a dormant package action, not a runtime-delivery shortcut. Host currently admits
dormant settings actions only when their method is declared by a configuration operation or the
package test hook. Merely exporting `importLegacyBatch` or placing `dot.import` in the settings
action table is therefore insufficient, while temporarily enabling the plugin before import would
start an empty runtime and skip restoration of the imported subscription. The paired revisions must
provide a non-UI, Host-only migration declaration/admission that binds the exact installed instance,
package digest, owner request and `dot.import` method, then invokes the existing settings carrier with
its owner-operation fence. The migration declaration is generic Host governance; reading Dot's old
files and constructing `legacyImportSchema` batches remains this cutover's compatibility adapter.

Migration rules:

1. Resolve one installed instance by `pluginId=official.chatgpt-dot` and installation owner; do not
   select by alias, icon, old `gpt-dot`, or package ID alone when multiple instances exist.
2. Validate every source object before calling the package importer. The connection owner, dispatch
   owner, image owner, source thread/message, and digest relationships must agree.
3. Explicitly remap the legacy `pluginInstanceId` to the current instance. Preserve it only as
   provenance, never as a routable target.
4. Preserve `credentialSecret` as the plugin-private external credential so an already configured
   dedicated Dot MCP client continues to authenticate. Preserve `agentKeyId` only as legacy
   provenance; it is not an active package credential and the package does not call AgentKeyRegistry.
5. Preserve pairing/subscription fields, event IDs, source/reply message IDs, publication IDs,
   metadata, original PNG bytes, and hashes. Historical messages remain unchanged.
6. Import is owner-bound and idempotent. A repeated import returns the same semantic receipt;
   conflicting bytes/state fail closed. No partial receipt may be presented as complete migration.
7. Source files are never deleted by migration or uninstall. Successful replacement merely stops
   executing the old writer.
8. Source existence is not migration status. The Host persists an exact target completion in the
   audit ledger and does not replay it on later enable/begin operations. A new instance may perform
   the reviewed identity-equivalent rebind once. If a previously migrated package has since changed
   pairing identity, the newer package state wins and a durable `package_state_diverged` decision
   prevents legacy restoration. A confirmed `dot.reconnect` is the owner's explicit, audited
   `owner_reconnect` exit when a first import cannot be completed. Neither outcome deletes source.

### Legacy image durability

New package images use `pmr_` references and are copied into the Host media ledger as `hmr_` bytes
before their messages are published. Those messages therefore remain readable after the plugin is
disabled or uninstalled without starting the package.

Imported legacy images require an additional cutover step because their historical messages already
persist `/api/plugins/chatgpt-dot/images/<dot_img>.png`, while the package importer stores its copy
under the plugin data directory and plugin stream/webhook readers are active-runtime-only. For each
validated legacy image C must:

1. idempotently register the verified PNG with the Host media ledger using an import key bound to
   the legacy publication ID and SHA-256;
2. persist a compatibility mapping from the legacy publication ID and message coordinates to the
   resulting `hmr_` ID; and
3. retain the old URL as a read-only compatibility route that rechecks the session owner, thread and
   message visibility/recall state, and the exact historical rich block before opening the verified
   Host stream.

The compatibility reader never starts or invokes the plugin. Retiring the instance must not revoke
this owner-visible historical asset. The legacy Host files and retained package copy remain intact.

## Paired acceptance matrix

Every row must run against one recorded Host SHA plus one recorded plugin package digest/version.
Component tests from A or B alone do not satisfy this matrix.

| Journey | Required evidence |
| --- | --- |
| Install/enable | verified package installed disabled, enabled explicitly, exact instance target appears once |
| Existing state | legacy pairing/config, subscription and receipt evidence import without mutation or data loss |
| Addressed request/reply | alias resolves before enqueue to instance ID; package delivery receipt precedes later ordinary reply with plugin attribution |
| Attachment/image | source-bound original PNG returns, new and historical gallery URLs load with owner authorization and matching digest |
| Alias collision | conflicts include members and enabled addressable plugins; no alias-only identity spoofing |
| Rename with queued input | queued target remains the same instance; subsequent discovery uses the new alias |
| Icon change | presentation changes without restart or target change |
| Disable | target is not discoverable/deliverable; subscription or ordinary IM behavior is not silently broadened |
| Uninstall/reinstall | runtime/grants stop; retained package data survives; reinstall/import is idempotent; historical messages/images remain readable |
| Ordinary members | serial/parallel member dispatch and cloud-member adapter behavior remain unchanged |
| IM forwarding | existing connector thread subscriptions and inbound/outbound delivery remain unchanged; addressability does not imply global subscription |
| Dedicated MCP | existing external credential still works through header rewrite; selector/header spoofing fails |
| Shared MCP | existing Pro remote login still lists/calls Dot tools; raw Pro AgentKey never enters the package |

## Sunset gate

Deletion is allowed only after the paired acceptance rows covering its replacement are green.
The final Host candidate should have:

- no `gpt-dot` branch or `dispatchDot` dependency in cloud invocation;
- no runtime creation of a synthetic Dot cat and no Dot-specific protected-member write policy;
- no `domains/cats/services/cloud-bridge/dot/` executable owner;
- no dedicated connection/MCP/test callback composition in `index.ts`;
- no Dot AgentKey exception in callback authentication or callback message admission;
- no Host-authored Dot runtime or synthetic package state projection; an offline catalog may ship
  the exact independently reviewed package archive and its dependency closure;
- no obsolete tests that protect only the removed implementation shape.

Narrow compatibility is not obsolete merely because it contains the old spelling. In particular,
historical image reads and historical `gpt-dot` message presentation remain until a tested data-level
replacement exists. The completion report must list every retained compatibility branch and its live
consumer, rather than claiming all textual references disappeared.

### Retained compatibility inventory

| Retained branch | Live consumer / reason |
| --- | --- |
| `/api/plugins/chatgpt-dot/shared-mcp` relay | Existing Pro Remote MCP clients keep the public tool surface while Host owner context replaces raw AgentKey forwarding |
| callback-auth `gpt-dot` rejection | A leaked or retained legacy AgentKey must never regain callback authority after the package cutover |
| `MessageStore`/Redis `dotAsk` decoding and callback A2A recipient guard | Already-persisted proactive asks remain parseable and cannot broaden their recipient set |
| `#chatgpt-dot` Settings deep link | Existing bookmarks/entry links land on the generic Plugin Manager detail |
| legacy `official.chatgpt-dot` manifest registration | Installed manifest-only 0.1.x inventory remains readable and updatable to the reviewed archive |
| `/api/plugins/chatgpt-dot/images/<id>.png` | Historical rich blocks retain their original URL with owner/thread/message visibility rechecked |

An in-flight legacy `dot_ask` is not an importer object: the frozen package schema imports
connection, dispatch and image evidence only. Cutover must therefore happen with no unanswered
legacy proactive ask, or the operator must accept that its later reply will not be forwarded through
the retired Host subscription. This is a cutover-window limitation, not evidence loss; persisted ask
and reply messages remain readable.

## Integrated exact sources

- A Host source: `9a382fe6406eaf93183edf7035a7efee3bfd7585`; its three commits were applied
  without rewriting their content before C integration.
- B package source: `4798d4133d47d32c3b0d448ee88408b4c11e239a`; Host bundles the reviewed
  `@clowder-ai/chatgpt-dot` archive with SHA-256
  `a5b71b4711df59c454fc0ae9120ac5fd43c9e78c5b98f4667a5d206b9ed5d8a2` and the exact reviewed
  Contract/SDK archives recorded in the Host dependency lock. This final package source changes only
  the package-side packed regression and its evidence relative to `163dcc8`; all three consumed
  archives are byte-identical, so Host package bytes and digests do not change. The archive remains
  unpublished and C has not activated any superseded candidate in a persistent acceptance runtime;
  same-version candidate replacement therefore has no installed environment to strand.
- C worktree: `/Users/lang/workspace/github-lab/cat-cafe-f202-dot-migration-c`, branch
  `feat/f202-dot-migration-c`.

The paired candidate contains the governed dormant importer, read-only legacy authority audit,
bounded dedicated/shared webhook relays, Host media materialization, historical image fallback,
ordinary addressed queue delivery, and the reviewed package lifecycle. The synthetic Dot member,
old Host runtime/services, connection/test/MCP routes, Dot callback admission, Dot cloud-dispatch
branch, specialized Settings detail and delivery receipt poller are retired. Persisted `dotAsk`
metadata and the old image URL remain decode/read compatibility only.

The Host now retires any persisted legacy `gpt-dot` catalog identity at the data layer: display name
and avatar remain available to historical messages, while cloud provider/carrier authority and the
`@dot` alias are removed and the roster entry becomes unavailable. Both the original carrierless
shape and its later `app_server` form are recognized by their stable identity fields. The generic
address resolver uses a package's single declared identity as its preferred free alias, so Dot claims
`@dot` without a package-specific address branch. Owner catalog install/update and enable paths run
the dormant migration before activation only until the exact target is complete or legacy has been
durably superseded. `dot.begin` retains the fail-closed pre-action fence; confirmed `dot.reconnect`
records the owner's explicit supersession before creating a replacement pairing.

The superseded B archive failed the uninstall/reinstall row when retained private state was rebound
to a new plugin instance: the first repeated connection batch returned the old instance receipt and
Host correctly rejected it as `dot_migration_receipt_mismatch`. The accepted replacement scopes its
private receipt key to the target instance and permits only an owner-fenced, identity-equivalent
connection rebind. C does not bypass the receipt or modify package-private state; the same Host
journey is the acceptance check for the replacement bytes. On the exact accepted archive, the
isolated Manager journey now covers legacy `0.1.0` update, dormant import, enable, old-credential
`tools/list`, disable/uninstall, catalog reinstall with a new instance, target-scoped reimport,
another old-credential `tools/list`, and a final clean stop. The previous archive produced the
expected receipt-mismatch RED on this same journey; the replacement is GREEN. Its legacy image
fixture is a CRC/DEFLATE-valid PNG whose hash and byte size are derived from the decoded bytes.

The broader affected API slice is 168/168 GREEN, including webhook body budgets, shared relay,
legacy image authorization, migration coordination/invocation, cloud credentials, Manager
lifecycle, owner contexts, and package startup. Archive generation also verifies the bundled file
is byte-identical to the reviewed source (8,426,801 bytes) and matches the recorded SHA-256/SRI.

Runtime restart remains operator-only. Unmerged pairing tests use isolated worktree data and ports;
merged acceptance uses Alpha, never the operator runtime as a development target.
