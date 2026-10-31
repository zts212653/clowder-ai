---
cell_id: community-ops
title: Community Operations
summary: GitHub 插件拥有社区事件、投影、审查事实和草稿；Host 提供普通 action、消息与 Task 数据，并展示插件结果。
doc_kind: architecture
created: 2026-06-10
canonical_features: [F168, F202]
code_anchors:
  - packages/web/src/components/CommunityPanel.tsx
  - packages/web/src/components/community/DecisionQueuePanel.tsx
  - packages/web/src/components/rich/CommunityPublishFlow.tsx
  - packages/web/src/components/rich/FrustrationIssueCard.tsx
  - packages/api/src/domains/plugin/runtime-composition.ts
doc_anchors:
  - docs/features/F202-plugin-framework.md
  - docs/architecture/plugin-architecture.md
cited_by: [F202]
static_scan_hints: [CommunityPanel, DecisionQueuePanel, CommunityPublishFlow, official.github-operations]
---

# Community Operations

## Ownership

The `official.github-operations` plugin owns community event storage, case projections, review facts,
checklists and issue drafts. Its implementation lives in the plugin repository under
`packages/github-operations/src/community-runtime.ts` and `src/business/domains/community/`.
GitHub remains the source of external PR and issue facts; plugin projections describe observations
and business state, not Host execution authority.

Host UI components call the plugin's declared actions through ordinary authenticated plugin routes.
The Host supplies generic message, member and Task data access subject to the same grants as other
plugins. It does not canonicalize GitHub review predicates, preflight review completion, maintain
GitHub review leases, or choose a reviewer or guardian for the plugin.

## User Journeys

- PR and issue operations use `gh`. Plugin MCP/actions expose tracking and community capabilities.
- Review work is assigned through ordinary mentions or Tasks. Review facts recorded by the plugin
  do not complete an unrelated Host task or grant execution authority.
- Notifications use ordinary messaging. Host conversation routing chooses recipients using the
  same rules as user messages; the plugin does not reject a notification based on a roster precheck.
- A guardian invitation names an explicit `guardianCatId`; it does not run an automatic family or
  availability matcher.
- Confirmed feedback passes the owner's selected title and body to the plugin's draft action.
  The feedback card displays that action's returned result. Draft storage and later publishing belong
  to the plugin, with publishing separately confirmed by the owner.

## Boundaries

Host feedback records retain their own content and status. They do not store or recover a GitHub
`communityIssueDraftId`, and no source-to-draft migration or compatibility lookup is required.
The plugin's event log and projections must not become a second Host custody or dispatch engine.
