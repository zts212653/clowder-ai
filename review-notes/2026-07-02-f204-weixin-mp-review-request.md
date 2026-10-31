# Review Request: F204 WeChat MP Plugin + Limb 3-Tool Refactor

Review-Target-ID: f204
Branch: feat/f197-weixin-mp-plugin
PR: https://github.com/zts212653/clowder-ai/pull/1058

## What

46 commits / 76 files changed across three areas:

### 1. F204 WeChat MP Publisher Plugin (core)
- `plugins/weixin-mp/` manifest, limb YAML, skill docs
- Weixin MP API client: `handlers.ts`, `markdown-to-wx-html.ts`
- `PluginTokenManager` — Redis-backed access-token cache with expiry
- `PluginRestExecutor` — REST adapter for plugin HTTP calls
- `PluginLimbAdapter` — bridges F202 plugin framework to F126 limb surface
- `PluginResourceActivator` — lifecycle management for plugin resources
- URL safety validation (`url-safety.ts`)
- Plugin routes, installer, config panel

### 2. Skill Management Fixes (F228 scope)
- `skill-manage.ts` split into three focused modules (530 -> 343 lines)
- pluginId propagation across all sync paths (5 cascading fixes)
- Drift detector/resolver for skill source consistency
- Frontend: PluginConfigPanel, PluginsContent, SkillsContent, SkillsSubComponents

### 3. Limb 3-Tool Refactor + ACP Fixes (S4-S5)
- Limb MCP tools redesigned: `list_available` -> `list_tools` -> `invoke_tool` (3-step workflow)
- `limb_list_tools` (new): query detailed parameter schemas per limb node
- `limb_invoke_tool` (renamed from `limb_invoke`): step 3 guidance
- ACP bootstrap CWD: `~/.cache` -> `/tmp` with uid isolation
- ACP error surfacing: JSON-RPC `data.error` detail propagated to frontend
- MCP SDK fix: `server.registerTool()` replaces `server.tool()` to avoid SDK 1.26.0 overload mis-parse

## Why

F204 is the first concrete plugin on the F202 framework — WeChat Official Account article publishing. It validates the plugin architecture end-to-end: manifest -> limb declaration -> skill registration -> credential management -> API invocation.

The limb 3-tool refactor was co-creator directed: agents need `discover -> inspect -> invoke` instead of a monolithic tool surface.

## Original Requirements

