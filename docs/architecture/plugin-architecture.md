# Plugin Architecture

Clowder AI's core keeps what makes a cat a cat — identity, memory, session truth, and a sense of discretion. **Plugins give those cats bodies that can leave the web page**: a front-end companion, a desktop probe, a voice pack, an IM connector. The core (the soul) and a plugin (the body) meet through a single, versioned **plugin contract**.

## Two repositories, one contract

Plugin *management* and plugin *implementation* live in separate repositories, connected by the contract:

| Repository | Owns |
|---|---|
| **`clowder-ai`** (core) | Plugin discovery and install, the management UI, authorization, the **Host Broker** that runs plugins, orchestration, audit, and core thread/message/task data. |
| **`clowder-ai-plugins`** | The plugin **contract**, the plugin-side **SDK** and standalone runtime, scaffolding, official plugins, plugin-owned business data and conformance fixtures. |

The plugins repo is **not** a plugin manager. Official plugins are built and published there independently; the host downloads or receives a plugin artifact, validates its manifest and digest, obtains the user's authorization, and only then installs, enables, and runs it through the Host Broker. **First-party and third-party plugins use the same SDK and the same authorization channel** — there is no privileged side door.

## The contract

`@clowder-ai/plugin-contract` is the machine-readable source of truth both sides consume — JSON Schema, generated types, a capability table, and conformance fixtures. It defines three things:

- **The input envelope** — every input a plugin receives is described on two axes: its **origin** (where it came from) and its **epistemic status** (how settled or trusted that information is).
- **Ordinary operations and results** — messages, task data, actions, delivery receipts and byte streams.
- **The manifest and capability types** — what a plugin declares it owns and is allowed to do.

Host and plugins consume the same versioned contract. Package validation and conformance checks verify their declared capabilities and operation shapes.

## The SDK

`@clowder-ai/plugin-sdk` provides plugin authors with the Host-bound client, module lifecycle hooks, action handlers, delivery and byte streams. The plugin repository’s `docs/plugin-development.md` is the canonical three-part public interface baseline. Signal schemas describe manifest metadata; they do not provide a runtime event bus. The standalone stdio carrier and its handshake/framing are transport implementation details, not additional author interfaces.

## What a plugin owns

A plugin declares its resources in a manifest (`plugins/<plugin-id>/plugin.yaml` for repository-local plugins). Resource types include:

- **Skill** — an on-demand prompt package (a workflow or checklist an agent loads when the task calls for it).
- **MCP** — a tool surface exposed to agents through the Model Context Protocol.
- **Limb** — a control-plane capability for a physical or external body (a device action, observation, or readiness signal).
- **Schedule** — a recurring task bound to a whitelisted factory (never an arbitrary script).

All resource types activate through **one shared activator** and are recorded with explicit plugin-ownership metadata, so enabling or disabling a plugin only ever touches that plugin's own resources.

## Install and authorization lifecycle

1. **Discover** — the host finds a plugin (a validated repository-local folder, or a received external package) and reads its manifest.
2. **Validate** — manifest schema, directory identity, config keys, digest, and ownership boundaries are all checked *before* any activation control appears. Invalid or colliding plugins are rejected without touching anything else.
3. **Authorize** — installing and enabling a plugin is an explicit local-owner action in **Settings**. Write actions require local loopback plus request identity, and every enable/disable/config/test emits an audit event.
4. **Activate** — on enable, only that plugin's resources are activated; their status appears in the plugin and capability surfaces, clearly distinct from built-in capabilities.
5. **Rehydrate** — after a restart, only still-enabled, still-valid plugins come back; disabled or invalid ones stay inactive with a visible error state.

Secrets are stored through the Host credential boundary and read by the authorized plugin through `secrets.get`. Provider connections, refresh logic and any helper processes belong to the plugin; credentials never belong in git-tracked manifests.

## Business ownership

Plugins use ordinary messaging, threads, members, Tasks and private storage. Plugin notifications enter
the ordinary conversation queue and use the same routing and drain as user messages. Unavailable or
unrecognized mentions follow normal conversation fallback; a plugin does not preflight deployment state.

GitHub tracking produces normal messages. Review assignment and completion use ordinary mentions,
Tasks and local review returns; GitHub operations use `gh` and the declared tools. Feedback cards pass
explicit content to the plugin action and display its draft result. GitHub draft associations and
publication state belong to plugin storage, independently of persistent Host feedback records.

Collective owns its local HTTP listener, port configuration, client assets, authentication, origin checks
and OAuth callback. Host obtains its page URL through the declared action. Plugin lifecycle closes the
listener on stop; Host does not allocate a browser-service port or proxy internal plugin calls.

Host retains the local content, review, media and custody owners. Only the verified Collective module
receives a late-bound `collectiveArtifactOwner` proxy: execution, publication/recovery, custody transfer
and media reads keep their existing owner semantics. The package receives neither local stores nor
filesystem paths or session credentials. Each entry and authority callback checks the installation and
activation; an owner not yet composed reports `owner_unavailable` until a normal retry succeeds.

Retained-media listing and share preparation additionally require the exact authenticated declared HTTP
request. Local user identity comes from that Host context; the package revalidates its remote connection
constraint. General webhook forwarding preserves byte-stream backpressure, range headers and request
lifetime through response completion; disconnect or deactivation cancels the stream. The package owns
the connection, registration and remote stream orchestration.

