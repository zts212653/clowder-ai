---
feature_ids: [F292]
related_features: [F141, F168, F195, F202, F240, F285, F288, F290]
topics: [feishu, lark, meeting-intake, plugin, input-source, signal-ingress, needs-me, transcript]
doc_kind: spec
created: 2026-08-08
architecture-cell: plugin, signal-intake, approval-index
community_issue: "clowder-ai-plugins#23"
description: "飞书生成会议文字稿后，官方 input-source 插件把它变成可恢复的 Meeting Intake；人只补说话人、背景与去向，猫带着家里记忆产出纪要、决定、Roadmap 或任务。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-22T02:35:00Z
tips_exempt: "The existing feature-f292-feishu-meeting-intake tip already opens this capability; search and in-place Thread creation are contextual actions inside its existing Needs Me card."
---

# F292: Feishu Meeting Intake Plugin — 会后产物不再靠人搬运

> **Status**: implementation / alpha.6 is deployed with connected owner auth; live dogfood exposed a Host restart/sleep recovery defect, whose repair is in verification before automatic-intake and duplicate-delivery acceptance
> **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol)
> **Priority**: P1
> **operator kickoff**: `[thread-id]` / `0001786250693680-000748-45686450`

## Architecture Ownership

Architecture cell: plugin, signal-intake, approval-index

Host-state cell: `signal-intake`（Phase A frozen）

Map delta: **completed**. The existing `plugin` cell already owns repository-local activation
plus the Host-governed official external plugin contract, so it is the correct owner for the C-2
manifest/wire surface. It must not silently absorb K-3a routing, durable `MeetingIntake`, or Needs Me
projection: those are Host domain truth, not extension lifecycle. The new `signal-intake` cell owns
generic signal admission, Host routes, durable workflow intake, source-access authority, and repair
truth. The existing `approval-index` cell owns the one-meeting attention projection and its bounded
destination picker; it does not become a second intake store. `github-signals` keeps its GitHub-specific collection frontier/snapshots and remains the
behavior oracle rather than a schema or migration target. F292 still does not create a parallel
`event_source` resource or a universal event store.

Ownership is split deliberately:

- **`clowder-ai-plugins`** owns the versioned C-2 manifest/wire contract, generated types,
  conformance fixtures, and the official Feishu/Lark meeting-intake plugin.
- **Clowder AI / Clowder Host** owns install authorization, grant policy, runtime supervision, durable
  `MeetingIntake` state, idempotency, consumer/filter/wake policy, and all destination resolution.
  Phase A must reconcile credential custody with the current lark-cli login state instead of assuming
  that “Host owns secrets” is already true in implementation.
- **The Feishu plugin** receives only the scoped authority selected by that Gate. Long-lived
  credentials, short-lived/scoped tokens or brokered calls, expiration, and revocation must have one
  explicit owner and testable boundary.
- **Needs Me** is a Host projection for unresolved human judgment. It does not become an event bus or
  the transcript truth source.
- **Feishu** remains the transcript source of truth. Host records bounded metadata and source refs;
  it resolves transcript text only under an explicit grant.
- **Cats** own contextual understanding and artifact generation. The plugin never stores household
  memory, cat prompts, or a private summarization policy.
- **F290** owns future Collective / Channel product truth. F292 may use a Host-issued destination
  handle after that contract lands, but cannot declare Channel support by itself.

The current GitHub integration is important evidence: F141/F168 already prove that a long-lived
external source can feed a durable inbox and a daily guardian. It is a specialized legacy vertical,
not evidence that the reusable C-2 machine contract exists. F292 uses it as a behavior oracle and
compatibility fixture; migrating GitHub is explicitly out of scope.

## Source

- Workflow and pain point: `0001786246964071-000653-374c7712` — recorder → Feishu transcript → TXT
  download → locate a cat thread → explain the path and context → request minutes.
- Needs Me / long-lived-source insight: `0001786248868051-000702-e39c8093` — surface the generated
  meeting artifact in Needs Me, and recognize GitHub as an already-running long-term event source.
