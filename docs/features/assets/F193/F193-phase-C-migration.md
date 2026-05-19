---
feature_ids: [F193]
topics: [migration, mcp, harness-config]
doc_kind: migration-guide
created: 2026-05-08
---

# F193 Phase C — Migration Guide for Local Harness Config

> **Status**: Required user action after Phase C merges.
> **Source**: `docs/features/F193-cross-thread-comm-unification.md` Phase C
> **PR**: pending

## What Changed

Phase C adds a new **`cat-cafe-limb`** MCP server entry point at `packages/mcp-server/dist/limb.js`. Previously, limb tools (`limb_list_available` / `limb_invoke` / `limb_pair_list` / `limb_pair_approve`) only existed under the all-in-one `cat-cafe` server (registered via `registerFullToolset`).

Phase C completes the F043 split-only direction: 4 split servers (collab + memory + signals + limb), each with its own namespace prefix. The all-in-one `cat-cafe` server remains in code (backward compat) but should not be loaded in default harness configs.

### Auto-migration (capability orchestrator)

`capability-orchestrator.ts` is the source of truth. After Phase C:

- `bootstrapCapabilities()` only registers the 4 splits (no legacy `cat-cafe` all-in-one)
- `ensureCatCafeMainServer()` flipped semantics: when splits exist, **removes** legacy `cat-cafe` + **adds** `cat-cafe-limb` if missing (covers 3-split → 4-split auto-upgrade for existing installs)
- `migrateLegacyCatCafeCapability()` converts seed-only legacy `cat-cafe` → 4 splits (now includes limb via updated `CAT_CAFE_SPLIT_SERVER_IDS`)

`capabilities.json` auto-heals every API write. **And so do `.mcp.json` / `.codex/config.toml`** — every `GET /api/capabilities` call ends with `generateCliConfigs(config, getCliConfigPaths(projectRoot))` ([capabilities.ts:454](../../../../packages/api/src/routes/capabilities.ts)), which idempotently merge-writes the project-root `.mcp.json` and `.codex/config.toml` from the canonical `capabilities.json`. So once the orchestrator side is on Phase C, the next Hub-driven capabilities flow rewrites your local CLI configs to the 4-split + limb topology automatically.

The PR can't `commit` your `.mcp.json` / `.codex/config.toml` directly because they're gitignored (user-local paths + per-machine variations). But the orchestrator does regenerate them on the next capabilities GET.

## When Manual Diff Is Needed

For most users the auto-migration above already handles your `.mcp.json` / `.codex/config.toml` — open Hub once after the Phase C merge and the next capabilities GET rewrites them.

The manual `.diff` snippets below are the **fallback path** for cases where the auto-flow doesn't run or you need an immediate fix:

- You don't run Hub on this machine (pure CLI session, no `GET /api/capabilities` round-trip)
- You need to fix harness duplicates **before** opening Hub (e.g. CLI tools list shows `mcp__cat-cafe__cat_cafe_post_message` AND `mcp__cat-cafe-collab__cat_cafe_post_message` and you want it gone right now)
- Your local config has hand-edits the orchestrator's idempotent merge isn't sure how to reconcile

The two outcomes you want to land on:
1. Remove the `cat-cafe` (all-in-one) entry — eliminates 60+ duplicate tool registrations across namespaces
2. Add the new `cat-cafe-limb` entry — keeps limb tools accessible

## How to Update (Fallback Manual Diff)

### `.mcp.json` (Claude Code MCP harness)

```diff
 {
   "mcpServers": {
-    "cat-cafe": {
-      "command": "node",
-      "args": ["packages/mcp-server/dist/index.js"]
-    },
     "cat-cafe-collab": {
       "command": "node",
       "args": ["packages/mcp-server/dist/collab.js"]
     },
     "cat-cafe-memory": {
       "command": "node",
       "args": ["packages/mcp-server/dist/memory.js"]
     },
     "cat-cafe-signals": {
       "command": "node",
       "args": ["packages/mcp-server/dist/signals.js"]
+    },
+    "cat-cafe-limb": {
+      "command": "node",
+      "args": ["packages/mcp-server/dist/limb.js"]
     }
   }
 }
```

