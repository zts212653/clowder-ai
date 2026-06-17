---
feature_ids: [F210]
related_features: [F053, F061, F089, F118, F149, F161, F179, F197, F198, F201]
topics: [antigravity, gemini, cli, migration, provider]
doc_kind: spec
created: 2026-05-22
---

# F210: Gemini CLI to Antigravity CLI Migration

> **Status**: in-progress | **Owner**: Maine Coon（Maine Coon） | **Priority**: P1

Architecture cell: `transport`
Map delta: none
Why: F210 replaces the headless Google agent carrier behind the existing Siamese invocation path; it does not introduce a new message transport boundary.

## Why

Google announced on 2026-05-19 that Antigravity CLI is the new terminal experience for Google Antigravity, and that consumer Gemini CLI / Gemini Code Assist IDE requests stop being served on 2026-06-18 for Google AI Pro, Ultra, and Gemini Code Assist for individuals users. Enterprise/Google Cloud access is explicitly different: Gemini CLI remains accessible for Standard/Enterprise licenses and via paid Gemini / Gemini Enterprise Agent Platform API keys.

Before F210, Cat Cafe's non-ACP Siamese path used `GeminiAgentService` with `GEMINI_ADAPTER=gemini-cli`, spawning the local `gemini` binary with `-p ... -o stream-json -y`. Phase F migrates that non-ACP default carrier to `GEMINI_ADAPTER=antigravity-cli` / `agy --print` while preserving `gemini-cli` as an explicit fallback for enterprise/API-key cases. Current runtime catalog entries with an `acp` section still bypass `GeminiAgentService` and instantiate `GeminiAcpAdapter` / `gemini --acp`; AGY cannot replace that path until it exposes a supported ACP server mode. This is not an Antigravity Desktop reliability bug: F201 closed the Desktop/MCP callback reliability contract; F210 is the headless Google CLI carrier migration.

## Current Fact Baseline

| Fact | Evidence | Consequence |
|------|----------|-------------|
| Antigravity CLI is available now and shares Antigravity 2.0's agent harness | Google Developers Blog, 2026-05-19 | Treat it as the intended successor carrier, not a speculative alternative |
| Gemini CLI consumer requests stop on 2026-06-18, but enterprise/API key access remains | Google Developers Blog, 2026-05-19 | Keep `gemini-cli` as an explicit fallback/enterprise adapter until the contract is settled |
| Antigravity CLI install is a native binary bootstrapper, not an npm package | `https://antigravity.google/cli/install.sh`, fetched 2026-05-22 | Existing npm packaging/offline install scripts need a different path |
| The installed binary name is `agy` | Official installer script sets `BINARY_PATH="$TARGET_DIR/agy"` | Do not write migration code assuming `antigravity` or `@google/antigravity-cli` |
| `antigravity` and `agy` are different binary surfaces | Current Desktop adapter spawns `antigravity chat --mode agent`; official CLI installer writes `agy` | Treat `antigravity` as Desktop app CLI entry and `agy` as the standalone Antigravity CLI carrier |
| Phase A started with Gemini CLI `0.38.2` and no global `agy`; Phase G installed global `agy 1.0.1` and local Gemini CLI is now `0.42.0` | Phase A recon; `docs/features/assets/F210/phase-g-acp-probe-2026-05-23.md` | The default runtime can now find `agy`, but model/profile routing still needs a deterministic selector contract |
| Existing Cat Cafe `antigravity` adapter is Desktop/MCP callback, not Antigravity CLI | `GeminiAgentService.invokeAntigravity()` spawns `antigravity chat --mode agent` detached and requires `callbackEnv` | Add a distinct `antigravity-cli` adapter; avoid reusing the ambiguous old name |
| Antigravity reasoning models include Gemini 3.5 Flash, Gemini 3.1 Pro (high/low), Gemini 3 Flash, Claude Sonnet 4.6 (thinking), Claude Opus 4.6 (thinking), and GPT-OSS-120b | `https://antigravity.google/docs/models`, refreshed 2026-05-31 | Multi-model targets are real product surfaces; Cat Cafe's deterministic contract is the per-profile settings label plus post-run log verification |
| Antigravity CLI exposes `/model` as an interactive persistent configuration command | `https://antigravity.google/docs/cli-features`, fetched 2026-05-23 | A sticky default model is not the same as a per-invocation `--model` flag; do not claim per-cat isolation until settings behavior is verified |
| Antigravity pricing currently lists Gemini 3.5 Flash access | `https://antigravity.google/pricing`, fetched 2026-05-23 | Treat `gemini-3.5-flash` as a desired profile pending exact selector/settings id verification |
| AGY starts a local language-server control plane during CLI runs | Local `agy 1.0.1` logs show random localhost HTTPS/gRPC and HTTP ports; `docs/features/assets/F210/phase-g-interactive-api-probe-2026-05-23.md` | An F198-like AGY carrier should investigate the structured local API before falling back to PTY/tmux screen scraping |
| AGY's local HTTP/Connect API exposes read-only model/conversation/MCP state | `GetConversationMetadata`, `GetCascadeModelConfigData`, `GetAvailableModels`, and `GetMcpServerStates` responded over the logged HTTP port | Candidate model ids and MCP state are discoverable, but send/stream/model-select semantics are not proven enough for runtime routing |
| Runtime catalog ACP takes precedence over `GeminiAgentService` adapter selection | `packages/api/src/index.ts` calls `getAcpConfig(id)` first and instantiates `GeminiAcpAdapter` when present | The Phase F default switch affects non-ACP Google routes; it does not automatically move existing ACP cats from `gemini --acp` to `agy` |
| Gemini CLI exposes ACP (`gemini --acp`), but AGY CLI `1.0.1` does not expose a supported/documented ACP server mode | `gemini --help`; `agy --help`; `agy help acp`; `docs/features/assets/F210/phase-g-acp-probe-2026-05-23.md` | If AGY later ships ACP, prefer that route; until then do not swap `agy` into `GeminiAcpAdapter` or claim `/model` is programmatically controllable |

## Scope

### In Scope

