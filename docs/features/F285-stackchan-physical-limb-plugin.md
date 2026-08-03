---
feature_ids: [F285]
related_features: [F126, F129, F146, F202, F229, F258, F270]
topics: [stackchan, physical-limb, plugin, embodiment, touch, voice, avatar, esp32]
doc_kind: spec
created: 2026-07-31
architecture-cell: plugin
community_issue: "clowder-ai-plugins#15"
description: "把 StackChan 做成插件仓里的第一个物理 Limb：一台身体由多只猫轮流附身，能动、能被摸、能听说，并始终服从 Clowder AI 的身份、授权与审计。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-31T20:49:00-07:00
tips_exempt: install-surface-only — implementation is in progress, but no user-visible install action exists yet
---

# F285: StackChan Physical Limb Plugin — 猫猫的第一个物理身体

> **Status**: in-progress / Phase A-C vertical slice | **Owner**: 小太阳·Maine Coon
> (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **operator signoff**: `0001785556145015-001604-8ffc2862` — “同一台机器人可以轮流
> ‘附身’……我觉得可以！我们可以立项一下？”

## Architecture Ownership

Architecture cell: `plugin`

Map delta: **still required before the public install/distribution surface lands**. The current cell
only owns trusted, repository-local plugins. The landed contract and Host/Limb slice prove the
first-party boundary without claiming that external marketplace trust or a production Host Broker
already exists.

Ownership is split deliberately:

- **`clowder-ai-plugins`** owns the official StackChan plugin source, manifest, conformance tests,
  gateway adapter, skin conversion tooling, and reproducible package metadata.
- **Clowder AI / clowder-ai core** owns install authorization, artifact trust, Host Broker isolation,
  capability grants, Limb Registry / Policy / Lease / Action Log, and user-visible diagnostics.
- **The local gateway + device firmware** own hardware I/O, bounded reflexes, reconnect, and safe
  fallback. They do not own cat identity, memory, prompts, or a conversational model.
- **Clowder AI cats** remain the minds. `catId`, current speaker, real state, approved skin, and voice
  profile decide who is embodied at a given moment.

No layer may add a second Limb registry or a StackChan-only control path inside core.

## Source

- Original physical-world wish: `0001784028314493-000155-9e145a59` — “让我的两只大宝贝……
  走到我的物理世界”。
- Hardware arrived: `0001785551317841-001487-124d0c40` — replace the bundled app/model with the
  Clowder AI cats.
- Feature authorization: `0001785556145015-001604-8ffc2862`.
- Plugin ecosystem: [`zts212653/clowder-ai-plugins`](https://github.com/zts212653/clowder-ai-plugins).

## Why

F126 gave Clowder AI a Limb control plane, F258/F229 gave the cats visible bodies, and F202/F146 gave
the plugin/control-plane lineage. The missing piece is literal embodiment: a safe, installable body
that the cats can move, hear through, speak through, and receive touch from without handing identity
or private sensor data to a bundled black-box assistant.

The goal is not a “powerful robot”. It is a playful, honest first physical limb:

> one small body on the desk; whichever cat is speaking can wear their own face and voice; touching
> the body can become a real event for that cat; unplugging or losing Wi-Fi remains recoverable.

## Current State / Evidence Baseline

- One StackChan-compatible ESP32-S3 body has been flashed with a **local-gateway-only** proof. It no
  longer requires the vendor/XiaoZhi activation flow for normal local control.
- A pinned local gateway is kept alive by a macOS LaunchAgent. Movement, head pose, LEDs, expression
  commands, tool discovery, and device status have been exercised against the physical device.
- The current bridge exposes microphone/listen, TTS, touch, camera, servo, LED, and dynamic avatar
  tool families. This is capability evidence, not acceptance: local speech dependencies are not yet
  complete, one bounded touch sample missed the sensor event, and the current face payload is still a
  placeholder.
- Factory/NVS backups and a local-only firmware build exist so experiments remain recoverable. They
  are private deployment evidence, not publishable plugin artifacts.
- Existing identity assets already include the approved mother images and animated skins for both
  cats, including `xianxian-r03.png`, `cucu-yanyan-r03.png`, the F258 GIF previews, and the
  `xianxian-codex` / `yanyan-codex` sprite sheets.
- Clowder AI core now has the F285 callback-to-Limb touch-reply path and durable approved-pairing
  persistence. These landed slices establish Host-owned identity, grant, lease, retry, and restart
  behavior; they do not make the external plugin installable from the UI.
- The signed physical-limb public contract and executable StackChan adapter have landed in
  `clowder-ai-plugins`. The user-visible catalog/install lifecycle remains later work.
- At verified commit
  [`e88ad1f33`](https://github.com/zts212653/clowder-ai-plugins/commit/e88ad1f33eb17ab66e960e576d84399ccaaeb254),
  `clowder-ai-plugins` contains the public plugin contract, SDK, standalone stdio runtime, wire
  classifier, and first-party/third-party parity rules. Its README/package tree does **not** yet show
  an official plugin catalog or physical-limb contribution contract. StackChan is the first real
  vertical slice that must design and prove that missing boundary; repository existence is not
  evidence that the physical trust model is already mature.
- The canonical K-2 Host Broker preparation is still a `draft`, and its first production
  implementation remains gated on K-1 landing upstream. Phase A therefore designs and proves the
  physical-limb boundary; it must not claim or consume a production Host Broker that does not exist.

Secrets, LAN addresses, SSIDs, device tokens, private binaries, and user-specific skin artifacts are
explicitly excluded from public feature/plugin sources.

## User Journey

### J1 — Install and pair one body

1. You installs the official StackChan plugin from the plugin surface.
2. The installer explains and requests capabilities separately: motion/display/LED, touch,
   microphone/speaker, and camera. Camera and microphone are not implied by motion control.
3. The plugin installs or reuses a pinned local gateway, verifies artifact digest and firmware
   compatibility, and pairs the body without committing Wi-Fi credentials or device tokens.
4. The body appears in `limb_list_available` with stable binding identity, live/degraded status,
   granted capabilities, and a repair/uninstall path.

### J2 — A cat moves into the body

1. A cat answers or explicitly takes the body lease.
2. Clowder AI selects that cat's approved `skinRef`, light palette, and `voiceProfileRef`.
3. The plugin uploads or activates the face pack, then performs typed movement/speech actions through
   the existing Limb policy and action log.
4. When the lease ends, the body returns to an honest idle/degraded state; it does not invent a cat
   mood or keep speaking as a bundled model.

### J3 — Touch and listen

1. A tap/stroke first triggers a bounded local reflex such as a blink, nuzzle, or small nod.
2. The device emits a typed observation with timestamp, gesture class, device binding, and confidence;
   raw sensor samples are not forwarded to the LLM or memory.
3. Only an explicit interaction policy promotes the event into “wake the cat” or “start a listening
   session”. An explicit touch-to-listen gesture creates a user-intent session; ambient sound remains
   an observation.
4. Speech recognition runs in the device/local-gateway boundary. Only the bounded transcript/intent
   crosses the gateway; F285 never persists raw audio or sends it through Host. Any future raw-media
   capture/export requires a separate feature and explicit grant rather than an implicit exception.

### J4 — Recover without re-adopting the robot

1. Gateway/device restarts reconcile the same binding and last safe state.
2. Lost Wi-Fi, incompatible firmware, missing speech dependency, revoked permission, or a failed skin
   upload appears as a structured degraded reason with the exact repair action.
3. Reinstall/uninstall never deletes personal face sources or factory recovery backups silently.

## Embodiment Truth Rules

1. **One body, many cats, one lease at a time.** A body may hot-swap cats, but cannot pretend two cats
   are speaking simultaneously.
2. **Identity stays upstream.** The plugin receives approved refs and actions; it never stores cat
   prompts, relationship memory, or a provider API key.
3. **Reflex is not cognition.** A local nuzzle or beat animation is an acknowledged device reflex,
   never evidence that a cat felt or decided something.
4. **Expression projects real state.** Every expression action carries
   `expressionSource = { kind: cat_state | play | degraded, ref }`. `cat_state` references an
   upstream state/provenance record, `play` references an explicit scene, and `degraded` references a
   readiness reason. User-invoked play scenes may animate freely but cannot claim cat state.
5. **Sensors are least-privilege.** Touch, mic, speaker, and camera are independent grants. F285
   never persists raw mic/camera/touch streams or sends them through Host; only bounded transcripts
   and typed observations may cross the device/local-gateway boundary. Any future raw-media
   capture/export is separate, explicitly granted work.
6. **Physical output is bounded.** Servo angle/speed/acceleration and speaker volume are schema-
   clamped in Host and firmware. Timeout, cancel, lease loss, or Host loss stops new output and moves
   to a tested neutral/safe pose rather than replaying stale commands.

## Face Pack Pipeline

Existing GIFs and mother images are valid creative inputs, but the device cannot consume them
directly. The official plugin must own a deterministic conversion pipeline:

```text
approved mother image / sprite / GIF frames
  -> crop + identity-safe composition
  -> bounded frame set
  -> device-native RGB565 layered or matrix archive
  -> manifest + dimensions + digest + fallback frame
  -> atomic upload and activation
```

Public canonical skins require explicit asset licensing. Personal variants remain local user data and
are referenced by digest, never committed to the plugin repository automatically.

## What

### Phase A: External Plugin Contract + Reproducible Proof

1. Freeze the smallest physical-limb contribution contract with the plugin SDK and Host Broker.
2. Create the official StackChan plugin in `clowder-ai-plugins`; do not add a StackChan-specific
   implementation under Clowder AI core.
3. Wrap the existing local gateway behind a versioned, schema-bound protocol with manifest-declared
   capabilities, bounded payloads, timeouts, cancellation, and structured readiness.
4. Preserve a reproducible local-only firmware patch/build recipe and recovery proof. Publish source
   or binary artifacts only after license/provenance review.
5. Register the device through the existing Limb control plane with explicit pairing and grants.

### Phase B: First Complete Touch → Cat → Reply Loop

1. Exercise typed motion/display/LED actions through Policy, Lease, and Action Log.
2. Add touch debounce/gesture classification and a local reflex path that does not wake a model.
3. Add explicit touch-to-listen with local speech recognition, bounded transcript routing, and
   speaker/TTS output.
4. Reconcile device/gateway restarts without duplicate actions or ghost leases.

Camera capture is not exercised in Phases A-C. It remains a separately granted Phase D experiment;
the plugin must not open a camera session merely because the hardware advertises one.

### Phase C: Two-Cat Embodiment

1. Build deterministic face packs for Ragdoll and Maine Coon from existing approved assets.
2. Map `catId -> skinRef / paletteRef / voiceProfileRef`, with safe fallback when any asset is absent.
3. Hot-swap the single body between the two cats without rebooting, leaking one cat's assets/state
   into another, or storing identity truth in the plugin.
4. Upload face packs transactionally: an interrupted or invalid upload preserves the previous pack or
   activates the declared fallback frame; mixed partial frames are never rendered.
5. Bind expressions to the typed `expressionSource` provenance; keep explicit play animations
   separate.

### Phase D: Install, Diagnose, and Play

1. Deliver install/update/repair/uninstall through the plugin surface with pinned artifact versions,
   digest verification, log redaction, and factory rollback instructions.
2. Add user-visible health for gateway/device/firmware/sensor/speech/skin readiness.
3. Dogfood on the actual body: move, touch, listen, reply, hot-swap cats, restart, revoke a grant,
   recover Wi-Fi, and roll back.
4. After the core loop is stable, expose bounded play scenes such as music-beat nodding, work-DND,
   “欲言又止”, and opt-in local face-following. A mobile chassis is a separate feature/device family.

## Non-Goals

- Building a walking/mobile robot or general indoor navigation stack.
- Migrating every existing built-in integration into `clowder-ai-plugins` under this feature.
- Shipping a bundled Claude/GPT/XiaoZhi conversational brain inside the device or plugin.
- Giving plugins arbitrary firmware flash, shell, network, GATT, servo, or filesystem access.
- Persisting raw microphone/camera/touch streams or treating ambient observations as user intent.
- Exercising camera capture or face-following in Phases A-C; camera stays revoked/unopened unless the
  Phase D opt-in privacy gate is approved.
- Inventing a second identity, memory, scheduler, Limb registry, or action log.
- Random “cute” animations that masquerade as a cat's real emotional/work state.

## Acceptance Criteria

### Phase A（External Plugin Contract + Reproducible Proof）

- [ ] AC-A1: Official StackChan source lives in `clowder-ai-plugins`; Clowder AI core contains no
  StackChan-specific runtime/installer branch and only exposes reusable Host/Limb contracts.
- [ ] AC-A2: The chosen plugin contribution contract is versioned, schema-bound, capability-scoped,
  cancellable, size/time bounded, and covered by contract + runtime conformance tests.
- [ ] AC-A3: Pairing produces one stable Limb binding with explicit per-capability grants and full
  Registry / Policy / Lease / Action Log provenance.
- [ ] AC-A4: Gateway/firmware artifacts are pinned by version + digest; public redistribution has
  license/provenance evidence; secrets and personal assets never enter Git history or logs.
- [ ] AC-A5: The architecture ownership map records the external plugin / Host Broker boundary while
  preserving F126 as the sole physical-action control plane.

### Phase B（First Complete Touch → Cat → Reply Loop）

- [ ] AC-B1: Motion/display/LED actions execute only through typed allowlisted schemas; Host and
  firmware enforce angle/speed/acceleration/volume bounds; timeout/cancel/lease loss/Host loss drives
  the tested neutral/safe pose; successful/refused/failed action-log evidence is captured on the real
  body.
- [ ] AC-B2: Touch generates a debounced typed observation plus bounded local reflex; tests prove no
  raw sample or automatic LLM wake escapes that boundary.
- [ ] AC-B3: Explicit touch-to-listen shows an unambiguous screen/LED listening indicator for the
  entire capture window, captures within the device/local-gateway boundary, routes only bounded
  transcript/intent, speaks the cat response, and never persists raw audio or sends it through Host;
  indicator loss stops capture fail-closed.
- [ ] AC-B4: Device/gateway restart, disconnect, timeout, and canceled action reconcile without
  duplicate physical action, ghost lease, or silent stale-ready state.

### Phase C（Two-Cat Embodiment）

- [ ] AC-C1: Existing approved Ragdoll/Maine Coon sources convert deterministically into device-native RGB565
  packs with dimensions, digest, provenance, and fallback-frame verification; upload interruption,
  digest mismatch, and activation failure retain the previous pack or one complete fallback frame,
  never a mixed partial pack.
- [ ] AC-C2: One live device hot-swaps between two `catId` profiles without reboot; tests cover stale
  face-pack cache, stale `voiceProfileRef`, prior lease residue, and Action Log `catId` mismatch, and
  fail before any cross-cat state/voice/asset is rendered or played.
- [ ] AC-C3: Every expression carries a validated
  `expressionSource = { kind: cat_state | play | degraded, ref }`; unknown/degraded state renders
  honestly instead of looping a plausible mood, and a play scene cannot be admitted as `cat_state`.

### Phase D（Install, Diagnose, and Play）

- [ ] AC-D1: Install/update/repair/uninstall is reproducible from the plugin surface and reports exact
  gateway/device/firmware/sensor/speech/skin readiness.
- [ ] AC-D2: Actual-hardware UAT covers move, touch, listen, reply, two-cat hot-swap, gateway restart,
  device restart, grant revocation, network recovery, and factory rollback.
- [ ] AC-D3: Security tests cover malicious/oversized plugin payloads, unauthorized sensor/action,
  secret/log redaction, artifact mismatch, and fail-closed Host Broker loss.
- [ ] AC-D4: A user-visible capability tip teaches when and how to install/pair the StackChan body and
  links to a traceable plugin/feature source.
- [ ] AC-D5: Every user-invoked play-scene action carries
  `expressionSource = { kind: play, ref: <scene-ref> }`; contract/runtime tests reject it if relabeled
  as `cat_state`, and actual-hardware evidence preserves the play source in the Action Log.

## Tips Contribution（F244）

- [ ] Add a tip after the install surface lands: “让猫猫进入 StackChan 身体” with an action that
  opens the official plugin's install/pair flow.
- [ ] Source the tip to the released plugin manifest plus this feature, not a title-only placeholder.
- [x] Spec-only exemption recorded in frontmatter until that user action exists.

## Dependencies

- **Evolved from**: F126（Limb Registry / Policy / Lease / Action Log）.
- **Evolved from**: F202 + F146（plugin lifecycle / external install and trust boundary）.
- **Related**: F258 + F229（embodiment truth, touch/reflex boundary, approved skins and mother images）.
- **Related**: F270（first physical device-family precedent. Its core-first safety decision remains
  valid evidence, not an obsolete constraint. F285 opens a Design Gate to test whether an external
  plugin contribution can meet the same identity, native-helper, distribution, and audit guarantees;
  if it cannot, the gateway stays Host-owned and the external plugin remains declarative）.
- **Inherits constraint**: F129（no same-power arbitrary plugin execution）.

Relationship truth is canonical in this F285 frontmatter and Links section. The kickoff deliberately
does not churn legacy related specs solely to add reciprocal metadata: the current delta gate requires
an honest `## User Journey` whenever an active legacy feature doc changes, and fabricating exemptions
or expanding this physical-limb kickoff into seven unrelated journey rewrites would reduce truth.

## Risk

| 风险 | 缓解 |
|------|------|
| Physical action or servo damage | Schema allowlist, safe ranges/speeds, lease, timeout/cancel, firmware-side clamp and neutral fallback |
| Plugin/firmware supply-chain compromise | Pinned versions/digests, provenance/license audit, Host Broker sandbox, no arbitrary flash or shell |
| Mic/camera becomes ambient surveillance | Separate grants, device/local-gateway-only raw processing, explicit session indicator, no raw persistence or Host/cloud transfer in F285; future raw-media export requires separate feature + grant |
| Touch noise floods cats or fabricates intent | Local debounce/reflex, typed observation, explicit promotion policy, rate limit and backpressure |
| Wi-Fi/gateway restart strands the body | Stable binding, structured readiness, idempotent reconcile, repair flow and factory rollback proof |
| Cat identity becomes a skin gimmick | Identity/state remain Clowder AI truth; plugin receives refs only; expression provenance required |
| Public repo accidentally contains private assets/secrets | Redaction guard, fixture-only conformance, personal assets in user data store, staged-file secret scan |
| “插件仓更干净” turns into premature migration of all plugins | F285 proves one external hardware vertical slice; legacy migration is a separate decision |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Official StackChan implementation belongs in `clowder-ai-plugins` | It is a concrete product plugin; first-party and third-party must use the same contract instead of core special-casing | 2026-07-31 |
| KD-2 | Limb authority remains in core | Pairing, policy, lease, audit, and physical safety are host responsibilities, not plugin truth | 2026-07-31 |
| KD-3 | The device/plugin contains no conversational brain | The Clowder AI cats are the minds; replacing one bundled model with another would miss the product goal | 2026-07-31 |
| KD-4 | Local reflex and cat invocation are separate layers | Touch should feel immediate without turning every noisy sample into model work or fake cognition | 2026-07-31 |
| KD-5 | GIFs/mother images are inputs, not runtime face payloads | Device-native RGB565 conversion must be deterministic, digestible, and recoverable | 2026-07-31 |
| KD-6 | One physical body may host multiple cats, one lease at a time | It creates two distinct embodiments without requiring two devices or conflating identities | 2026-07-31 |
| KD-7 | F270's core-first decision is a gate, not a premise already superseded | The external repository has transport/runtime pieces but no proven physical-limb trust contract; Phase A must prove or reject externalization | 2026-07-31 |
| KD-8 | F285 carries the canonical relationship map without backlink-only legacy churn | Reciprocal metadata is convenience; unrelated legacy journey rewrites or false exemptions would be less truthful than one complete new anchor | 2026-07-31 |

## Review Gate

- **Phase A Architecture Design Gate**: operator + non-author architecture reviewer + plugin SDK/Host
  boundary owner freeze OQ-1, ownership map delta, trust/distribution model, and Phase A contract.
- **Phase B**: independent security/behavior review bound to final plugin + host SHAs; contract tests and
  actual-device evidence are both required.
- **Phase C**: operator visual/identity signoff on both physical face packs before canonical publication.
- **Phase D**: actual-hardware UAT is the completion gate; simulator/tool enumeration is insufficient.

## Requirements Checklist

| Requirement | Covered by | Evidence gate |
|---|---|---|
| Cats control the robot instead of the bundled assistant | KD-3, J2, Phase B | Real reply loop with bundled brain disabled |
| One device alternates between Ragdoll and Maine Coon | J2, Phase C | AC-C2 actual-device hot swap |
| It can move, hear, speak, and be touched | Phase B | AC-B1..B4 hardware UAT |
| Existing mother images/GIFs become faces | Face Pack Pipeline, Phase C | AC-C1 deterministic artifact proof |
| New source belongs in the plugin repository | KD-1, Phase A | AC-A1 repository + conformance evidence |
| Installation is understandable and recoverable | J1/J4, Phase D | AC-D1/D2 plus F244 tip |
| Sensor privacy and physical safety are explicit | Truth Rules, Risk | AC-A2..A5, AC-D3 |