### `.codex/config.toml` (Codex CLI MCP harness)

```diff
-[mcp_servers.cat-cafe]
-command = "node"
-args = [ "/absolute/path/to/cat-cafe/packages/mcp-server/dist/index.js" ]
-enabled = true
-
 [mcp_servers.cat-cafe-collab]
 command = "node"
 args = [ "/absolute/path/to/cat-cafe/packages/mcp-server/dist/collab.js" ]
 enabled = true

 [mcp_servers.cat-cafe-memory]
 command = "node"
 args = [ "/absolute/path/to/cat-cafe/packages/mcp-server/dist/memory.js" ]
 enabled = true

 [mcp_servers.cat-cafe-signals]
 command = "node"
 args = [ "/absolute/path/to/cat-cafe/packages/mcp-server/dist/signals.js" ]
 enabled = true
+
+[mcp_servers.cat-cafe-limb]
+command = "node"
+args = [ "/absolute/path/to/cat-cafe/packages/mcp-server/dist/limb.js" ]
+enabled = true
```

(Replace `/absolute/path/to/cat-cafe/` with the absolute path to your cat-cafe checkout.)

## Verify

After updating + restarting your CLI / Claude Code session:

1. `cat_cafe_post_message` (collab namespace) — should still work
2. `limb_list_available` (limb namespace) — should still work
3. Tools listed once per name in your tool catalog — no duplicates

If a tool appears twice with different namespaces (e.g. `mcp__cat-cafe__cat_cafe_post_message` AND `mcp__cat-cafe-collab__cat_cafe_post_message`), the `cat-cafe` (all-in-one) entry is still loaded — remove it.

## Phase D probe-* cleanup: Remove deprecated probe entries (user action)

F193 Phase D 的 audit 阶段还识别出几个 user-local `.mcp.json` /
`.codex/config.toml` 里残留的 debugging probe 条目（`probe-connected`
/ `probe-env` / `probe-off`）。如果你的本地 config 还有这些条目，
直接删除即可——它们对应的 MCP server 已不再 maintain，留着只会让
猫看到无效工具调用失败。

Phase D 同时清理了两个 deprecated MCP 工具：
- `cat_cafe_reflect`：用 `cat_cafe_search_evidence` 替代
- `cat_cafe_guide_resolve`：用 `cat_cafe_get_available_guides` 替代

如果你的 prompt / skill / 内部工具调用还引用这两个名字，请按上面的替代关系更新。

### `.mcp.json` (Claude Code MCP harness)

```diff
 {
   "mcpServers": {
-    "probe-connected": { ... },
-    "probe-env": { ... },
-    "probe-off": { ... }
   }
 }
```

### `.codex/config.toml` (Codex CLI MCP harness)

```diff
-[mcp_servers.probe-connected]
-...
-
-[mcp_servers.probe-env]
-...
-
-[mcp_servers.probe-off]
-...
```

## Why `.mcp.json` and `.codex/config.toml` Are Gitignored

These configs include user-specific paths (absolute paths in `.codex/config.toml`) and may include user-specific tool sets (e.g. local-only debugging probes). Tracking them would force every cat-cafe checkout to share the same harness config — incompatible with multi-machine / multi-user development.

The trade-off: phase migrations that affect these files can't ship as a committed `.diff`. Hub's `generateCliConfigs` is the primary automated path; this manual diff is the fallback for non-Hub flows (see "When Manual Diff Is Needed" above).

## Links

- F193 spec: `docs/features/F193-cross-thread-comm-unification.md` Phase C
- F043 (origin of split-only direction): `docs/features/F043-mcp-unification.md`
- New entry point: `packages/mcp-server/src/limb.ts`
- Test守护: `packages/mcp-server/test/tool-registration.test.js` `createLimbServer registers only limb tool surface`
