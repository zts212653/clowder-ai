# F202 addressed plugin routing

Source: `docs/features/F202-plugin-framework.md#follow-up-direction-addressable-plugins-and-dot-2026-10-18`;
operator message `thread_mu8dg6h7l2x4ohsk#0001792496572158-000196-0a0473ac`,
approved execution thread `thread_mvgmbs3k4arklspp`.

Before: only members can be selected through an ordinary @ mention.
After: a plugin whose manifest declares `call` and whose active runtime implements the Host-owned
call delivery interface can receive ordinary queued messages. Members keep their adapters; the
Host never resolves a package-supplied delivery method name.

## 2026-10-21 architecture correction

Source: co-creator messages `0001792564244022-004158-6e59393a` and
`0001792564544995-004183-102870d5`. The earlier green candidate inverted authority by asking a
package to name the Host interface method (`addressedDelivery.method`) and promoted Dot's one-time
legacy import into the public manifest (`migration.method`). That candidate is superseded even
though its tests passed.

## Ownership and contract

| Data | Writer / truth | Readers / derivation | Change rule |
|---|---|---|---|
| `call: { alias, displayName }` | Verified package manifest; public contract owned by plugin repo | Host target discovery and presentation | Absence never opts in; metadata declares addressability but cannot select a runtime method |
| Fixed call delivery implementation | Active runtime object, structurally verified by Host | Queue delivery and call-targeted message subscriptions | `call` declaration and live `call.deliver` must both exist; no action-string fallback |
| Instance identity, alias, icon | Host plugin inventory | Mention discovery, Manager, presentation | Alias/icon edits persist without restarting; instance ID never changes |
| Queue recipients | Ordinary Message + Queue admission | Ordinary queue execution | Resolve before enqueue; never reparse a bound recipient |
| Delivery receipt | Existing handler via Manager | Source message delivery evidence | `{deliveryId}` acknowledges this input, not an external response |
| Reply / media | Existing messaging.send / streams | Ordinary history | No second thread/message store |
| Legacy Dot source | Existing Host legacy files, read-only | Isolated Dot compatibility adapter | Not a public plugin capability; import is owner/instance/digest fenced and never deletes source |
| Webhook ingress | Verified webhook contribution | Generic Host ingress | Path/method/body budget are declarative resources; package-specific RPC stays behind the handler |

Invariants:

- A plugin target is discriminated as a plugin, never inserted into catRegistry.
- Installed aliases are unique against member IDs/patterns and other installed instances,
  including disabled instances. Default aliases are persisted.
- Rename/icon edit and restart retain queued stable IDs. Disable/uninstall cannot redirect input.
- Handler rejection, timeout and receipt mismatch settle as unconfirmed input acceptance;
  they do not automatically retry. Crash recovery retains the same delivery identity.
- Subscription alone never implies addressability.
- A package cannot choose a Host call method name. Addressed and call-targeted subscription input
  enter the same fixed delivery interface.
- Legacy migration never appears in the public manifest or active action table.

| Existing behavior | Protection |
|---|---|
| Member mention grammar, availability and dispatch | Existing resolver, a2a, router, queue tests plus mixed target tests |
| IM thread-scoped subscriptions | Existing subscription-delivery and module messaging tests |
| Inventory recovery / retirement | File round-trip, disable, uninstall and reinstall counterexamples |
| Private source visibility | Existing source audience checks; no plugin exposure through member-only whispers |

## Implementation

1. Public contract: replace `addressedDelivery.method` with `call.alias/displayName`; remove public
   `migration.method`; keep bounded generic webhook declarations.
2. Fixed runtime call surface: module activation exposes `call.deliver`; carrier-neutral delivery
   invokes it directly and validates the existing receipt. Call-targeted subscriptions reuse it.
3. Inventory-backed target service: persisted alias/icon, explicit manifest declaration,
   collision checks and current lifecycle checks. Test real inventory transactions and restart.
4. Shared target discovery + admission: preserve existing mention grammar and member data;
   expose plugin targets separately, merge only in mention consumers; freeze instance IDs.
5. Ordinary queue execution: distinguish plugin recipient before member execution machinery;
   deliver the canonical message envelope, persist input acceptance and settle queue ownership.
6. Dot compatibility: the legacy reader calls the package importer through a quarantined adapter,
   not a manifest method or public HTTP action; completion/supersession remains durable.