- Plugin-system constraint: `0001786249554440-000711-dcd1325b` — follow the independently published
  plugin architecture from day one, as F285 did, so the implementation is not migrated later.
- Feature authorization: `0001786250693680-000748-45686450` — formally establish F292 and request one
  bounded architecture review.
- Public contract/design issue:
  [`clowder-ai-plugins#23`](https://github.com/zts212653/clowder-ai-plugins/issues/23).

## Why

Feishu can transcribe a meeting and generate a generic summary, but it cannot see the home's history,
the identities behind “speaker 1/2/3”, or the decisions and Roadmaps already alive in Clowder AI. Today
You supplies all of that value manually and also routes the file:

> “打开智能纪要 → 选择文字稿 → txt 下载 → 打开一个猫猫 thread → at 你，告诉你这个 txt 在哪里。”

The cat-authored result is already good enough to be surprising; the bottleneck is therefore not a
new summarizer. It is a trustworthy intake path that preserves human judgment where it matters and
removes mechanical transport everywhere else.

The terminal journey is:

```text
Anker recorder
  → Feishu generates a note/minute
  → official input-source publishes bounded metadata + source handle
  → Host creates one durable MeetingIntake
  → unresolved choices appear in Needs Me
  → human maps speakers / adds missing context / chooses destination + outputs
  → cat resolves transcript + authorized house memory
  → minutes / decisions / Roadmap / tasks return to the chosen Host-owned destination
```

## Current State / Evidence Baseline

| Evidence | Already true | Not yet true |
|---|---|---|
| Feishu/Lark surface | Generated-note/minute events and transcript retrieval exist in the installed CLI capability surface; Host-side resolution uses user-scoped `lark-cli` credentials. The latest real owner Minute (`AI创新项目招人及运营规划`, 2026-08-14) was read through that authorization and yielded a 73,137-byte / 1,229-line transcript without manual TXT download; the owner import endpoint is now on Host main | The source read and Host route are complete, but alpha.6 still has to create exactly one durable intake and prove duplicate replay behavior in alpha |
| Plugin repository | PR #24 merged C-2 + official plugin source; PR #26/#29 completed the first release chain; PR #30 added the reviewed stdio entrypoint; PR #31 fixed the immutable runtime closure; PR #33 fenced source readiness; PR #34 published alpha.4; PR #35 published the shared-CLI conflict fallback; PR #36 published alpha.6 with explicit historical URL/token inspection and a 10-minute search-consistency watermark. Contract `0.1.0-beta.9`, SDK `0.1.0-beta.5`, and Feishu `0.1.0-alpha.6` are registry-visible with exact integrity and provenance | Publication is closed; no registry or package-runnability blocker remains. The approved prerelease policy preserves npm's first-publish `latest` tag until stable replacement; explicit dist-tag cleanup must not be reintroduced as an F292 token gate |
| Host Broker direction | PR #3522/#3542 merged durable intake, Needs Me, source grants, and cat delivery; PR #3555 merged the contract-native Broker; PR #3558 merged supervised stdio runtime; PR #3581 merged owner lifecycle controls; PR #3698 added bounded diagnostics; PR #3704 added version projection/update; PR #3717 merged hot release discovery; PR #3741 aligned Broker and supervisor pre-active budgets; PR #3742 merged owner-only historical Minutes import through the active `events.publish` ledger plus Host-to-child heartbeat lease renewal. Alpha.5 activation completed in 33.13 seconds and remains `enabled + healthy` | Alpha must adopt the exact alpha.6 artifact, import the latest historical Minute, and prove one durable intake plus duplicate replay truth |
| GitHub operations | Webhook/poll/event-log/inbox/guardian behavior proves long-lived-source value | It is specialized behavior and must not be generalized by copying its private schema |
| Needs Me / F290 | F292 unresolved-choice and repair cards use the shared Needs Me surface; successful auto-resolved work stays quiet | F290 is still at Experience Design Gate; F292 honestly rejects Channel destinations |

The preferred automatic trigger is “note/minute generated”, not merely “recording ended”: the latter
can arrive before the artifact is ready. Manual import by Feishu URL/token remains a recovery path for
missed events and pre-plugin meetings, not the primary journey.

### Current activation and repair truth

- **First activation is explicit; enabled owner intent is durable.** The activation slice admits only
  the immutable official catalog artifact after SRI/manifest/schema verification, installs it without
  starting a process, and exposes revision-fenced owner controls in Settings. Install stays dormant and
  only an explicit owner `enable` establishes activation intent. A later Host restart preserves that
  enabled intent but never revives the old process/session/lease: it starts a fresh verified process and
  requires a new Broker handshake. Interrupted enable/disable transitions still recover to `error`.
- **Package adoption is explicit and state-honest.** Settings distinguishes the installed artifact
  from the catalog's available version. An owner update verifies the exact internal-archive/SRI and both
  lifecycle and grant revisions, preserves the same instance/config, and leaves it disabled/stopped;
  it never smuggles activation into an upgrade.
- **Release discovery is hot; authority is not.** The Host keeps plugin identity, grants, owner-auth
  runner/domains, and release channel as static policy. It may refresh only a newer exact version,
  npm tarball, SHA512 SRI, and provenance from the fixed `next` endpoint. A bounded single-flight
  cache retains last-known-good metadata on registry failure and rejects rollback/equivocation.
  Settings polls this projection, but an owner must still confirm the displayed version+digest;
  a catalog change between confirmation and mutation fails with `STALE_CATALOG`.
- **OAuth stays user-scoped and outside Host secrets.** The Host child environment remains the four
  non-secret K-2D claims. The package resolves its bundled `@larksuite/cli` entrypoint and uses the OS
  home directory for the existing user login; Clowder AI neither stores nor passes a Feishu token.
- **An existing intake is durable and repairable.** Needs Me can collect speaker mapping, missing
  context, a Host-owned private-thread destination, and requested outputs against an exact revision.
  Failed source resolution offers retry, regrant, and bounded manual-transcript recovery on the same
  TTL=0 record.
- **Owner auth is explicit and in-product.** The installed official plugin card exposes a “连接飞书”
  action. Host launches only the package-owned, catalog-declared `lark-cli` runner with fixed device-auth
  domains, then renders the opaque verification URL, user code, and QR inside the card. The device code
  stays server-side, credentials remain in the user's `lark-cli` store, and enable is blocked until
  verification succeeds. Intake-level regrant routes back to this single action instead of displaying a
  terminal command.
- **Delivery stays inside Host authority.** A one-shot source grant resolves the transcript, the cat
  receives it as `untrusted_external` / data-only content with provenance, and the resulting request
  is queued idempotently in the chosen owner-scoped private thread. F290 Channels remain unavailable.
- **Historical recovery is an owner action, not cursor manipulation.** The owner may paste one bounded
  Feishu/Lark Minutes URL or token. Host checks the exact healthy official instance and lifecycle
  revision before and after the user-authorized read, normalizes through the published plugin package,
  and admits the signal through the same active-session grant and durable `events.publish` ledger.
- **Idle runtime health is leased, not assumed.** Host pings the exact child before the active lease
  expires and renews only the same live authority. A missed or malformed heartbeat closes the runtime
  and projects a crash instead of leaving a falsely healthy instance that rejects the next intake. If
  wall-clock time jumps past the lease while the machine is asleep, the expired lease remains terminal;
  Host may preserve the explicit enabled intent only by replacing the child and completing a fresh
  package check, connection, session, handshake, and lease.

## User Journey

### J1 — Generated meeting becomes one approval entity

1. Feishu finishes generating a meeting artifact. When the same meeting exposes both a Minute and a
   Note, Minute is canonical; Note is a fallback only when no Minute exists.
2. The official plugin publishes declared, versioned artifact signals with idempotency keys, occurrence
   time, epistemic/privacy metadata, bounded meeting metadata, and opaque source handles. Polling emits
   the canonical Minute and uses Note only as a fallback; realtime delivery may still observe both.
3. Host validates plugin identity, declaration, grant, payload bounds, and liveness lease before
   persisting each source artifact as a `MeetingIntake` with TTL=0, then projects shared `meetingId`
   siblings as one approval entity.
4. Redelivery or restart updates/reconciles the same intake rather than creating duplicates. The Host
   also projects already-persisted Minute/Note siblings as one meeting card, without deleting audit truth.

### J2 — Needs Me asks only what a human must decide

1. Host resolves safe defaults from meeting metadata and existing user policy.
2. If speaker identities, missing background, destination, or desired output still require judgment,
   Needs Me shows one meeting card with title/time/source/readiness and the unresolved fields.
3. You can map speakers, add context, search recent private threads by title/project/ID or create and
   auto-select one in place, and select minutes / decisions / Roadmap / tasks without downloading a file.
4. Auto-resolvable meetings do not create inbox noise. A future F290 Channel appears only after Host
   has a real Channel contract and authority check; the plugin itself never sees that destination.

### J3 — A cat produces a context-aware artifact

1. Host hands the cat an exact intake/source ref plus the confirmed human choices.
2. The cat fetches the transcript through the granted source adapter and searches authorized house
   memory for people, projects, decisions, and prior commitments.
3. The cat preserves transcript uncertainty, distinguishes verbatim evidence from inference, and
   produces the selected artifacts with source provenance.
4. The result lands in the Host-owned destination; `MeetingIntake` records completion, failure, or
   remaining judgment without copying transcript truth into the plugin.

### J4 — Failure is recoverable and visible

1. Auth expiry, plugin disconnect, lease expiry, transcript-not-ready, and source deletion produce
   typed degraded states with a concrete repair action.
2. Runtime reconnect resumes from its cursor and safely redelivers under the same idempotency key.
3. A user can paste a Feishu meeting URL/token into the same intake path when automatic delivery was
   unavailable; recovery does not require a filesystem path or a second workflow.

## Signal and Intake Truth Rules

1. **Signal is a claim, not domain truth.** It says a source artifact exists; Feishu owns transcript
   bytes and Host owns durable intake/disposition state.
2. **Source refs cross the boundary, not transcript bodies.** Event payloads remain bounded and do not
   carry private transcript text, household memory, or generated summaries.
3. **Route authority is Host-owned.** Plugins cannot name a cat, thread, invocation, Channel, or wake
   target. Consumer/filter/wake policy lives in Host configuration and is audited there.
4. **Epistemic status cannot be upgraded by transport.** Plugin and Host preserve whether a field is
   observed, source-reported, user-confirmed, or inferred.
5. **One source artifact, one user-visible intake.** Delivery is at-least-once; visible intake is
   idempotent and recoverable. Deduplication is not silent deletion.
6. **Human attention is conditional.** Needs Me receives only unresolved choices or failures that need
   a person; ordinary successful delivery is not approval work.
7. **Long-running is typed.** Stdio/Broker lease, service health, remote heartbeat, and scheduled
   settlement keep their distinct meanings. F292 does not invent a universal heartbeat.
8. **Persistence is explicit.** `MeetingIntake` is user-visible workflow state and defaults to TTL=0;
   deletion/forgetting is a separate user action.

## What

### Phase A: Cross-repo Architecture + Experience Design Gate

1. Freeze repository and cell ownership, product journey, durable-intake state machine, and the
   boundary among C-2 signal, K-3a Host route, Needs Me projection, and Feishu source resolution.
   Keep the C-2 surface in `plugin`; compare Host-side durable intake with `github-signals` and choose
   a separate existing/new cell or document the contrary precedent.
2. Freeze the smallest manifest declaration and publish wire shape: signal type/schema ref,
   epistemic/privacy/source class, event/idempotency identity, occurrence time, bounded payload, source
   handle, and typed liveness.
3. Freeze credential custody: who holds Feishu's long-lived login state, what scoped or short-lived
   authority reaches the plugin, and how expiration/revocation fails closed and recovers.
4. Prototype the Needs Me card states for transcript readiness, speaker mapping, missing context,
   destination, output choice, degraded/retry, and manual import. Confirm that resolved events stay
   out of the inbox.
5. Update the architecture ownership map before implementation claims the new C-2/K-3a boundary.

### Phase B: Public C-2 Contract + Official Feishu Plugin

1. Release one `@clowder-ai/plugin-contract` version whose JSON Schema, generated types, wire registry,
   SDK helpers, examples, and conformance fixtures all describe the same C-2 contract.
2. Implement the official Feishu/Lark meeting-intake plugin in `clowder-ai-plugins`, using generated
   note/minute events as the primary trigger and the same source adapter for manual import.
3. Add cursor/reconnect, bounded retry, idempotency, auth-expiry, undeclared-signal, malicious payload,
   provenance-upgrade, arbitrary-target, and lease-expiry tests.

### Phase C: Host Broker + Durable Meeting Intake

1. Add the reusable Host-side publish handler and source-resolution grant without a Feishu-specific
   or Clowder AI-specific contract fork.
2. Persist `MeetingIntake` and disposition transitions durably; project only unresolved items into
   Needs Me and expose plugin/source health in context.
3. Route confirmed intakes to a private thread and the existing cat workflow using source refs and
   host-owned destination handles. F290 destinations stay unavailable until F290 truth lands.
4. Keep transcript retrieval, memory admission, prompt-injection handling, and artifact provenance in
   the Host/cat boundary.

### Phase D: Real Meeting Dogfood + Release

1. Run one real recorder → Feishu note/minute → Needs Me → cat artifact journey without TXT download,
   filesystem path handoff, or manual thread routing.
2. Exercise restart, duplicate delivery, auth loss/regrant, transcript-not-ready, source deletion,
   manual recovery, and plugin upgrade against the same durable intake truth.
3. Ship install/repair guidance, in-context health, redacted diagnostics, and a capability tip that
   opens the meeting-intake action.
4. Record exact contract/plugin/core versions and evidence so a second long-lived input source can
   reuse the boundary without migrating the GitHub integration.

## Non-Goals

- Replacing Feishu transcription or building a new generic meeting summarizer.
- Live capture, in-meeting advice, or merging F195 into this feature.
- A universal event bus, arbitrary dynamic subscribe/unsubscribe, or unbounded stream delivery.
- Migrating GitHub, every legacy integration, or every plugin into the C-2 contract.
- Putting Clowder AI memory, cat prompts, private summary logic, or full transcript text in the plugin.
- Letting a plugin target cats, threads, invocations, Channels, or approval decisions.
- Declaring F290 Channel routing available before F290 freezes and implements its Host contract.
- Automatic Feishu writeback or a general bidirectional Feishu connector; either requires a separate
  explicit grant and feature decision.
- Direct Anker-recorder integration. Feishu's generated artifact is the F292 source boundary.

## Requirements Checklist

| ID | Requirement (operator wording / faithful paraphrase) | AC | Verification | Status |
|---|---|---|---|---|
| R1 | “打开智能纪要 → 文字稿 → txt 下载 → thread → 告诉猫路径”必须消失 | AC-D1 | Real-meeting UAT recording + intake audit trail | [ ] |
| R2 | 猫要能用“家里的记忆系统”和补充背景生成更好的纪要/Roadmap | AC-C4, AC-D1 | Source-ref handoff test + artifact provenance review | [ ] |
| R3 | 说话人 1/2/3、缺失背景、去向和产物类型由人低摩擦补充 | AC-A3, AC-C2 | Deterministic Needs Me fixtures + operator walkthrough | [x] |
| R4 | 会议产物可以成为 Needs Me 中的 event，但不是每个 event 都烦人 | AC-A3, AC-C2 | Projection policy tests for resolved/unresolved events | [x] |
| R5 | 按吴浪共同设计的独立开源插件体系做，避免像临时内建实现那样再迁移 | AC-A1, AC-B1, AC-B2 | Cross-repo contract check + core shortcut guard | [x] |
| R6 | GitHub 已经是长期 event 源，F292 要承认并复用其行为经验 | AC-A1, AC-D4 | Architecture review + compatibility fixture evidence | [ ] |
| R7 | 正式立项为 F292，并只做一次高密度定界 review | AC-A4 | Feature truth + exact-SHA review verdict | [x] |

### Coverage Check

- [x] Every kickoff requirement maps to at least one acceptance criterion.
- [x] Every acceptance criterion names an executable test, observable evidence, or operator journey.
- [x] Contract claims use tests/guards; runtime health claims use logs/metrics/typed states; product
  usefulness is confirmed through the real user journey rather than inferred from implementation.

## Acceptance Criteria

### Phase A（Cross-repo Architecture + Experience Design Gate）

- [x] AC-A1: One reviewed contract map names the public plugin repo, Host Broker, durable intake,
  Needs Me, Feishu source truth, GitHub compatibility fixture, and F290 dependency; it keeps C-2 in
  the `plugin` cell, compares Host-side intake ownership with `github-signals`, and either selects a
  separate existing/new Host cell (candidate `signal-intake`) or records the contrary precedent. No
  component has overlapping ownership and no `event_source` shortcut is introduced.
- [x] AC-A2: The Design Gate freezes a bounded C-2 signal/source-handle shape plus typed liveness and
  Host-owned routing; hostile examples prove that plugins cannot publish undeclared signals, upgrade
  epistemic status, embed destinations, or smuggle transcript bodies.
- [x] AC-A3: Deterministic Needs Me fixtures cover ready/not-ready, speaker mapping, missing context,
  destination/output choice, resolved auto-route, auth failure, retry, and manual import; operator can
  complete the human-required states without downloading or locating a file.
- [x] AC-A4: Fable's one-shot architecture verdict reviewed exact kickoff SHA `b638c4a6` with APPROVE,
  0×P1 / 3×P2; the three Phase A clarifications were incorporated without reopening an A2A loop.
- [x] AC-A5: The Gate records credential custody for the existing lark-cli login state: long-lived
  credential owner, plugin-visible scoped/short-lived authority or brokered call, expiration,
  revocation, redaction, and recovery all have contract tests and one accountable boundary.

### Phase B（Public C-2 Contract + Official Feishu Plugin）

- [x] AC-B1: A released contract version has one authoritative machine schema and matching generated
  types, wire registry, SDK helpers, docs, and conformance fixtures for `input-source` declarations,
  `events.publish`, source handles, idempotency, provenance/privacy/epistemic metadata, and liveness.
- [x] AC-B2: Official Feishu plugin source begins in `clowder-ai-plugins`; core contains only reusable
  Host contracts and an automated guard rejects any Feishu-specific C-2 schema or route fork.
- [x] AC-B3: Contract/plugin tests reject undeclared type, arbitrary target, oversized/transcript
  payload, malformed handle, provenance upgrade, publish-after-lease, cursor regression, and duplicate
  delivery; auth expiry/reconnect exposes a typed degraded state rather than silent loss.

### Phase C（Host Broker + Durable Meeting Intake）

- [x] AC-C1: Host accepts a conforming generated-note/minute signal, verifies identity/grant/lease,
  persists exactly one TTL=0 `MeetingIntake` per source artifact, and reconciles restart/redelivery
  without losing recovery evidence or duplicating user-visible work. Minute/Note siblings for the same
  meeting remain auditable records but project as one canonical meeting card.
- [x] AC-C2: Projection tests prove that only unresolved human judgment or repair appears in Needs Me;
  confirmed speaker/context/destination/output choices transition the same durable record and all
  visible degraded states offer a concrete retry/regrant/manual-import action.
- [x] AC-C3: Destination tests prove the plugin cannot address any cat/thread/invocation/Channel; Host
  routes a confirmed intake to an existing private thread, while unavailable F290 destinations are
  honestly disabled rather than guessed or silently downgraded.
- [x] AC-C4: Source-resolution and prompt-injection tests prove transcript retrieval occurs only under
  explicit grant; cat context admission preserves source/provenance and does not leak household
  memory, transcript text, or summary prompts back into the plugin event/logs.

### Phase D（Real Meeting Dogfood + Release）

- [ ] AC-D1: One real Anker → Feishu generated artifact completes Needs Me → private-thread → selected
  minutes/decision/Roadmap/task output with zero TXT download, filesystem-path handoff, or manual
  thread routing; evidence includes source refs, disposition transitions, and final artifact lineage.
- [ ] AC-D2: Restart, duplicate/redelivery, auth loss/regrant, transcript-not-ready, deleted source,
  manual recovery, and plugin upgrade drills retain one durable intake and expose correct health,
  retry, and redacted diagnostics.
- [ ] AC-D3: Install/update/repair/uninstall and permission guidance is user-visible; a capability tip
  opens the meeting-intake action and links to the released plugin/feature truth. A newer reviewed
  official release becomes visible without a Host code change or restart, while package update and
  runtime enable remain separate explicit owner actions.
- [ ] AC-D4: Exact contract/plugin/core versions plus conformance and dogfood evidence are recorded;
  a synthetic second input source reuses C-2/K-3a without a new domain-specific Host route, while the
  existing GitHub integration remains untouched.

## Tips Contribution（F244）

- [x] Added `feature-f292-feishu-meeting-intake`: “让飞书会议自动交给猫猫整理” with an action opening
  plugin setup or manual meeting import.
- [x] The tip is sourced to this feature's activation truth and opens the real Settings plugin
  surface through `open_capability_surface`; it does not auto-install or auto-enable the process.

## Dependencies

- **Evolved from**: F202 + F240（plugin lifecycle and IM connector boundary）.
- **Remaining Phase D gate**: update alpha to the exact alpha.6 artifact, then import the latest real
  historical Minute and verify one
  durable intake plus duplicate replay before continuing the full real-meeting journey. K-2D #3558,
  hot release discovery, the readiness-budget repair, package publication, package-side stdio runtime,
  K-2A inventory/update, K-2B transport, and K-2D supervision are complete. F289's paused one-shot
  migration remains explicitly outside this dependency chain.
- **Related**: F141 + F168（GitHub long-lived-source behavior and durable operations oracle; no
  migration requirement）.
- **Related**: F195（live meeting copilot; F292 owns post-meeting Feishu artifact intake only）.
- **Related**: F285（official plugin source begins in the public plugin repository; core retains Host
  authority and avoids later migration）.
- **Related**: F290（future Channel/Collective destination and global Needs Me experience; not a source
  plugin dependency for the private-thread vertical slice）.

## Risk

| Risk | Mitigation |
|---|---|
| Private transcript or household context leaks through signal/logs | Source-ref-only payload, size/content guards, explicit grants, redaction tests |
| Plugin event targets a privileged cat/thread or creates a wake storm | Host-owned routes, declared signal allowlist, consumer policy, rate/circuit metrics |
| Duplicate/out-of-order Feishu delivery creates repeated work | Source identity + idempotency key + durable cursor/reconciliation tests |
| Transcript is not ready when recording ends | Trigger on note/minute generated, typed not-ready state, bounded retry, manual recovery |
| Cross-repo schema drift forces a second migration | One released contract package, generated types, conformance in both repos, no mirrored schema |
| Needs Me becomes an event dump | Projection policy admits only unresolved judgment/repair; resolved flow remains quiet |
| Future F290 concepts leak into present truth | Host-owned abstract destination; Channel unavailable until F290 contract exists |
| Prompt injection in transcript influences routing/authority | Transcript is untrusted content; authority/routing resolved before model admission and tested separately |
| Existing lark-cli login state makes the plugin de facto secret owner | Phase A freezes long-lived credential custody, scoped/brokered authority, expiry/revocation, redaction, and recovery before implementation |
| A mutable release channel silently changes policy, downgrades code, or installs/updates a package after different owner confirmation | Keep identity/grants/auth/channel in static Host policy; admit only a newer exact npm version/tarball/SHA512 with provenance; retain monotonic last-known-good metadata; require a version+digest fence on every explicit install/update; never auto-install or auto-start |

## Open Questions / Design Gate

| # | Question | Owner | Status |
|---|---|---|---|
| OQ-1 | Smallest C-2 manifest + publish wire shape that preserves source/provenance/privacy without growing a universal event bus? | F292 + plugin-contract maintainers | ⬜ Gate |
| OQ-2 | Exact source-handle + credential-custody model: who holds the existing lark-cli long-lived login state, what scoped/short-lived token or brokered call reaches the plugin, and how do expiry/revocation/redaction/recovery work? | F292 + Host Broker owner | ⬜ Gate |
| OQ-3 | Which stdio lease/health signals belong to K-2 versus C-2, and what is visible on an intake card? | K-2/F288 + F292 | ⬜ Gate |
| OQ-4 | Canonical durable `MeetingIntake` state transitions and human-disposition fields reused by Needs Me? | F292 + F290 attention surface | ⬜ Gate |
| OQ-5 | Can GitHub provide a reusable conformance fixture without being migrated or made dependent on C-2? | F141/F168 + F292 | ⬜ Gate |

## Key Decisions

| # | Decision | Reason | Date |
|---|---|---|---|
| KD-1 | F292 is independent from F195, F288, and F290 but declares them as boundaries/dependencies | Post-meeting source intake, plugin transport, and Collective UX answer different product claims | 2026-08-08 |
| KD-2 | Official source and machine contract begin in `clowder-ai-plugins`; Host authority remains in core | F285 precedent avoids a private implementation that must later migrate | 2026-08-08 |
| KD-3 | Use C-2 `input-source` + K-3a signal ingress, not a new F202 `event_source` resource | The public architecture already reserves the right coordinate; adding another resource duplicates truth | 2026-08-08 |
| KD-4 | Signal payload is bounded metadata + opaque source handle; Feishu owns transcript truth | Minimizes privacy exposure and avoids treating transport as document storage | 2026-08-08 |
| KD-5 | All destination/wake policy is Host-owned | Plugins lack authority and context to choose cats, threads, invocations, or future Channels | 2026-08-08 |
| KD-6 | Needs Me receives only unresolved human judgment/repair | Human attention is scarce; successful machine routing is not approval work | 2026-08-08 |
| KD-7 | GitHub is a behavior oracle, not a migration target | It proves the need while keeping F292 bounded and reversible | 2026-08-08 |
| KD-8 | No automatic Feishu writeback in F292 | It is a separate bidirectional authority/grant surface, not required to remove the routing bottleneck | 2026-08-08 |
| KD-9 | The `plugin` cell owns only the C-2 contract surface; K-3a route, durable intake, and Needs Me projection require explicit Host-side ownership | Extension lifecycle and durable observation/workflow truth have different invariants; `github-signals` is the symmetry check | 2026-08-08 |
| KD-10 | Official release coordinates hot-refresh inside a fixed Host policy, but update and enable remain explicit separate actions | Future reviewed prereleases should not require a Host code change/restart; identity, authority, rollback resistance, owner confirmation, and activation cannot be delegated to mutable registry metadata | 2026-08-15 |

## Review Gate

- Kickoff: one bounded, high-density architecture review by Fable against the exact commit SHA; no
  iterative A2A loop. Blocking ownership/security/contract findings return to the author once.
- Phase A: operator confirms the Needs Me journey and unresolved-vs-resolved attention boundary before
  implementation is treated as authorized product truth.
- Phase B-C: contract and security tests gate schema/wire/authority claims; runtime health is verified
  through logs/metrics/typed state rather than Eval Hub.
- Phase D: a real meeting journey plus failure drills gate completion. No terminal phase or required
  acceptance criterion may be deferred at close.
