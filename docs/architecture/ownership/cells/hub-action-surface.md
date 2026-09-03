---
cell_id: hub-action-surface
title: Hub Action Surface
summary: First-party Hub user-visible actions that let cats surface files, previews, rich blocks, workflow state, and other in-context artifacts to the user.
canonical_features: [F022, F063, F096, F120, F131, F223, F232, F284, F290, F299, F307, F310]
code_anchors:
  - packages/shared/src/types/context-attachment.ts
  - packages/shared/src/schemas/context-attachment.schema.ts
  - packages/api/src/routes/messages.schema.ts
  - packages/api/src/domains/cats/services/agents/routing/context-attachment-prompt.ts
  - packages/web/src/components/ContextAttachmentView.tsx
  - packages/web/src/hooks/useTextSelectionAction.ts
  - packages/api/src/routes/workspace.ts
  - packages/api/src/routes/callback-skill-consumption-routes.ts
  - packages/api/src/domains/cats/services/tool-usage/SkillConsumptionReceiptService.ts
  - packages/web/src/hooks/useWorkspaceNavigate.ts
  - packages/api/src/routes/preview.ts
  - packages/web/src/components/__tests__/preview-auto-open-store.test.ts
  - packages/web/src/components/__tests__/workspace-navigate-store.test.ts
  - packages/mcp-server/src/tools/hub-action-tools.ts
  - packages/mcp-server/src/tools/skill-consumption-tools.ts
  - packages/mcp-server/src/tools/callback-tools.ts
  - packages/mcp-server/src/tools/rich-block-rules-tool.ts
  - packages/api/src/domains/cats/services/agents/routing/thread-artifacts-aggregator.ts
  - packages/web/src/components/ArtifactsPanel.tsx
  - packages/web/src/components/rich/RuntimeInteractionCard.tsx
  - packages/api/src/routes/runtime-interaction-routes.ts
doc_anchors:
  - docs/features/F022-rich-blocks.md
  - docs/features/F063-hub-workspace-explorer.md
  - docs/features/F096-interactive-rich-blocks.md
  - docs/features/F120-hub-embedded-browser.md
  - docs/features/F131-workspace-navigator.md
  - docs/features/F223-capability-surface-registry.md
  - docs/features/F232-thread-artifacts-panel.md
  - docs/features/F284-contextual-workspace-shell.md
  - docs/features/F290-ai-native-collective.md
  - docs/features/F299-workspace-invocation-trajectory.md
  - docs/features/F307-composable-workbench.md
  - docs/features/F310-growing-real-delegation.md
  - docs/features/F306-codex-app-capability-parity.md
  - cat-cafe-skills/refs/capability-wakeup-index.md
  - docs/architecture/skill-consumption-receipt-contract.md
static_scan_hints: [ContextAttachment, context_attachment, Add to chat, workspace:navigate, preview:auto-open, create_rich_block, rich block, workspace panel, browser preview, surface to user, in-context artifact]
cited_by:
  - {feature: F223, date: 2026-06-03, delta: new cell}
  - {feature: F232, date: 2026-06-12, delta: update — thread artifacts aggregation endpoint + ArtifactsPanel drawer}
  - {feature: F284, date: 2026-07-31, delta: update — contextual Workspace shell and deterministic existing-surface reveal policy}
  - {feature: F063, date: 2026-08-08, delta: update — structured composer/message context attachments and text-selection Add to chat}
  - {feature: F290, date: 2026-08-26, delta: boundary — Collective owns lineage, permissions and result targets but no Workspace mode or layout persistence}
  - {feature: F299, date: 2026-08-26, delta: update — invocation and Agent Run records/lifecycle remain source-owned while Workbench consumes typed descriptors}
  - {feature: F307, date: 2026-08-26, delta: update — application-level working-set, typed tab/split/sidecar topology and restore owner}
  - {feature: F306, date: 2026-08-27, delta: "Phase B in-context runtime interaction card — approval/question/elicitation share one canonical thread surface; Approval Hub is navigation-only and stale controls are inert."}
  - {feature: F310, date: 2026-08-31, delta: "Phase A boundary — global Needs Me and product Schedule are sibling read projections over producer-owned truth; this cell owns projection/dedupe/exact-return only, never custody lifecycle, business eligibility, or a second store."}
---

# Hub Action Surface

## Canonical Owner

F223 owns the cross-cutting capability surface registry. This cell owns first-party Hub actions whose purpose is to put work in front of the user inside Clowder AI: Workspace navigation, Browser Preview auto-open, rich blocks, workflow/status surfaces, and similar in-context artifacts.

This cell is separate from `action-plane`: action-plane owns external/vendor resource mutations such as Lark/WeCom docs, tasks, meetings, dry-run, idempotency, and resource handles. Hub action surface owns first-party UI state and display side effects.

