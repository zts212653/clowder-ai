---
feature_ids: [F210]
related_features: [F053, F061, F118, F149, F161, F179, F197, F201]
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

Cat Cafe currently invokes Siamese through `GeminiAgentService` with `GEMINI_ADAPTER=gemini-cli`, spawning the local `gemini` binary with `-p ... -o stream-json -y`. If we leave that as the default carrier, consumer users hit a hard service deadline in less than one month. This is not an Antigravity Desktop reliability bug: F201 closed the Desktop/MCP callback reliability contract; F210 is the headless Google CLI carrier migration.

## Current Fact Baseline

| Fact | Evidence | Consequence |
|------|----------|-------------|
| Antigravity CLI is available now and shares Antigravity 2.0's agent harness | Google Developers Blog, 2026-05-19 | Treat it as the intended successor carrier, not a speculative alternative |
| Gemini CLI consumer requests stop on 2026-06-18, but enterprise/API key access remains | Google Developers Blog, 2026-05-19 | Keep `gemini-cli` as an explicit fallback/enterprise adapter until the contract is settled |
| Antigravity CLI install is a native binary bootstrapper, not an npm package | `https://antigravity.google/cli/install.sh`, fetched 2026-05-22 | Existing npm packaging/offline install scripts need a different path |
| The installed binary name is `agy` | Official installer script sets `BINARY_PATH="$TARGET_DIR/agy"` | Do not write migration code assuming `antigravity` or `@google/antigravity-cli` |
| `antigravity` and `agy` are different binary surfaces | Current Desktop adapter spawns `antigravity chat --mode agent`; official CLI installer writes `agy` | Treat `antigravity` as Desktop app CLI entry and `agy` as the standalone Antigravity CLI carrier |
| Local machine currently has Gemini CLI `0.38.2`; `agy` is not installed | `gemini --version`; `command -v agy` | Phase A must install/probe before code migration |
| Existing Cat Cafe `antigravity` adapter is Desktop/MCP callback, not Antigravity CLI | `GeminiAgentService.invokeAntigravity()` spawns `antigravity chat --mode agent` detached and requires `callbackEnv` | Add a distinct `antigravity-cli` adapter; avoid reusing the ambiguous old name |

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

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “Gemini CLI 要落日了，直接换 Antigravity CLI？” | AC-A1, AC-E1 | official source + E2E smoke | [ ] |
| R2 | “改成符合现在事实的版本” | AC-A1, AC-F1 | source-linked spec + review | [ ] |
| R3 | “孟加拉猫可以 review 你的版本” | AC-F2 | cross-cat review note | [ ] |
| R4 | 现有 `antigravity` adapter 名称会和新 CLI 混淆 | AC-B1, AC-B2 | adapter unit tests | [ ] |
| R5 | 不要把企业例外/旧 fallback 写没 | AC-E2, AC-E4 | fallback tests + docs | [ ] |

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

The prototype intentionally maps `antigravity-cli` to the standalone `agy` binary while keeping legacy `antigravity` on the Desktop/MCP callback path. `agy --print` stdout is treated as plain final text via the shared CLI spawn layer's `plainText` mode so tmux `spawnCliOverride` / observability remains available. New AGY turns generate an `agy-*` conversation id, emit `session_init`, and pass the same id to `--conversation`; stdout timeout and missing-model strings are classified as first-class errors because AGY 1.0.1 can emit those on stdout and still exit 0.

### Phase C（Parser / Session Migration）

- [x] AC-C1: Parser tests cover actual Antigravity CLI event fixtures; no unverified Gemini fixture reuse.
- [x] AC-C2: Session metadata and final `done` semantics match existing Cat Cafe `AgentMessage` invariants.
- [x] AC-C3: Unsupported resume/model/image features have explicit degradation behavior and tests.

Phase C parser/session source: `packages/api/src/domains/cats/services/agents/providers/antigravity-cli-event-parser.ts`, with fixture-backed tests in `packages/api/test/antigravity-cli-event-parser.test.js` and service boundary tests in `packages/api/test/gemini-agent-service.test.js`.

`agy --conversation <id>` is the supported stable session path. Because F210 resume fixtures showed print-mode stdout can replay previous assistant text plus the new answer, resumed AGY text is emitted with `textMode: replace` rather than treated as a streaming delta. AGY per-call model override remains unsupported in 1.0.1: adapter metadata marks the model unverified/account-selected, and a requested Cat Cafe model override produces `system_info` diagnostics instead of silently pretending `--model` was applied. Image inputs degrade to local path hints plus `--add-dir` access; no native image flag is invented.

### Phase D（Install / Packaging）

- [x] AC-D1: macOS/Linux installer scripts install or instruct `agy` via official bootstrapper, not `@google/gemini-cli`.
- [x] AC-D2: Windows installer/build scripts have a verified native `agy` path or explicit unsupported message.
- [x] AC-D3: Offline desktop packaging handles native binary distribution intentionally.

Phase D install/packaging source: `scripts/install.sh`, `scripts/install.ps1`, `scripts/windows-command-helpers.ps1`, `desktop/scripts/build-mac.sh`, `desktop/scripts/build-desktop.ps1`, `desktop/scripts/post-install-offline.ps1`, `desktop/installer/cat-cafe.iss`, and `desktop/scripts/generate-desktop-config.ps1`.

Cat Cafe installers now provision `agy` through Google's native bootstrapper (`https://antigravity.google/cli/install.sh` / `.cmd`) and resolve the Windows native binary at `%LOCALAPPDATA%\agy\bin\agy.exe`. Desktop offline packages intentionally ship `agy-install-instructions.txt` instead of pretending the old `@google/gemini-cli` npm package is a vendorable Antigravity CLI replacement.

### Phase E（Tests / E2E）

- [ ] AC-E1: `GEMINI_ADAPTER=antigravity-cli` can invoke Siamese end-to-end from Cat Cafe.
- [ ] AC-E2: `GEMINI_ADAPTER=gemini-cli` remains explicitly testable as fallback.
- [ ] AC-E3: Existing wiring tests no longer assume `gemini-cli` is the only headless Google carrier.
- [ ] AC-E4: Default adapter changes only after AC-E1 is green.

### Phase F（Docs / Truth Sync）

- [ ] AC-F1: README/env/architecture docs explain consumer deadline, enterprise exception, and Antigravity CLI default.
- [ ] AC-F2: Review request to `@antig-opus` includes the fact corrections from this spec.
- [ ] AC-F3: `docs/features/index.json` and `docs/ROADMAP.md` are in sync with F210.

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

## Review Gate

- Kickoff review: `@antig-opus` reviews this spec for Antigravity product facts and missing recon points.
- Implementation review: cross-family reviewer required before PR merge. Same individual cannot review their own code.