7. Existing composer/Manager controls: consume the same discovery and edit projection.
8. Targeted API/web/type checks, non-author review, isolated acceptance. B supplies public
   contract tarball; C owns Dot cutover and real external journey. No production activation.

Architecture cell: plugin / dispatch / identity-session.
Map delta: update required; existing plugin cell records the inventory presentation and Manager queue consumer.
Why: preserve one admission and queue owner without manufacturing a member.
Canonical source: `host-inventory/ports.ts#PluginInventoryStore`, `InvocationQueue.ts#send`,
`subscription-delivery.ts#deliverEnvelope`.
Consumer evidence: `rg -n 'resolveSendTargets|resolveExplicitTargets|resolveConversationTargetsAtAdmission' packages/api/src`;
`rg -n 'analyzeA2AMentions|parseA2AMentions' packages/api/src`.
Claim guard: addressed target tests must fail for implicit IM addressability, alias retargeting,
receipt mismatch, disabled/uninstalled delivery and member dispatch regression.
Formatting: `pnpm biome check --write <changed TS/JS files>` then affected package type checks.

Candidate code/tests do not prove installed runtime behavior. Runtime restart remains operator-owned;
upstream advancement requires the accepted fork acceptance/soak boundary.

## Candidate evidence — 2026-10-20

Reporting boundary: operator scope correction
`thread_mu8dg6h7l2x4ohsk#0001792497857030-000289-22f45530`, relayed in
`thread_mvgmbs3k4arklspp#0001792497904954-000291-4b0c34b6`, requires A to notify the
operator after implementation, targeted verification and independent review. Do not wait
for B/C's overall cutover and do not restart the running instance.

Public dependency: plugin repository candidate
`d41fc4d05d4fa2bbcbd827e0ee05f9f6d87d615d` (B has not yet supplied independent approval).
Host vendors Contract `0.1.0-beta.39`, SHA256
`d8223ec9f9f071af91d51bbb9b2ddeb2da5fafdc2ce271e89d9e56634b7eac8a`,
and SDK `0.2.0-beta.22` with that exact contract dependency. beta.38 is not a final
dependency. `addressedDelivery.method` is consumed through the public PluginManifest
type; delivery/receipt shapes are unchanged. The independent `migration.method`
declaration is consumed by C, not this routing implementation.

### Scope and risk

Behavior: explicit user and completed agent speech can target installed plugin instances.
Plugin ingress, including external IM users admitted through a connector, also uses the
ordinary mention resolver and may explicitly address another installed plugin. This preserves
the pre-migration IM routing behavior when Dot was an addressable built-in member. A plugin
cannot wake its own source instance: self mentions are treated as ordinary speech, with the
existing member continuation policy when no other recipient remains.
Group mentions, implicit continuation, participants, whispers and Live remain member-only.
Data: one optional inventory address and one ordinary message receipt field; no new store,
TTL, queue, identity registry or thread model. Alias changes have their own revision and
cannot invalidate an activation or retarget an admitted message.
Security: owner-only address writes, existing runtime validity checks and delivery-scoped
media entitlement. Invalid/disabled/retired targets never redirect to a member.
Contract: B's opt-in manifest plus existing delivery envelope/receipt.
Irreversible: none exercised; no live configuration, production data, activation or restart.

### Verification and dogfood

All commands run in `/Users/lang/workspace/github-lab/cat-cafe-f202-addressed-routing`.

- Source behavior: `node --import tsx --import ./test/helpers/setup-cat-registry.js --test
  test/addressed-plugin-queue-delivery.test.ts test/plugin-addressed-targets.test.ts`
  under `packages/api/scripts/with-test-home.sh`: 15 checks cover inventory file restart,
  enabled opt-in vs IM, aliases, independent revisions, retirement/reinstall, stable queued
  identity, real POST message ingress, no phantom participants, private-input rejection,
  mixed unavailable preview, agent publication and terminal receipt behavior.
- API regression command recorded in `/tmp/f202-addressed-regressions.log`: 527 passed; covers Manager,
  route auth, queue/member adapters, member CRUD, negative authorization fence, routing/A2A,
  history and existing IM subscription/messaging/module delivery.