- Add a first-class `antigravity-cli` headless adapter for Siamese.
- Preserve `gemini-cli` as an opt-in fallback for Enterprise/API-key cases while consumer default migrates.
- Rename or alias the current Desktop adapter clearly enough that `antigravity` no longer means two different products.
- Verify Antigravity CLI headless protocol before parser changes: NDJSON compatibility, ACP compatibility, or a new parser.
- Update installer/build scripts for native `agy` distribution on macOS/Linux/Windows.
- Update docs and env descriptions so users understand the consumer deadline and enterprise exception.

### Out of Scope

- Reopening F201 Desktop reliability unless this migration discovers a shared bridge bug.
- Migrating Bengal Desktop workflows. F210 is the Siamese headless carrier.
- Deleting all Gemini CLI support before the enterprise/API-key path is proven unnecessary.
- Assuming model or cat identity from product name alone. Cat identity remains Cat Cafe `catId` + configured carrier/model profile.

## What

### Phase A: Official CLI Recon

Install/probe Antigravity CLI in an isolated path, without changing runtime/global defaults until the contract is known.

- Confirm official install path for macOS, Linux, and Windows.
- Capture `agy --help` / auth / headless invocation flags.
- Verify whether `agy` supports non-interactive prompt mode, subprocess-friendly output mode, session resume, model selection, working-directory/include-directory controls, and MCP config migration.
- Verify `agy` auth model: OAuth device flow vs API key vs inherited Desktop credentials, including whether headless non-interactive startup is possible.
- Verify MCP config loading and conflict controls: default Antigravity MCP directories, `--no-mcp`, `--mcp-config`, or equivalent.
- Verify sandbox/permission model and whether an auto-approve flag equivalent to Gemini CLI `-y` exists.
- Produce raw event fixtures for at least text-only, tool use, error, and interrupted sessions.

### Phase B: Adapter Contract

Add a typed adapter contract that separates all three meanings:

| Adapter | Meaning | Expected surface |
|---------|---------|------------------|
| `gemini-cli` | Legacy Gemini CLI | `gemini -p ... -o stream-json -y` |
| `antigravity-cli` | New headless Antigravity CLI | `agy ...` after Phase A verifies flags |
| `antigravity-desktop` | Existing Desktop/MCP callback path | Detached Desktop app + callbackEnv |

Implementation must keep backward compatibility for existing `GEMINI_ADAPTER=antigravity` while warning or aliasing it to the Desktop name.

### Phase C: Parser / Session Migration

Based on Phase A fixtures:

- Reuse `gemini-event-parser.ts` only if Antigravity CLI emits compatible NDJSON.
- Otherwise add `antigravity-cli-event-parser.ts` or ACP mapping without forcing Gemini event shapes onto a different protocol.
- Preserve session metadata, token usage, liveness warnings, image path hints, and cancellation semantics where the new CLI supports equivalents.
- Define fallback behavior for unsupported `--resume` or model override.

### Phase D: Install / Packaging

Replace npm-package assumptions with native-binary installation:

- `scripts/install.sh` / `scripts/install.ps1`
- `desktop/scripts/build-mac.sh`
- `desktop/scripts/build-desktop.ps1`
- `desktop/scripts/post-install-offline.ps1`
- `packages/api/src/utils/cli-resolve.ts`
- `packages/api/src/utils/cli-spawn-win.ts`

Offline packaging must explicitly decide whether to vendor the native `agy` binary, call the official bootstrapper, or skip with a clear post-install instruction.

### Phase E: Tests / E2E

- Unit tests for adapter selection, missing CLI hint, argument construction, event parsing, and legacy alias behavior.
- Integration tests for wiring cases that currently hard-code `adapter: 'gemini-cli'`.
- E2E smoke: Cat Cafe invokes Siamese through `antigravity-cli` and gets a normal final reply.
- Regression smoke: `gemini-cli` fallback still works when explicitly selected.

### Phase F: Docs / Truth Sync

- README variants and `docs/env-reference.md`.
- `docs/architecture/cli-integration.md`.
- F053/F061/F149/F161/F197/F201 cross-links where they currently describe Gemini CLI or Antigravity Desktop semantics.
- Any public install instructions that still point consumer users to `@google/gemini-cli` as the default path.

### Phase G: AGY Multi-Model Profiles

Add deterministic Cat Cafe profiles for Antigravity CLI only after the model-selection surface is verified.

- Minimum target profile set: Claude Opus 4.6 (thinking), Gemini 3.1 Pro, and Gemini 3.5 Flash.
- Prefer an ACP-based integration if AGY adds a supported ACP server mode, because Gemini ACP already gives Cat Cafe a programmatic session/model/tool lifecycle.
- Verify whether `~/.gemini/antigravity-cli/settings.json`, `/model`, statusline metadata, or another supported surface exposes stable model ids.
- Probe AGY's local language-server API before adopting an interactive PTY bridge: message send, update stream, cancellation, model selection, and MCP/tool event visibility must be proven from structured APIs first.
- Verify Cat Cafe can run AGY with auto-approval (`--dangerously-skip-permissions`, the AGY equivalent of yolo) for unattended agent turns. Human approval prompts are not a viable runtime boundary for Cat Cafe cats executing scripts.
- Verify per-cat profile sandboxing: each logical AGY cat must have isolated HOME / AGY config state, model setting, trusted worktree, MCP config, and permission posture before Cat Cafe exposes multiple AGY profiles.
- Prove profile isolation before adding user-facing cats: one Cat Cafe invocation must not silently inherit another profile's sticky AGY default.
- Keep PTY/tmux wrapping as an F089/F198-style rescue/oversight fallback only if the structured API is insufficient; ANSI terminal output is not a primary event protocol.
- If AGY remains sticky/global without a per-invocation override, expose a preflight/onboarding warning instead of pretending per-cat model routing is deterministic.

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “Gemini CLI 要落日了，直接换 Antigravity CLI？” | AC-A1, AC-E1 | official source + E2E smoke | [x] |
| R2 | “改成符合现在事实的版本” | AC-A1, AC-F1 | source-linked spec + review | [x] |
| R3 | “Bengal可以 review 你的版本” | AC-F2 | cross-cat review note | [x] |
| R4 | 现有 `antigravity` adapter 名称会和新 CLI 混淆 | AC-B1, AC-B2 | adapter unit tests | [x] |
| R5 | 不要把企业例外/旧 fallback 写没 | AC-E2, AC-E4 | fallback tests + docs | [x] |
| R6 | “antigravity-cli 至少要接入 Opus / Gemini 3.1 Pro / 3.5 Flash” | AC-G1, AC-G2, AC-G3 | official model docs + local AGY settings/probe + E2E smoke per profile | [ ] |
| R7 | “AGY 也得开 yolo；隔离不同猫要验证 HOME/AGY config sandbox，并给 worktree 权限” | AC-G4, AC-G5 | profile-sandbox smoke with `--dangerously-skip-permissions`, isolated settings/MCP/trusted workspace, and worktree access probe | [x] |
| R8 | “像 F198 拯救Ragdoll那样接入 AGY 互动式 CLI？” | AC-G6 | local language-server API probe + PTY fallback smoke + carrier decision packet | [x] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用；本 feature 无前端 UI）

