---
cell_id: hub-action-surface
title: Hub Action Surface
summary: First-party Hub user-visible actions that let cats surface files, previews, rich blocks, workflow state, and other in-context artifacts to the user.
canonical_features: [F022, F096, F120, F131, F223, F232]
code_anchors:
  - packages/api/src/routes/workspace.ts
  - packages/web/src/hooks/useWorkspaceNavigate.ts
  - packages/api/src/routes/preview.ts
  - packages/web/src/components/__tests__/preview-auto-open-store.test.ts
  - packages/web/src/components/__tests__/workspace-navigate-store.test.ts
  - packages/mcp-server/src/tools/hub-action-tools.ts
  - packages/mcp-server/src/tools/callback-tools.ts
  - packages/mcp-server/src/tools/rich-block-rules-tool.ts
  - packages/api/src/domains/cats/services/agents/routing/thread-artifacts-aggregator.ts
  - packages/web/src/components/ArtifactsPanel.tsx
doc_anchors:
  - docs/features/F022-rich-blocks.md
  - docs/features/F096-interactive-rich-blocks.md
  - docs/features/F120-hub-embedded-browser.md
  - docs/features/F131-workspace-navigator.md
  - docs/features/F223-capability-surface-registry.md
  - docs/features/F232-thread-artifacts-panel.md
  - cat-cafe-skills/refs/capability-wakeup-index.md
static_scan_hints: [workspace:navigate, preview:auto-open, create_rich_block, rich block, workspace panel, browser preview, surface to user, in-context artifact]
cited_by:
  - {feature: F223, date: 2026-06-03, delta: new cell}
  - {feature: F232, date: 2026-06-12, delta: update — thread artifacts aggregation endpoint + ArtifactsPanel drawer}
---

# Hub Action Surface

## Canonical Owner

F223 owns the cross-cutting capability surface registry. This cell owns first-party Hub actions whose purpose is to put work in front of the user inside Cat Cafe: Workspace navigation, Browser Preview auto-open, rich blocks, workflow/status surfaces, and similar in-context artifacts.

This cell is separate from `action-plane`: action-plane owns external/vendor resource mutations such as Lark/WeCom docs, tasks, meetings, dry-run, idempotency, and resource handles. Hub action surface owns first-party UI state and display side effects.

## Use This When

- Adding or changing a first-party Cat Cafe action that opens, reveals, previews, renders, or updates a Hub surface for the user.
- Adding a typed cat execution surface for an existing Hub API route such as Workspace navigation or Browser Preview auto-open.
- Adding socket emission, room targeting, thread/worktree scoping, audit events, or verification probes for user-visible Hub side effects.
- Deciding whether a skill should call an MCP tool, helper, callback route, or existing Hub API to surface an artifact to the user.

## Extend By

- Prefer typed execution surfaces over raw first-party `curl localhost` instructions in skills.
- Keep side-effect payloads schema-bound and include enough context for scoping: `threadId`, `worktreeId`, `catId`, event id, or equivalent fields.
- Pair every user-visible side effect with a verification path: audit event, socket event, opened file probe, screenshot, rendered rich block, or workflow state readback.
- Route long-term adoption/miss-rate measurement through F192; this cell owns the execution surface, not the eval verdict.

## Do NOT Unify With

- Do not put external vendor resource mutation here. Lark/WeCom/enterprise actions remain in `action-plane`.
- Do not use this cell to justify MCP wrappers for discovery alone. A first-party Hub MCP wrapper is valid only when it replaces fragile manual calls and carries schema, scoping, audit, or verification value.
- Do not move canonical eval ownership here. F192 remains the owner of `eval:capability-wakeup`, verdict handoff, and re-eval closure.
- Do not move raw telemetry ownership here. F153 owns telemetry; this cell may emit or consume audit/probe signals.

## Static Scan Hints

Watch for `/api/workspace/navigate`, `workspace:navigate`, `/api/preview/auto-open`, `preview:auto-open`, `cat_cafe_create_rich_block`, rich block rendering, `setWorkspaceOpenFile`, `setWorkspaceRevealPath`, Browser Preview auto-open, and skill docs that teach cats to call first-party Hub APIs by hand.