- `pnpm run test:redis -- node --import ./test/helpers/setup-cat-registry.js --test ...`
  leases its own isolated ephemeral Redis. Includes real Redis message restoration,
  atomic delivery, queue, history and IM checks: 235 passed, none skipped.
  Log: `/tmp/f202-addressed-redis.log`.
- Web: four affected component/API suites, 56 checks. Log:
  `/tmp/f202-addressed-web-tests.log`. API/shared build and web `tsc --noEmit` verify types.
- Browser: `test/browser/f202-addressed-plugin.test.mjs` runs the actual mention menu,
  recipient preview, receipt row and Manager detail with real Fastify address routes and
  inventory. Final test URL `http://127.0.0.1:57555` (closed after test); no runtime port.
  Select `@dot`, reject member-name collision while preserving the draft, rename to
  `helper`, reload and read the saved alias; verify the stable ID and activation revision.
  Desktop and mobile dark screenshots:
  `/var/folders/1z/8dpvll5d2fq7brlf2qk4kkw40000gn/T/f202-addressed-ui-pWxY1x/`.
  Author inspected both: neutral square plugin icons and no instance-ID text, no reply
  progress for input acceptance, no mobile horizontal overflow.

The browser fixture composes existing surfaces; it does not claim the installed runtime or
external Dot request/reply is verified. Real POST ingress and queue dispatch are tested
separately at their production entry points. C owns the joined external Dot journey.
The accepted UI draft is current thread message `0001792497549673-000269-5ad7f8b2`.
Intentional correction to its disabled-plugin copy: report unavailability, never silently
redirect plugin input to a member.

RED evidence found and fixed before review: published agent speech incorrectly required a
queued→delivered transition; history omitted the persisted receipt; mixed member/disabled
plugin preview omitted the unavailable plugin. Each precise regression now protects the
corresponding production entry or reader. Receipt and history checks distinguish acceptance
from a model response, including reload.

Architecture ownership checker is absent from this public checkout's package scripts;
the existing plugin ownership cell is updated directly. No new cell is introduced.
Capability tip is linked to the F202 source and opens existing plugin settings.
`pnpm check:capability-tips` passed (13 checker tests; existing missing-anchor warnings).
Biome completed with no errors; existing/nonblocking warnings remain. `git diff --check`
passed. No root media files. No PR or merge exists at candidate freeze.
Review remains required; this report is author evidence, not approval or runtime acceptance.

### Fallback coordinate self-check

`node scripts/check-fallback-layers.mjs` completed and flagged eight files for added
syntax matches. The coordinate remains installed instance identity, not mutable alias or
member identity; no fallback selects another recipient after plugin admission.

- Router/Manager route empty lists represent an absent optional addressed composition
  (existing member-only callers). Boolean member-or-plugin predicates are set membership,
  not retry layers. Existing selectedTargets default is the Queue's ordinary entry target.
- Inventory defaults turn a valid package label into one persisted, unique alias.
  Reserved-syntax and empty-normalization checks protect mention grammar, not alternate
  delivery paths. Package display name/icon defaults affect presentation only.
- Queue delivery has one bounded handler attempt. Timeout default is 30 seconds; catch
  records unconfirmed acceptance instead of retrying. Existing published speech without
  lifecycle uses its message ID as orderKey. A conflicting persisted receipt throws.
- Address form normalizes absent custom icons to null; unreadable error bodies receive one
  local message while preserving the draft. Upload and save failures do not change target
  identity or report success. Discovery failure removes selectable targets.
- Member route reindent accounts for most cats.ts matches; substantive defaults are only
  absent mention-pattern arrays. Browser tool path/owner defaults are isolated test setup.

A second target framework would add, rather than remove, ownership layers here. Existing
inventory, Queue, Message and Manager continue to own their respective facts.

## R1 review correction — plugin ingress self-target

Independent review `thread_mvgmbs3k4arklspp#0001792501129942-000492-3ac5f243`
requested one P2 correction on `a9861b52da0fea4da35feabfe2cf48cfb8ad0be8`.
The reviewer approved the other substantive paths and classified five additional
observations as nonblocking P3. Those observations are not claimed fixed by this delta.

The failure was a missing sender exclusion at the plugin ingress boundary. Canonical
`messaging.send` writes `StoredMessage.from.instanceId`; ordinary routing derives recipient
IDs from aliases; ingress now excludes that exact source ID before the existing Queue
admission. If self was the only recipient, existing implicit member routing resumes.
The published content and other explicit plugin/member recipients are preserved.
No new router interface, sender registry or queue policy was added.