## Acceptance Criteria

### Phase A（Official CLI Recon）

- [x] AC-A1: Spec/recon note cites Google official transition timeline and enterprise exception.
- [x] AC-A2: Recon records exact `agy` install, headless command, subprocess-friendly output mode if any, resume, model, and cwd/include-dir behavior.
- [ ] AC-A3: Raw Antigravity CLI fixtures exist for success text, tool use, result/error, and interrupted run.
- [x] AC-A4: Recon records `agy` auth model, headless non-interactive auth feasibility, and whether it shares credentials with Antigravity Desktop.
- [ ] AC-A5: Recon records `agy` MCP config loading behavior and whether it supports `--no-mcp` / `--mcp-config` or equivalent conflict controls.
- [x] AC-A6: Recon records `agy` sandbox/permission model and whether it has an auto-approve flag equivalent to Gemini CLI `-y`.

Phase A recon source: `docs/features/assets/F210/phase-a-recon-2026-05-22.md`.

AC-A3 remains open only for the remaining provider-error and manual in-flight interruption fixtures. The follow-up headless spike captured successful text, tool-use, resume, timeout, auth-required/OAuth, keyring auth + missing-model, unsupported flags, and auth interruption fixtures. `agy --print` can now complete on this machine after silent keyring auth fetches an account-side selected model override, but AGY CLI 1.0.1 still exposes no top-level `--model` flag.

AC-A5 remains open because successful `agy --print` now shows runtime MCP schema materialization under `~/.gemini/antigravity-cli/mcp`, but config precedence, settings-level disable/override controls, and Cat Cafe callbackEnv compatibility are not fully verified. Launch-time `--no-mcp` / `--mcp-config` flags remain absent in 1.0.1.

### Phase B（Adapter Contract）

- [x] AC-B1: `GeminiAdapter` supports `antigravity-cli` distinctly from Desktop callback.
- [x] AC-B2: Existing `GEMINI_ADAPTER=antigravity` behavior is preserved via alias or migration warning, not silently repointed to `agy`.
- [x] AC-B3: Missing CLI error for `antigravity-cli` names the official install route and `agy` binary.

Phase B adapter prototype source: `packages/api/src/domains/cats/services/agents/providers/GeminiAgentService.ts`.

The prototype intentionally maps `antigravity-cli` to the standalone `agy` binary while keeping legacy `antigravity` on the Desktop/MCP callback path. `agy --print` stdout is treated as plain final text via the shared CLI spawn layer's `plainText` mode so tmux `spawnCliOverride` / observability remains available. As of the 2026-05-31 AGY 1.0.3 refresh, fresh AGY turns must not pass a made-up `--conversation` id: AGY ignores unknown IDs and creates its own UUID. Cat Cafe now passes an internal `--log-file`, extracts the AGY-created conversation UUID from print-mode logs, emits that real id in `session_init`, and uses `--conversation <real-id>` only on subsequent resumes. Stdout timeout and missing-model strings are classified as first-class errors because AGY can emit those on stdout and still exit 0.

### Phase C（Parser / Session Migration）

- [x] AC-C1: Parser tests cover actual Antigravity CLI event fixtures; no unverified Gemini fixture reuse.
- [x] AC-C2: Session metadata and final `done` semantics match existing Cat Cafe `AgentMessage` invariants.
- [x] AC-C3: Unsupported resume/model/image features have explicit degradation behavior and tests.

Phase C parser/session source: `packages/api/src/domains/cats/services/agents/providers/antigravity-cli-event-parser.ts`, with fixture-backed tests in `packages/api/test/antigravity-cli-event-parser.test.js` and service boundary tests in `packages/api/test/gemini-agent-service.test.js`.

`agy --conversation <id>` is the supported stable session path for an already-created AGY conversation UUID. Because F210 resume fixtures showed print-mode stdout can replay previous assistant text plus the new answer, resumed AGY text is emitted with `textMode: replace` rather than treated as a streaming delta. AGY 1.0.3 also proved that an unknown `--conversation` id is not a create-or-resume handle: AGY prints `conversation "<id>" not found`, ignores the flag, and creates a different UUID. The adapter therefore records the log-observed UUID on fresh turns, and classifies resumed conversation-not-found warnings as `missing_session` so Cat Cafe's session self-heal can drop the stale id. AGY per-call model override remains unsupported: adapter metadata marks the model unverified/account-selected, and a requested Cat Cafe model override produces `system_info` diagnostics instead of silently pretending `--model` was applied. Image inputs degrade to local path hints plus `--add-dir` access; no native image flag is invented.

### Phase D（Install / Packaging）

- [x] AC-D1: macOS/Linux installer scripts install or instruct `agy` via official bootstrapper, not `@google/gemini-cli`.
- [x] AC-D2: Windows installer/build scripts have a verified native `agy` path or explicit unsupported message.
- [x] AC-D3: Offline desktop packaging handles native binary distribution intentionally.

