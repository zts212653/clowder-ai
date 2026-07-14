# Review Request: #315 provider-adaptive CLI effort

Review-Target-ID: issue-315-provider-adaptive-effort
Branch: fix/issue-315-provider-adaptive-effort
Implementation-SHA: 318d3e6ce7584ef0c4fb258a88ae166c19cb2cfd
Note: This SHA identifies the original implementation commit. The current PR HEAD
may differ due to main-sync merges and review-round fixes. Always verify against
the actual PR HEAD for approval evidence.

## What

The Hub member editor now keeps client-specific effort presets as suggestions while allowing direct native text input. The runtime catalog and Cats API accept and retain any trimmed, non-empty `cli.effort` string. Provider adapters remain responsible for argument construction: Codex serializes the value into one TOML-escaped `--config` argument; Claude keeps its structured `--effort`, value argv pair.

## Why

Provider CLIs evolve independently of our maintained preset vocabulary. Rejecting or normalizing a native value such as Codex `max` or `ultra` prevents a member from using a provider capability until our UI enum catches up.

## Original Requirements

> "Present maintained internal CLI-effort presets appropriate for the selected client. Also allow direct text entry of a native client effort value. Codex must be able to use native values including `max` and `ultra`. Persist the selected or typed canonical string in `variant.cli.effort`. The adapter owns CLI argument construction and escaping."

- Source: [clowder-ai#315](https://github.com/zts212653/clowder-ai/issues/315)
- Please assess the diff against this extract, including the requirement that existing sessions are not force-switched.

## Tradeoff

We deliberately do not maintain provider-version detection or a second provider-native enum. Presets remain discoverable suggestions; unknown non-empty values are accepted and the selected CLI remains the authority that can reject them. This avoids both release lag and raw shell-string construction.

## Architecture Ownership

Architecture cell: `identity-session` (identity-agent subcell)
Map delta: none
Why: This changes the existing cat-instance configuration contract and its existing provider adapters without adding a store, router, queue, or ownership boundary.

Please verify that the diff matches `Map delta: none` and does not introduce a parallel configuration truth source.

## Invariant Matrix

| Invariant | Assertion | Evidence |
| --- | --- | --- |
| INV-1 | Runtime catalog preserves a user-entered non-empty effort string unchanged. | loader and Cats route tests |
| INV-2 | Form hydration and serialization round-trip presets and unfamiliar native values unchanged. | Hub editor component tests |
| INV-3 | Only the selected provider adapter constructs argv; typed text is never a shell command. | Codex TOML-escaping regression and existing Claude argv tests |
| INV-4 | Saved effort is read by a new invocation; no existing session is mutated or restarted. | `getCatEffort`/provider invocation tests; no session lifecycle code changed |

## E2E User Path Evidence

Scope verdict: required.

- Latest isolated author preview: `WORKTREE_PORT_OFFSET=-30 pnpm dev:direct -- --memory` used memory-only storage, API `3132`, and Web `5132`; both Web `/` and API `/health` returned HTTP 200. `cat_cafe_preview_open` opened the Hub preview at `5132`, then the service was stopped and both ports were confirmed free.
- Dogfood path: a temporary `gpt-5.6-terra` Codex member accepted structured `cli.effort="ultra"` through `POST /api/cats`, and `GET /api/cats` returned the exact model and effort. The memory-only server discarded that temporary state when it stopped.
- The in-app browser interaction controller is unavailable in this invocation, so this record does **not** claim visual approval. `hub-cat-editor.test.tsx` covers the direct-entry field and GPT-5.6 `max / ultra` suggestions; the formal reviewer must interact with the member editor in an isolated preview before approving.

## Open Questions

### Technical OQ

1. Does widening `CliEffortValue` to `string` leave any consumer that still incorrectly assumes the preset-only union?
2. Is the Codex TOML escaping sufficient for control characters, quotes, and backslashes while preserving exactly one config value?
3. Do existing sanitized CLI exit/error paths remain adequate when a provider rejects an accepted native effort value?

### Value OQ

None.

## Fresh-Context Findings

Agent: [砚砚/gpt-5.6-terra🐾] (new continuation session)
SHA scanned: 318d3e6ce
Total findings: 0 (0 P1, 0 P2, 0 P3)

The scan re-read #315, the complete diff, loader/API/adapter call sites, and the fallback/security surface. It is a finding generator only, not an approval.

## Next Action

Please perform an independent cross-family review of the current SHA. Give an explicit `APPROVE` or `REQUEST-CHANGES` verdict and label every finding P1/P2/P3. Focus on the invariant matrix, unknown-value passthrough, safe argv serialization, and the shared type's blast radius.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/issue-315-provider-adaptive-effort/opus`
- Start command: `pnpm review:start`
- Ports: assigned by the review launcher; do not use runtime ports `3003`/`3004`.

Before running target API tests in a clean sandbox:

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build
```

## Quality-Gate Evidence

### Acceptance coverage

| #315 requirement | Evidence |
| --- | --- |
| Presets plus direct entry | editable `TextField` with datalist suggestions; Web regression |
| Codex `max`/`ultra` | loader/API passthrough coverage; native-value adapter assertion |
| Non-preset persistence | Cats route and loader tests |
| Safe structured args | `buildCodexReasoningArgs()` uses TOML string escaping; no shell concatenation |
| Native failure visibility | existing Codex/Claude CLI error-path regressions pass in the targeted suite |
| New invocation only | configuration resolution/provider invocation path only; no session lifecycle edits |

### Commands actually run

```bash
# Isolated API test-home prelude
pnpm --filter @cat-cafe/api run build
cd packages/api
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./scripts/with-test-home.sh \
  node --import "$(pwd)/test/helpers/setup-cat-registry.js" --test --test-timeout=60000 \
  test/cat-config-loader.test.js test/cats-routes-runtime-crud.test.js \
  test/codex-agent-service.test.js test/claude-agent-service.test.js
# Result: build 0; 269 passed, 0 failed

cd ../../
pnpm --dir packages/web exec node scripts/run-with-node-env-test.mjs \
  pnpm exec vitest run src/components/__tests__/hub-cat-editor.test.tsx \
  --pool=forks --no-file-parallelism
# Result: 60 passed, 0 failed

pnpm lint                         # exit 0 (pre-existing warnings only)
pnpm check                        # exit 0
pnpm -r --if-present run build    # exit 0
```

`pnpm test` exits 1 on the unmodified upstream baseline: `origin/main` lacks `.claude/settings.json`, `.claude/hooks/shared-doc-push-guard.sh`, and `scripts/signal-fetcher-launchd.sh`; the #315 diff touches none of these paths. The failure is recorded, not waived as a green result.

`scripts/check-fallback-layers.mjs` is absent from this open-source checkout. A diff audit found no added `try`/`catch` or multi-layer fallback chain; the three added `??` uses are single-level UI/default expressions.

Artifact hygiene: no root-level media/design artifacts in either the worktree or committed diff. No matching `.pen` file exists.

## Related Documents

- Plan: `feature-specs/2026-07-10-issue-315-provider-adaptive-effort.md`
- Feature: `docs/features/F127-cat-instance-management.md` (R-11)