Failure-mode sweep: `createPluginConversationDelivery` is the sole production plugin
ingress adapter (assembled in index.ts). Both automatic and explicitly selected wake
paths share the exclusion. Existing member A2A already excludes `currentCatId`;
ordinary user messages have no plugin sender to exclude.

RED: three real `host.send({wake:'auto'})` cases (self only, self + member, self + other
plugin) admitted the source instance. Log `/tmp/f202-addressed-ingress-red.log`.
GREEN: those cases, unchanged no-mention member continuation, and external IM→other-plugin
admission pass. The tests use production Host messaging, ingress, Router and Queue;
only the installed-target projection is a fixed fixture. Content preservation and exact
queued IDs are asserted.

Validation: API `pnpm exec tsc` passed; 329 tests passed in
`f202-c1-plugin-host-messaging`, `f202-c1-subscription-delivery`,
`f202-c1-module-carrier`, `agent-router`, `a2a-mentions` and `queue-processor`.
Log `/tmp/f202-addressed-ingress-green.log`. Biome passed with no errors.
No UI, persisted schema, public package or production runtime changed in this delta.
The original browser/Redis evidence remains applicable; package approval and operator
experience acceptance remain separate merge prerequisites.

## Reviewed package binding — 2026-10-20 17:39 UTC handoff

This binding supersedes the earlier beta.39 / same-version SDK beta.22 candidate above.
Package source: `c9e7ec557e5ac79e460f4a5deba94b141269f453`,
`zts212653/clowder-ai-plugins#95` (draft). Inbound authority:
`thread_mvgmbs3k4arklspp#0001792517958159-001439-0ed1ca05`.
Canonical source directory:
`/Users/lang/workspace/github-lab/dot-migration-b-artifacts/c9e7ec557e5ac79e460f4a5deba94b141269f453/`.

The GitHub API was read directly for
https://github.com/zts212653/clowder-ai-plugins/pull/95#issuecomment-6291505165:
reviewer `chatgpt-codex-connector[bot]`, exact source SHA, code review completed,
`has_any_findings=false`, `has_unresolved_findings=false`, updated
2026-10-20T17:22:30Z. This is independent code review, not formal CODEOWNER approval.

| Consumed archive under packages/api/vendor | SHA256 | SHA512 integrity |
|---|---|---|
| `clowder-ai-plugin-contract-0.1.0-beta.40-c9e7ec55.tgz` | `37f765206d7a994942948088e772aee5448009c91818eb979a444b5d3acb5d30` | `sha512-ww2oeh//AAjo7Ewjccdk0NBPdkn4+ZP3tZpWrrdWsTsSExsw6Lp0WaozMsyNKvRlt5UeBDmhJF4+IuBuo2llNA==` |
| `clowder-ai-plugin-sdk-0.2.0-beta.22-c9e7ec55.tgz` | `752f6c6dfa05ca53d6a6cca9ce0a3d48046bc02542baa08eaa78bce38d7d9b4d` | `sha512-8yE9NJfRbc9aNSqHp1UADOlS4MdXgf0ByYyujxCBUVMGkqs8BoYoGxyP1SvA1VadH/rZFwDiYz5d79ztZBXjqg==` |

Archives are copied without repacking. API package specs, root SDK→Contract override,
lockfile importers/resolutions/snapshot dependency and runtime contract package constant
now bind these exact artifacts. Earlier archives remain historical files, not dependencies.
The existing inventory pin test was stale at beta.37 (observed failure); it now verifies both
reviewed archive SHA256 values and the package/runtime version binding.

Validation in the A worktree:

- Recomputed SHA256, SHA512 and sizes for all three B canonical archives; all match
  `candidate.json`. Dot archive is only read for manifest validation, not installed/activated.
- Installed Contract's 246 files and SDK's 114 files match every file in their archives.
- Read canonical Dot `plugin.yaml` directly from its tarball: the installed Host validator
  accepts it and retains `addressedDelivery.method=deliverMessage`,
  `migration.method=dot.import` and `dot-mcp.requestBodyLimitBytes=15728640`.