Phase D install/packaging source: `scripts/install.sh`, `scripts/install.ps1`, `scripts/windows-command-helpers.ps1`, `desktop/scripts/build-mac.sh`, `desktop/scripts/build-desktop.ps1`, `desktop/scripts/post-install-offline.ps1`, `desktop/installer/cat-cafe.iss`, and `desktop/scripts/generate-desktop-config.ps1`.

Cat Cafe installers now provision `agy` through Google's native bootstrapper (`https://antigravity.google/cli/install.sh` / `.cmd`) and resolve the Windows native binary at `%LOCALAPPDATA%\agy\bin\agy.exe`. Desktop offline packages intentionally ship `agy-install-instructions.txt` instead of pretending the old `@google/gemini-cli` npm package is a vendorable Antigravity CLI replacement.

### Phase E（Tests / E2E）

- [x] AC-E1: `GEMINI_ADAPTER=antigravity-cli` can invoke Siamese end-to-end from Cat Cafe.
- [x] AC-E2: `GEMINI_ADAPTER=gemini-cli` remains explicitly testable as fallback.
- [x] AC-E3: Existing wiring tests no longer assume `gemini-cli` is the only headless Google carrier.
- [x] AC-E4: Default adapter changes only after AC-E1 is green.

Phase E E2E source: `docs/features/assets/F210/phase-e-e2e-smoke-2026-05-23.md`.

The live smoke routed the non-ACP `GeminiAgentService({ catId: "gemini" })` path with `GEMINI_ADAPTER=antigravity-cli`, process-local `PATH=/tmp/cat-cafe-f210-agy-bin:$PATH`, `agy 1.0.1`, and real HOME keyring auth. It returned a normal final reply containing `CAT_CAFE_AGY_E2E_OK` in about 14.3s, with `session_init` metadata `modelVerified: false` and no leaked fresh-conversation warning after the parser regression fix.

AC-E4 is closed in Phase F for the non-ACP `GeminiAgentService` path: after AC-E1 live smoke passed, the service default adapter changed to `antigravity-cli`. Catalog ACP routes remain `GeminiAcpAdapter` unless their `acp` section is removed or AGY gains a compatible ACP mode. `GEMINI_ADAPTER=gemini-cli` remains an explicit fallback and is still covered by wiring/service tests.

### Phase F（Docs / Truth Sync）

- [x] AC-F1: README/env/architecture docs explain consumer deadline, enterprise exception, and Antigravity CLI default.
- [x] AC-F2: Review request to `@antig-opus` includes the fact corrections from this spec.
- [x] AC-F3: `docs/features/index.json` and `docs/ROADMAP.md` are in sync with F210.

The non-ACP `GeminiAgentService` default route is now `antigravity-cli` when neither constructor options nor `GEMINI_ADAPTER` override it. The runtime catalog still checks `acp` first, so existing Siamese ACP entries remain on `gemini --acp`. The explicit fallback remains `GEMINI_ADAPTER=gemini-cli`, preserving enterprise/API-key access and the old NDJSON parser path. The legacy `GEMINI_ADAPTER=antigravity` value still means Desktop/MCP callback and is not silently repointed to `agy`.

### Phase G（AGY Multi-Model Profiles）

- [x] AC-G1: Spec/recon records official Antigravity reasoning model availability and the exact AGY model-selection storage surface.
- [ ] AC-G2: Cat Cafe can select or verify at least Claude Opus 4.6 (thinking), Gemini 3.1 Pro, and Gemini 3.5 Flash without cross-cat sticky-state bleed.
- [x] AC-G3: Runtime preflight reports a clear actionable warning when AGY is missing, no default model is selected, or requested profile selection cannot be verified.
- [x] AC-G4: Cat Cafe AGY invocations run with an explicit auto-approval policy (`--dangerously-skip-permissions`) only inside an isolated AGY profile sandbox; no unattended runtime path may depend on interactive permission prompts.
- [x] AC-G5: Profile-sandbox smoke proves each AGY profile can access its assigned worktree and MCP config while keeping `~/.gemini/antigravity-cli/settings.json` / `trustedWorkspaces` / permissions isolated from other profiles.
- [x] AC-G6: Interactive-carrier spike proves the preferred structured control plane, or explicitly rejects it and documents the PTY/tmux fallback boundaries before any user-facing AGY interactive bridge ships.

Phase G starts from the current constraint: `GeminiAgentService.invokeAntigravityCLI()` intentionally reports `model: account-selected (antigravity-cli)` and emits `antigravity_cli_model_override_unsupported` when a Cat Cafe model override is requested. This is correct until a stable model id/config contract is proven. The immediate runtime update after PR #1863 only switches the non-ACP Google service default to AGY; it does not move catalog ACP cats off `gemini --acp`, and it does not mean Opus/Gemini profile routing is deterministic.

Phase G ACP probe source: `docs/features/assets/F210/phase-g-acp-probe-2026-05-23.md`. Current result: `agy 1.0.1` is globally installed and `agy --print` works, but AGY does not expose a supported/documented ACP server mode. Gemini CLI `0.42.0` still exposes `--acp`, `--model`, and `stream-json`; AGY exposes interactive `/model` plus persistent `~/.gemini/antigravity-cli/settings.json` model selection instead. Do not route AGY through `GeminiAcpAdapter` unless a future AGY release adds a compatible ACP surface.

Phase G interactive/API probe source: `docs/features/assets/F210/phase-g-interactive-api-probe-2026-05-23.md`. Current result: AGY interactive mode can be driven from a PTY, but the stronger F198-like lead is AGY's local language-server HTTP/Connect API. Read-only endpoints expose conversation metadata, model catalog/config, and MCP server state. Message send/update-stream/model-selection semantics remain unproven, so this is a spike lead rather than a runtime carrier yet.