> F204 adds a trusted repository-local plugin for publishing article content to WeChat Official Accounts. [...] Weixin MP API client and access-token manager. Redis-backed token cache with expiry handling. Markdown to WeChat-compatible HTML conversion.
- Source: `docs/features/F204-weixin-mp-publisher-plugin.md`
- Community PR origin: [clowder-ai #688](https://github.com/zts212653/clowder-ai/pull/688) by `mindfn`
- **Please verify deliverables against F204 spec acceptance criteria (AC-A1 through AC-B3)**

## Tradeoff

- Limb invoke route path stays `/api/callback/limb/invoke` (not renamed to `/invoke-tool`) to avoid breaking existing integrations. Only the MCP tool name changed.
- `deregister` not exposed as MCP tool — co-creator decided to defer to device debugging phase.
- Frontend plugin panels: iterative fix approach (5 pluginId propagation commits) rather than one big rewrite — each commit is individually revertable.

## Architecture Ownership

Architecture cell: `plugin`
Map delta: none (F204 lives within the existing plugin cell established by F202)
Why: F204 is a concrete plugin instance, not a new architectural boundary. It uses existing limb/plugin/skill extension points.

Please reviewer check:
- diff does NOT create parallel `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding` outside plugin cell
- `PluginLimbAdapter` / `PluginRestExecutor` / `PluginTokenManager` are extension-point implementations, not parallel infrastructure
- No changes to `docs/architecture/ownership/cells/*.md`

## Open Questions

### Technical OQ (for reviewer)

1. **pluginId propagation completeness**: 5 consecutive fix commits addressed pluginId leaking through sync paths. Are there remaining sync paths that could lose pluginId? (Relevant files: `skill-sync-engine.ts`, `skill-sync-all.ts`, `skill-sync-config.ts`)
2. **ACP bootstrap `/tmp` vs `~/.cache`**: Chose `/tmp` with uid isolation for stability. Any concerns about `/tmp` cleanup on non-macOS?
3. **`server.registerTool()` migration**: Only limb tools migrated to `registerTool()`. Should all tools migrate proactively, or wait for SDK breakage?

### Value OQ (for operator)

None — all decisions within reversible technical scope.

## Next Action

Please do a complete review of PR #1058. Key review focus areas:
1. **Plugin architecture**: Does F204 correctly implement the F202 plugin contract?
2. **Limb 3-tool workflow**: Is the discover -> inspect -> invoke flow clean and complete?
3. **Skill sync correctness**: pluginId propagation, drift detection, cascade logic
4. **Frontend panels**: Plugin config and skill management UI correctness

## Review Sandbox

- Path: `/tmp/cat-cafe-review/f204/codex`
- Start Command: `pnpm review:start` (or manual: `pnpm install --frozen-lockfile && pnpm -r build`)
- Ports: `web=3201`, `api=3202` (avoids 3003/3004 running instance)

### Sandbox Bootstrap

```bash
# 1. Clear inherited NODE_ENV=production
unset NODE_ENV

# 2. Clean install
pnpm install --frozen-lockfile

# 3. Build chain (required for API tests that import dist/)
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build
```

## Latest Changes (S5 addendum, commit f830134b0)

### 4. WeChat MP Tool API Improvements

**Parameter rename**: `uri` → `fileLocation` for upload_image/upload_material
- Why: avoid HTTP mental association; description now explicitly lists supported sources
- Affects: handlers.ts, weixin-mp.yml, tests

**convert_markdown output to file**: now writes HTML to file and returns `filePath` instead of inline HTML
- Why: saves the calling model a write tool call; output passes directly to create_draft's contentFilePath
- Output path: `{input}.wx.html` (if markdownFilePath given) or `os.tmpdir()/wx-converted-{ts}.html`

**7 new API commands** (completing WeChat MP publishing workflow):
- P0: `delete_draft` (REST), `update_draft` (invoke, supports contentFilePath)
- P1: `delete_material` (REST), `list_material` (REST), `get_material_count` (REST, GET method)
- P2: `list_articles` (REST), `delete_article` (REST)

6/7 are pure YAML REST declarations. Only `update_draft` has a handler (needs contentFilePath like create_draft).

**Key review focus for this commit:**
1. `update_draft` handler: WeChat `/draft/update` expects `articles` as object (not array like create_draft) — please verify
2. `get_material_count` uses GET method — REST executor supports it (line 24), but this is the first GET command
3. Capabilities lists updated: content_read gains 3 queries, content_publish gains 3 mutations
4. `writeLocalFile` added to DI deps for convert_markdown testability

## Self-Check Evidence

### Spec Compliance

- F204 spec AC-A1: PR title uses `F204` as primary anchor
- F204 spec AC-B1: Credentials via F202 config boundaries (PluginConfigPanel), not committed
- F204 spec AC-B2: PluginTokenManager with Redis-backed expiry + auth failure invalidation
- F204 spec AC-B3: url-safety.ts validates URLs before publish

### Test Results

```bash
# Weixin-MP handler + limb tests (S5 latest)
cd packages/api && node --test test/weixin-mp-limb-node.test.js
# 21 passed, 0 failed (was 18 before this commit, +3 for update_draft)

# Limb route tests (S5 verified)
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./scripts/with-test-home.sh \
  node --import ./test/helpers/setup-cat-registry.js --test test/callback-limb-routes.test.js
# 16 passed, 0 failed

# CI status
# PR #1058 — CI green on commits ee9a520, bf5b5f6, 4c5d01a (pushed f830134b0)

# Lint + Biome
pnpm lint     # passed (warnings are pre-existing, not regression)
biome check   # passed, 0 diagnostics on changed files
tsc --noEmit  # passed, 0 errors
```

### Root Directory Artifacts Gate

```
git status --short | grep root media: CLEAN
git diff --name-only origin/main...HEAD | grep root media: CLEAN
```

### Related Documents

- Feature: `docs/features/F204-weixin-mp-publisher-plugin.md`
- Related: F202 (plugin framework), F126 (limb surface), F228 (skill management)
- PR: https://github.com/zts212653/clowder-ai/pull/1058

---
Signed: [宪宪/claude-opus-4-6]