- Parsed `pnpm-lock.yaml`: exact integrity, importer specs and SDK→Contract snapshot match.
- API `pnpm exec tsc` passed. Inventory/atomicity, Manager/service/composition/restart,
  module carrier, Host messaging and subscription suites: 150 passed, none skipped.
  Both addressed source test files: 15 passed. Logs:
  `/tmp/f202-reviewed-binding-build.log`, `/tmp/f202-reviewed-binding-tests.log`,
  `/tmp/f202-reviewed-binding-addressed.log`.
- `env -u NODE_ENV CI=true pnpm install --offline --frozen-lockfile` verifies reproducible
  lock consumption; log `/tmp/f202-reviewed-binding-frozen.log`. Biome and diff whitespace
  checks pass.

Review continuity: Host routing/queue/UI implementation is unchanged from opus-approved
`8197820cb2e9e587c1dfaddae291fc65952c5c6c`, verdict
`thread_mvgmbs3k4arklspp#0001792501492474-000514-f827257f`. This delta binds independently
reviewed package bytes, updates the package version constant and its existing pin test;
it does not claim a new opus exact-HEAD verdict.

C remains owner of dormant migration admission, webhook/relay request limits, durable legacy
media compatibility and real Host/ChatGPT journey. This schema acceptance does not prove
those runtime paths. Operator experience/soak and maintainer merge approval remain pending;
no production catalog publication, activation, restart or data migration was performed.

## Corrected fixed-port candidate — 2026-10-21

This section supersedes every earlier package-binding statement above. Those sections remain only
as audit history for the rejected `addressedDelivery.method` / `migration.method` design.

The Host now recognizes generic capability shapes, never Dot business methods:

1. `manifest.call` declares default alias/display metadata. The sole Host→plugin member call is the
   fixed `call.deliver(PluginMessageDelivery)` surface.
2. A plugin-created message subscription is delivered through the separate fixed
   `delivery.deliver(PluginDeliveryInput)` surface. Direct calls and subscriptions never share a
   package method or a `reason` flag, so Dot neither selects a Host method nor re-parses aliases.
3. A webhook declaration without a legacy action is dispatched through the fixed
   `webhook.handle({contributionId, request}, ownerContext?)` surface. `contributionId` addresses a
   package-owned resource; it is not a Host business method name.
4. Settings actions remain generic declared actions. No Host source path invokes or branches on
   `dot.rpc`, `dot.import`, `dot.followup` or `dot.image`. The bundled catalog projection is
   generated from the package-owned manifest; the Host no longer maintains a second hand-written
   Dot manifest or enumerates its private settings action names.
5. Legacy import is an isolated owner/instance/digest-fenced compatibility adapter that loads the
   verified package importer directly while the instance is dormant. It is absent from the public
   manifest, public HTTP routes and package action tables.

Exact locally packed and consumed artifacts:

| Archive | SHA256 | SHA512 integrity |
|---|---|---|
| Contract `0.1.0-beta.41` | `2285adf6d1ede36d895380606d720a83994e528e27af862efa4630ec9046af93` | `sha512-M20OYKsqM+qljyReFAJzE5tT5CNioLja2UqSn2q31es6afmcdsjjuX0UL0Yq7z9VuJbyDKs9i5zF3eMitj0dDQ==` |
| SDK `0.2.0-beta.23` | `439a65dd08ef1baf62b6b3a80760c8ea70ed8d9d196cc46734209f14a1fc767d` | `sha512-TPLQvHzxSSZLJRnTqeEAolePfYxY6yKGo1j3V+IbNTt3vRZs3HTNrifFtKuON7YjP8Af7z1wQnDVcT5ByJHeng==` |
| Dot `0.2.0-alpha.1` | `bf3a09f251a5f72e6998b1b057e62b235adf1426b1b04261cfba70ffaea0264f` | `sha512-OpyERNpUZLdU5J1/OXpjEk+ybS7szowbZsjgrKbmfIdfXXT1U1OVVZyelizXswkgTjwyq8kswdxwA0Ohe3q/VQ==` |

Component verification: Contract 638/638, SDK 231/231 and Dot 98/98. Host API build passed;
the broad fixed call/webhook, inventory pin, migration adapter, owner fence, Manager lifecycle and
real update/reinstall slice passed 129/129. After the final formatting-only archive repack, the
artifact-sensitive carrier/inventory/webhook/addressing/reinstall subset passed 83/83 with the
canonical cat-registry test bootstrap.
No production catalog, running instance, runtime configuration or persisted user source was changed.