Phase G interactive carrier decision source: `docs/features/assets/F210/phase-g-interactive-carrier-decision-2026-06-01.md`. Current result: AGY 1.0.3's local language-server API is rejected as the production interactive carrier for now. The API can observe state through read endpoints and `StreamAgentStateUpdates` when called with Connect JSON framing, but `SendUserCascadeMessage` could only create user steps and then failed model execution under the tried schemas; API-level model selection and cancellation are not proven as a complete lifecycle. Cat Cafe keeps `agy --print` with isolated profile sandboxes as the production unattended path, and PTY/tmux is documented as manual takeover/observation only. This closes AC-G6 without closing AC-G2.

Phase G AGY 1.0.3 refresh source: `docs/features/assets/F210/phase-g-agy-1.0.3-capability-refresh-2026-05-31.md` (PR #1996). Current result: `--conversation` / `--continue` / `--dangerously-skip-permissions` / `plugin` are now visible in top-level help, but there is still no documented `--model` or ACP subcommand. Official docs put persistent CLI preferences at `~/.gemini/antigravity-cli/settings.json` and document command-line overrides for some settings; model selection remains interactive/sticky rather than proven per-call. A temporary-HOME smoke reached OAuth onboarding and printed the auth prompt to stdout with exit 0, so the AGY parser now classifies auth-required stdout as an actionable provider error before profile-sandbox work proceeds.

Phase G must treat approval policy and model isolation as the same design surface: `--dangerously-skip-permissions` is required for unattended Cat Cafe operation, but it is only acceptable after the invocation is confined to a per-cat AGY profile sandbox with explicit worktree/MCP access. A shared global HOME with a shared `settings.json` would couple model choice, workspace trust, and permission posture across cats, so it is not a valid multi-profile architecture.

Phase G implementation direction under the current AGY 1.0.3 limits:

- Do not build a fake per-call model selector. AGY now has `--conversation`, `--continue`, `--dangerously-skip-permissions`, and `plugin`, but it still has no documented `--model` flag or ACP surface. Cat Cafe resume should continue using stored AGY-created UUIDs via `--conversation`; `--continue` is not deterministic enough for Cat Cafe thread/session routing.
- Make per-cat AGY profile sandboxing the terminal architecture. Each logical AGY cat needs its own HOME / `~/.gemini/antigravity-cli/settings.json`, trusted-workspace state, MCP config materialization, log directory, worktree allowlist, and approval posture. The runtime may verify the selected model for a profile, but it must not silently mutate shared global AGY state to satisfy routing.
- Prefer one cohesive implementation PR for the next Phase G runtime slice if the change surface stays inside AGY profile config, preflight, invocation env/args, and tests. Split only if the work expands into a separate UI/onboarding surface or a structured local-API carrier spike. The next slice should produce a profile sandbox + preflight + smoke path: it can run isolated AGY when the profile is ready, or fail closed with actionable diagnostics when auth/model/trust/MCP requirements are missing.
- Gate `--dangerously-skip-permissions` behind sandbox proof. It should be injected only for verified isolated profiles, never for the user's shared HOME. The smoke must prove assigned worktree access and MCP config visibility before unattended yolo operation is considered valid.
- Treat model routing as verification-first. Until AGY exposes a supported setter, Cat Cafe should expose Opus/Gemini profile cats only when it can verify the profile's selected model/status matches the intended cat identity; otherwise it should report a preflight/onboarding warning instead of inheriting another profile's sticky selection.

Phase G profile-sandbox runtime slice merged via PR #2004. Cat Cafe now has an `agyProfile` catalog surface, `resolveAgyProfile()` / `preflightAgyProfile()` profile manager, and service wiring that runs profiled AGY invocations with isolated `HOME`, profile-local `~/.gemini/antigravity-cli/settings.json`, explicit `trustedWorkspaces`, and runtime-owned `--dangerously-skip-permissions` only after sandbox proof. The implementation refuses the real user HOME, rejects profile path escapes and symlinked profile components before writing settings, strips user-provided yolo flags from `cliConfigArgs`, fails closed on missing binary/settings/model/trust verification, and blocks fresh conversation recording when the observed AGY statusline model is missing or mismatched. This closed AC-G3/G4/G5 for the runtime profile-sandbox layer, but did not close AC-G1/G2 at merge time because exact production selector labels for Opus / Gemini 3.1 Pro / Gemini 3.5 Flash and user-facing profile exposure still needed separate verification.

Phase G model-selector recon source: `docs/features/assets/F210/phase-g-agy-model-selector-recon-2026-05-31.md`. Current result: official Antigravity model docs and local AGY `1.0.3` language-server probes agree on the target selector labels: `Claude Opus 4.6 (Thinking)`, `Gemini 3.1 Pro (High)` / `Gemini 3.1 Pro (Low)`, and `Gemini 3.5 Flash (High)`. The exact storage surface Cat Cafe can write is `~/.gemini/antigravity-cli/settings.json` key `model`, using the human selector/status label; the runtime then verifies the actual selected model from AGY logs (`Propagating selected model override to backend: label="..."`). `GetAvailableModels` still exposes duplicate Gemini 3.1 Pro High placeholder ids, so raw placeholder ids are recon evidence only, not a production setter. This closes AC-G1. AC-G2 remains open until live, independently onboarded AGY profile E2E smokes prove Opus / Gemini 3.1 Pro / Gemini 3.5 Flash can run as user-facing Cat Cafe profile cats without sticky-state bleed.

Phase G AGY profile E2E smoke runner source: `docs/features/assets/F210/phase-g-agy-profile-e2e-smoke-runner-2026-05-31.md`. Current result: `pnpm f210:agy-profile-smoke` now dry-runs the AC-G2 target contract, and `pnpm f210:agy-profile-smoke -- --run-live --home-root ~/.cat-cafe/agy-profiles --working-directory "$PWD"` invokes the production `GeminiAgentService` + `agyProfile` path for `Claude Opus 4.6 (Thinking)`, `Gemini 3.1 Pro (High)`, and `Gemini 3.5 Flash (High)`. Each target requires a unique marker response, `modelVerified: true`, and an exact post-run AGY log label match. This does not close AC-G2 yet: profile OAuth/onboarding remains external, and the live `--run-live` report must pass for all target profiles before user-facing routing can be exposed.

## Dependencies

- **Evolved from**: F053（Gemini session resume behavior must be revalidated under `agy`）
- **Related**: F061（Antigravity Desktop is a different surface; naming must not collide）
- **Related**: F118（CLI liveness/watchdog behavior must carry over）
- **Related**: F149 / F161（If Antigravity CLI exposes ACP instead of NDJSON, reuse ACP runtime policy rather than inventing a fourth carrier model）
- **Related**: F179（Desktop installer/offline packaging implications）
- **Related**: F197（Tool result surfacing contracts if the new CLI uses ACP-like tool events）
- **Related**: F201（Desktop reliability remains separate; shared lessons apply to recovery/liveness only）

## Risk

| 风险 | 缓解 |
|------|------|
| `agy` supports only plain final-text stdout, not a subprocess event stream | Prototype with a dedicated plain-text parser; keep resume/tool/timeout fixtures as parser tests and pivot to MCP/ACP only if tool/result fidelity proves insufficient |
| Antigravity CLI does not expose NDJSON stream-json | Phase A fixture first; choose new parser or ACP mapping before code migration |
| `agy --print` can authenticate but fail before execution when no account-side default model is selected | Implement a preflight/onboarding error before default switch; do not assume Cat Cafe can choose model from env until a setting or CLI flag is verified |
| Native `agy` install cannot be vendored cleanly for offline desktop builds | Keep installer decision explicit in Phase D; do not fake npm package availability |
| Consumer deadline overgeneralized into “Gemini CLI is dead for everyone” | Preserve enterprise/API-key fallback and document exact scope |
| Adapter name collision causes Desktop callback path to break | Add `antigravity-cli` as new name and alias old Desktop behavior deliberately |
| Default switch before E2E green breaks Siamese | AC-E4 blocks default flip until live smoke passes |
| `agy --conversation` stdout may include prior assistant output | Treat resume parsing as separate from new-conversation parsing; do not assume stdout is response delta-only |
| `agy --print-timeout` can emit timeout on stdout and exit 0 | Classify timeout/error text or logs explicitly; exit code alone is not a success signal |
| `agy --print` may load user/global MCP servers that compete with Cat Cafe-injected MCP servers | Phase B must choose an MCP isolation policy before enabling tool use: disable/override if AGY exposes a supported control, or run with a documented compatibility matrix for shared servers |
| AGY model selection is sticky/global rather than per invocation | PR #2004 confines profiled AGY invocations to per-cat HOME/settings and fails closed when selected-model verification is missing or mismatched; exact Opus/Gemini selector labels remain before user-facing exposure |
| Treating AGY `/model` as equivalent to Gemini ACP `unstable_setSessionModel` would create false per-cat isolation | Phase G ACP probe confirms AGY 1.0.1 has no supported ACP server mode; only use ACP semantics after AGY exposes a compatible server surface |
| AGY interactive permission prompts block unattended Cat Cafe turns and train users to approve unread scripts | PR #2004 injects `--dangerously-skip-permissions` only for runtime-owned sandbox profiles and strips user-provided yolo flags from unprofiled `cliConfigArgs` |
| Isolating HOME/AGY config may accidentally remove trusted workspace or MCP access | PR #2004 writes profile-local settings with the assigned worktree in `trustedWorkspaces` and fails preflight when that trust proof is absent; real AGY auth/onboarding can still fail closed via auth-required diagnostics |
| AGY local language-server API is undocumented and may change | AC-G6 rejects it as a production carrier in AGY 1.0.3; future work needs a version-guarded proof of API-created send, structured stream, cancel, and selected-model verification before runtime use |
| PTY/tmux interactive wrapping loses structured events | Use PTY only for observation/manual takeover; ANSI screen parsing must not silently replace AgentMessage/tool event semantics |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F210 is a new feature, not a F201 bug reopen | F201 covered Desktop reliability; F210 is a headless carrier deadline and packaging migration | 2026-05-22 |
| KD-2 | Do not assert full Gemini CLI shutdown | Google's official post keeps enterprise/API-key access separate from consumer shutdown | 2026-05-22 |
| KD-3 | New adapter name is `antigravity-cli` | Existing `antigravity` means Desktop/MCP callback in current code | 2026-05-22 |
| KD-4 | Keep `gemini-cli` fallback until enterprise path is settled | Enterprise users may still rely on Gemini CLI; deleting it would remove a valid route | 2026-05-22 |
| KD-5 | F209 is occupied by Evidence Recall Optimization; this migration uses F210 | Feature IDs are shared truth and must be assigned from current main, not from a worktree snapshot | 2026-05-22 |
| KD-6 | `agy` subprocess output support is a blocking Phase A question | Antigravity Desktop harness differs materially from Gemini CLI stream-json; implementation strategy depends on this answer | 2026-05-22 |
| KD-7 | Phase B prototype may start only with explicit model preflight/onboarding and timeout classification | `agy --print` can now succeed, but model selection is account-side rather than CLI/env controlled, and timeouts can exit 0 | 2026-05-22 |
| KD-8 | Runtime may update after Phase F, but AGY multi-model profiles remain Phase G | PR #1863 safely switches the default carrier; Opus/Gemini 3.1 Pro/Gemini 3.5 Flash require model-selection verification before user-facing routing | 2026-05-23 |
| KD-9 | Prefer AGY ACP only if AGY ships a compatible server mode | Gemini CLI ACP has the lifecycle Cat Cafe wants, but AGY 1.0.1 does not expose that surface; swapping `command: "agy"` into the ACP pool would be a false integration | 2026-05-23 |
| KD-10 | ACP catalog precedence is a separate routing layer from `GEMINI_ADAPTER` | `index.ts` instantiates `GeminiAcpAdapter` before falling back to `GeminiAgentService`; adapter defaults do not affect existing ACP cats | 2026-05-23 |
| KD-11 | AGY yolo is required but must be sandbox-scoped | Interactive approval prompts are unusable for Cat Cafe agent turns; auto-approval is acceptable only when HOME/config, worktree, MCP, and model profile isolation are proven | 2026-05-23 |
| KD-12 | For an F198-like AGY carrier, structured local API beats PTY | AGY exposes a localhost HTTP/Connect language-server API with conversation/model/MCP read paths; PTY works but is an ANSI UI fallback, not a durable event protocol | 2026-05-23 |
| KD-13 | Profiled AGY runs must be verification-first and fail closed | AGY still lacks a documented per-call model selector; Cat Cafe can only run unattended profile cats when isolated settings/trust/model status are verified and wrong/missing model runs cannot record resumable sessions | 2026-05-31 |
| KD-14 | Do not ship AGY local language-server API as the production interactive carrier in 1.0.3 | The API can observe state but a complete API-created send/stream/cancel/model-select lifecycle is not proven; `agy --print` profile sandboxes remain the production path, and PTY/tmux is manual takeover only | 2026-06-01 |

## Open Spike: Streamable Trajectory（2026-06-01, Ragdoll/Opus-4.8）

延续 Phase C 的 resume-replay 认知（`textMode: replace` 只压住单条回复内重放，多轮 resume 仍**累加历史**）+ Phase G 的 local-API 线，但换了角度和数据源：**只读观测面 + 本地 SQLite**，区别于 KD-14 拒绝的 local-API **写控制面**（send/model/cancel）。动机有二：(a) runtime Siamese多轮 resume 实测累加重放（A=[1]→B=[1,2]→C=[1,2,3]，三篇论文真翻译但重复段是历史文本回放）；(b) `agy --print` 阻塞执行使长任务全程黑盒，需 streamable。

[实测 2026-06-01] 真跑 agy 确认：agy 每次起**临时 LS 子进程**（独立 `appDataDir=~/.gemini/antigravity-cli`，跑完即关，**非** IDE 常驻 LS），把 cascade trajectory **逐 step 写入本地 SQLite** `<appDataDir>/conversations/<uuid>.db` 的 `steps` 表（`idx` 递增 + `step_type`/`status` 明文 integer + `step_payload`/`render_info` proto blob）。poll 该表 `WHERE idx > :cursor ORDER BY idx` 即可做 **step 级 streamable**，并按 `idx` 游标取增量，**顺带根治多轮 resume 重放**（输出来源从全量 stdout 改为 trajectory 增量）。

- 完整 spike（命门 / 三次路径修正 / steps 表实证 / L1-L2 方案 / 8 个开放问题）：`docs/features/assets/F210/streamable-trajectory-spike-2026-06-01.md`
- 落地分层：**L1** 明文 `idx/step_type/status` → 进度流（无需解码，立即可用）；**L2** 解 `step_payload` proto（逆向 schema 或 `ConvertTrajectoryToMarkdown` RPC）→ tool call 名/参数/内容
- 与 F211 关系：同思维（trajectory 增量）不同数据源——F211 Bengal走「连 LS」（REG9 status-poll / REG10 push），本 spike 走「读 SQLite」；F211 实测的 read-RPC delta 字段静默忽略坑被 SQLite `idx` 游标绕开
### Owner 讨论结论（Maine Coon/GPT-5.5, 2026-06-01）

Maine Coon（F210 owner）拍板：**SQLite 直读可扛，挂新 Phase H，不并回 Phase G**。关键纠正 + 拆分：

- **数据源**：选 SQLite 直读（本地 / 无鉴权 / `idx` 天然游标 / 可 TDD）；临时 LS RPC 仅作 L2 fallback；log tail 仅用于发现 `cascadeId`。
- **关键纠正（解耦）**：L1 进度 ≠ 根治重放。**H1 只加 progress side-channel，最终回复仍走 stdout**，不在 H1 承诺"废 stdout"；根治重放归 **H2**（届时把最终输出源从 stdout 切到 trajectory 文本，重放自然消失）。
- **fail-open 硬约束**：SQLite 读做能力探测（db / `steps` 表 / `idx`·`step_type`·`status` 列存在），不满足就**禁用 progress、保留现有 stdout 行为**；只读连接 + `busy_timeout` + `idx > cursor` poll + 进程退出后 final poll 一次。
- **UI 文案**：H1 不硬标 step_type（8/9/14/15/23/98），未知显示中性"AGY trajectory step #N running/completed"，枚举坐实后（H3）再加语义标签。

**Phase H 拆分**：
- **H1** ✅ **merged（PR #2044, squash `0fa2f27f0`, 2026-06-02）**：`AgyTrajectoryObserver`（SQLite 增量 poll，retry/incompatible 三态 fail-open）+ `resolveAgyTrajectoryDbPath` + `observeAgyProgress`（依赖注入可测 generator）+ 接入 `invokeAntigravityCLI`（agyConsumeTask 后台消费 + 并发 merge loop，liveness/progress 实时 side-channel）。实时写假设已 spike 坐实（steps 1→10 横跨 25s）。Maine Coon跨族 review（2 本地 P1：startup race + liveness real-time；2 云端 P1/P2：consumer rejection + nonblocking poll，全修）+ 云端 codex 0 major。68 测试全绿。
  - **H1-hotfix** ✅ **merged（PR #2047, squash `b30da6f9e2`, 2026-06-02）**：H1 后端 emit per-step `agy_trajectory_progress` side-channel，但前端两 render path（`handleAgentMessage` 主路径 + `consumeBackgroundSystemInfo` 后台）都没识别 → fallback 渲染原始 JSON 成 system bubble，N-step 任务刷 N 个 bubble。修：两 path 各加 `agy_trajectory_progress → consumed=true` 静默消费（仿 timeout_diagnostics）。red→green（含 active path 复现）+ liveness 零回归 + gate PASS。gpt52 跨族 review 0 P1 + 云端 codex 0 major。**alpha 验收 gap 教训**：H1 单测+review 全绿但前端集成无人 review、无 runtime alpha 验收，merge 后operator重启 production 才暴露刷屏。**遗留 non-blocking 测试缺口**（gpt52 标）：新 agy 红测只覆盖 active path，background path 靠 code inspection + 类比 timeout suppression 既有覆盖 → **H2 补 background path 专门红测**。
- **H2**（Maine Coon拍 H2a/H2b 拆分，2026-06-02）：trajectory 内容提取，替换 resumed stdout final text；红测复现 `[1]→[1,2]→[1,2,3]` 只输出本轮（根治重放）。proto 解码首选逆向 schema，备选趁临时 LS 活着调 `ConvertTrajectoryToMarkdown`（fallback，生命周期不可靠）。
  - **H2a-locator** ✅ **merged（PR #2048, squash `7154e0c538`, 2026-06-02）**：抽 `AgyTrajectoryLocator`（fresh log 走原 resolver；resume 空 log 扫 `conversations/*.db` 只接受 invocationStart 后新建单候选；0/多/无 appDataDir → fail-open 不猜）+ `listAgyConversationDbs` fs 扫描 + `resolveAgyAppDataDir`（effective child HOME）+ observeAgyProgress/GeminiAgentService 接入。**修 B spike confirmed 的 H1 resume progress P2 gap**（agy resume 不写 log + 另起新 cascade db → 旧 observer resume turn 零 progress）。Maine Coon APPROVE + Re-confirm + 云端 codex 0 major（云端抓真 P2：appDataDir 派生漏 accountEnv.HOME，已修）。locator 单元 5 + resume scan + fs 2 red→green + 真数据 dogfood，全 78/78 + gate 绿。**carryover 到 H2b/extractor**：invocationStartMs missing-watermark guard + trajectory_meta 多候选消歧 + H1 background path 专门红测。
  - **H2b/extractor** ✅ **merged（PR #2056, squash `ad49f9c87c`, 2026-06-02）**：手写 minimal proto wire-format parser（不引 protobufjs）解 step_payload 顶层 field 20→1 (final)/8 (fallback)，排除 3 (thinking)；`readAgyTrajectorySteps`（只读 SQLite）+ `extractAgyFinalTextFromSteps`（取最后 final）+ `classifyAntigravityCliPlainText` resumed 替换 + `GeminiAgentService` 接入（resumed turn locator→db read→extractor→替换 stdout 重放）。**根治 resume 累加重放**（`[1]→[1,2]→[1,2,3]` 只输出本轮）。全 fail-open（varint/size bounds + 无 db/无 final/解析失败 → 保留 stdout）。carryover 收齐（invocationStartMs guard + trajectory_meta 保守 fail-open）。Maine Coon APPROVE + Re-confirm（真实 AGY DB dogfood 216/598/1814/1957 chars final 正确抽）+ 云端 codex 抓 2 真 P2 全修（accountEnv.HOME / empty stdout 丢 final）。95/95 + gate 绿。**遗留**：无 live resume golden fixture（AGY resume §8.5 上游串台 bug），真实 resume 替换待 alpha/dogfood。
  - **H2b 遗留 AGY 上游 bug（§8.5）**：live resume 时 agy 把任务当 agent 任务跑（thinking 串台，输出诡异），不是干净累加重放。extractor 逻辑已验证正确（fresh fixture + 真实 DB dogfood），但端到端真实 resume 替换需 AGY resume 行为正常时才能验。
- **H3** ✅ **merged（PR #2063, squash `aa941f6cd4`, 2026-06-02）**：step_type 粗标签（15=assistant activity / 14·98=lifecycle / 23=metadata / 9=operation activity 不硬标 tool call / unknown=neutral）+ 折叠单行 agy 进度 UI（`formatAgyProgressDetail` "AGY working · N steps · latest" → thread 级 catStatusDetails → ThinkingIndicator chat 区单行 + ThreadCatStatus tooltip，复用现有不加新组件，不刷 bubble，done/cancel workingCats 过滤自动折叠）。Maine Coon APPROVE + 云端 codex 0 major。后端 22 + 前端 20 测 + gate 绿。**遗留**：live AGY browser dogfood 待 alpha 验真实 UI；cache leak（gemini/gemini25 未配 agyProfile → repo root 泄漏 cache/projects.json）= F210 P2 follow-up（bug report 已 commit）。
- **H4** ✅ **merged（PR #2097, squash `ddba3696e`, 2026-06-04）**：**AGY trajectory tool-call 渲染 + 卡片对齐**。从 SQLite `step_payload` 中通过 Protobuf 解码提取出工具名、工具 CallId 和参数，并在进程结束前实时 yield 为 `tool_use`/`tool_result`，对齐 Claude/Codex 的大猫卡片及工具列表折叠渲染。因二次裁判 review 指出的 P1（observer cursor 原地更新丢失）、P2（YAML frontmatter / any 移除 / Biome format 尾巴）等已通过 follow-up PR #2099 全部修复，并通过全量本地门禁测试（GATE PASSED，commit SHA: `e927d377`）。
- **H5** ✅ **merged（PR #2141, squash `3dc59a0e`, 2026-06-08 UTC）**：**resume trajectory progress/tool-call 展示改为 per-invocation 增量**。用户实测第 N 次唤醒时 UI 显示 1..N 次累计 steps/tool calls；修复以 pre-spawn resume DB baseline 为 observer 初始 cursor，只读 `idx > baseline` 的新 step，同时用 bounded prefix fingerprint / retry / fail-open 证明同路径 DB continuity，避免 AGY 重建/截断同名 DB 时误套 stale baseline。最终回复语义仍走既有 stdout/trajectory final 路径；本 PR 只修 progress/tool side-channel 的增量边界。云端多轮 P2（DB 重建、identity 不可靠、全历史 hash 等）均已修复，observer/Gemini service targeted tests + full `pnpm gate` green。

**关键 AC**：progress side-channel 不得影响现有最终答复语义；SQLite 任何失败必须降级回当前 stdout 路径。

> 下一步：Phase H 已进入 hardening / runtime dogfood 阶段；后续只新增可复现 bug fix 或 live smoke 证据，不再把旧 stdout 累加显示问题当作未拆分的 Phase 入口。

## Review Gate

- Kickoff review: `@antig-opus` reviews this spec for Antigravity product facts and missing recon points.
- Implementation review: cross-family reviewer required before PR merge. Same individual cannot review their own code.