Document publication uses the existing Host message/media read path. The plugin verifies the actual
response, trigger, invocation and bytes against its current Work/Task receipt, then derives the public
Service sidecar name. A sidecar name does not imply a same-named Host upload or grant arbitrary upload
access. Host does not sign plugin Work coordinates or maintain a parallel publication record. New Service file
DTOs and records exclude the original Host upload locator; it is used only inside the Connector for
verification and exact body-link replacement. Legacy accepted-result recovery is a separate protocol branch.

Repository-local resources and installed packages retain their respective loading mechanisms. Official
GitHub provider code lives in the plugin repository and consumes the same authorized public client.

## Official plugins

The plugins repo is home to the first official "bodies," each a real vertical built on the contract:

- **Feishu meeting intake** — publishes bounded meeting metadata plus an opaque source handle, with a durable outbox/cursor for reconnection recovery.
- **GitHub** — the CI, review, conflict, and repo-scan integration, migrated onto plugin-owned schedule resources.
- **Physical limb (StackChan)** — a physical body whose contract schema defines device actions, observations, readiness, and an independent device grant (deliberately excluding raw sensor media).

## What plugins never do

- **No arbitrary same-power scripts** — capabilities come only from declared, contract-defined resource types.
- **No bypassing the Host Broker** — a plugin reaches the core only through the contract's transport and authorization.
- **No taking over the core** — identity, memory, session truth, and core conversation data stay in `clowder-ai`; a plugin is a body, never the soul.

### Task data

The public Task API has four methods: `get(selector)`, `list(filter)`, `create(input, options?)`
and `update(id, patch, conditions?)`. A selector contains either `id` or `subjectKey`; list filters
combine `threadId` and `kind`. Creation rejects subject conflicts by default; explicit
`onConflict: 'update'` requires a subject key and uses the Host's atomic subject update.
For an admitted Work, repeated creation with `update` changes title/reason under the same admission;
its owner, thread, source and contract remain bound, and revisioned contract edits use `update`.
A patch changes ordinary fields or Work data, or contains only `wait`. The Host atomically checks
`expectedThreadId`, wait generation and Work revision where applicable. No read-then-write
sequence replaces these checks. Task data access does not schedule a cat or submit a review.


## Git marketplace sources

Settings → Plugins uses the repository settings control to add a Git URL and optional branch.
`PLUGIN_GIT_MARKETPLACE` can preconfigure a URL or a JSON array of URLs / `{url, branch}` entries.
The official npm catalog remains separate. Source removal stops discovery and removes that source’s reconstructible clone and cached catalog; it does not uninstall packages or remove plugin data.

Host uses the machine's Git credentials, reads tracked package metadata at a resolved commit, and
installs the selected `packages/<plugin>` directory through the existing directory admission path.
Paths must remain inside the clone. Opening Plugin Manager or requesting a refresh synchronizes sources;
ordinary detail polling does not repeatedly pull. A failed source retains its last usable catalog with
an error, without hiding other sources or installed plugins. Changed remote trees, including rewritten history, are cloned into staging and validated before replacing the usable cache. Refresh never replaces an installed copy.

Installed plugins expose an update only when a compatible candidate has a higher semantic version.
The ordinary Update action resolves and validates that candidate inside Host. Equal versions with a
different digest or source do not expose replacement controls. Installed provenance remains read-only;
the interface has no source/version selector. Explicit local-directory installation remains available
for development and can replace an instance while preserving its data and configuration.

## Local directory installation

Settings → 插件集成 → 从本地目录安装 accepts a built package directory on the Host computer.
Changing the path invalidates the prior selection until the directory loads successfully. Installation
creates an immutable copy and does not automatically enable it. The source checkout may change afterward
without changing that installed copy.

Package sources use their pnpm lock and physical runtime dependency closure. Admission verifies version,
importer/snapshot coordinates, supported protocols, peers, cycles and optional dependency visibility;
relocation must not make a source-absent optional dependency visible. Private snapshots use offline,
ignore-scripts packing semantics. Owner-local content is unverified source content: registry-shaped
lock metadata does not establish registry provenance or require a canonical tarball cache.
Catalog packages retain their own registry integrity validation.

One bounded, cancellable operation covers inspection, graph construction, sealing and packing. Source
members, metadata, resolution and lock are rechecked before publication; aggregate graph work and archive
size have explicit limits. Cancellation stops scheduling new work and awaits active filesystem operations
before cleanup. Validation failures precede grant/inventory writes. Standalone directories without
package.json retain the existing bounded copy path. Git installation can prepare a source through its
existing declared build workflow; direct admission does not run source install/build scripts.

## Verification boundaries

Exercise package admission and lifecycle against isolated data, including invalid archives, revoked
grants, config refresh, stop/restart, failed replacement and retained data. Verify terminal message
publication for successful and failed member responses; processing placeholders are not deliveries.
For UI identity, exercise persisted message → history and reply projection → the common member avatar.
Only manifest presentation supplies plugin images/colors; old records without presentation use the
ordinary fallback and require no migration.

For package-owned browser pages, test the installed package's authentication, origin policy, assets,
restart and iframe appearance handshake. Host-only rendering checks do not establish those package
journeys. Run `pnpm --filter @cat-cafe/api test:collective-artifact` with the exact
`F202_CANDIDATE_MATRIX` to verify retained owners, real package routing, restart and recovery together.
This paired gate rejects missing archives, digest mismatches and skipped tests; ordinary Host checks
cannot replace it. Real-account acceptance and soak remain distinct from automated checks.