F307 owns the application-level Composable Workbench contract: working-set identity, typed tabs, active/split state, sidecar promotion, order, pin and restore validation. F284 owns the existing contextual right-side Workspace v1—stable entry, launcher, current focus, Activity and deterministic reveal—and is a migration source/consumer of F307, not a second layout owner. F290 supplies descriptors for Collective-owned Channel, Artifact, Topic, Roadmap and Review objects, including lineage, permission projection, Collective-scoped result targets and provenance. Invocation and Agent Run records/lifecycle remain owned by runtime/F299 and enter F307 through their own descriptors. Product records do not leak into the generic Workbench reducer, while product adapters do not persist a second tab/split truth.

F306 adds one in-context `RuntimeInteractionCard` to the existing thread rich-block surface. The card renders approval, question, and elicitation from a provider-neutral canonical record, resolves actions through a strictly owner-authenticated route, and becomes inert when the record is stale or terminal. Long descriptions and provider paths preserve line breaks and wrap inside narrow cards; URL elicitations render links only for `http|https`. Approval Hub may recall and navigate to an approval-kind card, but neither F223/F284 nor the Hub owns interaction lifecycle or a second decision endpoint.

F310 adds the product-wide `Needs Me` and product `Schedule` projection contract inside the existing Workspace home. F310 composes producer-returned eligibility receipts, deduplicates their presentation and provides exact return; each producer still owns business eligibility, salience, time, Artifact, judgment, re-evaluation and action truth. The projection layer persists no custody lifecycle or second attention/schedule payload, and the existing F139 scheduler-management `SchedulePanel` remains a different administrative surface.

## Use This When

- Adding or changing a first-party Clowder AI action that opens, reveals, previews, renders, or updates a Hub surface for the user.
- Adding structured Thread, Workspace File, or Quote context that must survive composer drafts, message persistence, model consumption, and Hub rendering without Markdown identity heuristics.
- Adding a typed cat execution surface for an existing Hub API route such as Workspace navigation or Browser Preview auto-open.
- Adding an F307 typed tab, split, sidecar promotion or restore rule that must work across product-owned Workbench surfaces.
- Adding socket emission, room targeting, thread/worktree scoping, audit events, or verification probes for user-visible Hub side effects.
- Adding a provider mid-run ask-human card, its responsive pending/terminal states, or an attention projection that must return to the same canonical thread message.
- Deciding whether a skill should call an MCP tool, helper, callback route, or existing Hub API to surface an artifact to the user.

## Extend By

- Prefer typed execution surfaces over raw first-party `curl localhost` instructions in skills.
- Keep side-effect payloads schema-bound and include enough context for scoping: `threadId`, `worktreeId`, `catId`, event id, or equivalent fields.
- Extend `ContextAttachment` at its shared schema and `MessageContent` boundary; product-owned special objects must not encode identity in ordinary Markdown.
- Pair every user-visible side effect with a verification path: audit event, socket event, opened file probe, screenshot, rendered rich block, or workflow state readback.
- Keep runtime-interaction actions on the canonical card. Approval Hub projection is navigation-only; copied/forwarded cards and stale records must render read-only.
- Route long-term adoption/miss-rate measurement through F192; this cell owns the execution surface, not the eval verdict.
- For revision-bound skill consumption, let a declared Hub consumer write `applied`; preparation/load is not a receipt,
  and the consumer's bounded delivery decision is not task-success causality.

## Do NOT Unify With

- Do not put external vendor resource mutation here. Lark/WeCom/enterprise actions remain in `action-plane`.
- Do not use this cell to justify MCP wrappers for discovery alone. A first-party Hub MCP wrapper is valid only when it replaces fragile manual calls and carries schema, scoping, audit, or verification value.
- Do not move canonical eval ownership here. F192 remains the owner of `eval:capability-wakeup`, verdict handoff, and re-eval closure.
- Do not move raw telemetry ownership here. F153 owns telemetry; this cell may emit or consume audit/probe signals.
- Do not create a central skill truth store or infer `applied` from tool names, task success, or presentation events.
- Do not turn Approval Hub into a generic question broker or persist a second runtime-interaction state. Non-approval questions and elicitations stay in the current thread.
- Do not move Collective content, lineage, permission or result-target ownership into F307. F290 supplies those records through the Workbench boundary.
- Do not let F284 or any product Feature create a second working-set/layout persistence owner. F284 remains the contextual Workspace v1 entry and migration baseline.
- Do not let F310 turn this cell into a hidden orchestrator: admitting work, deciding producer eligibility, owning business time, mutating Artifacts, or persisting a second attention/schedule record remain outside this cell.

## Static Scan Hints

Watch for `/api/workspace/navigate`, `workspace:navigate`, `/api/preview/auto-open`, `preview:auto-open`, `cat_cafe_create_rich_block`, rich block rendering, `setWorkspaceOpenFile`, `setWorkspaceRevealPath`, Browser Preview auto-open, and skill docs that teach cats to call first-party Hub APIs by hand. Until F307 passes Design Gate, no domain Feature may register its own generic Workspace mode or layout persistence.
