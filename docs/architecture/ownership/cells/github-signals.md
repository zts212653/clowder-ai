---
cell_id: github-signals
title: GitHub Work Item Signals
doc_kind: architecture
created: 2026-07-29
summary: GitHub 插件采集 PR/issue 事实、保存游标和跟踪条件，通过普通消息通知；Host 只提供通用 schedule、Task 数据和消息路由。
canonical_features: [F133, F140, F280, F202]
code_anchors:
  - packages/shared/src/types/task.ts
  - packages/api/src/domains/plugin/runtime-composition.ts
  - packages/api/src/domains/plugin/host-surface/plugin-conversation-delivery.ts
  - packages/api/src/infrastructure/github/gh-process.ts
  - packages/api/src/infrastructure/github/gh-cli-env.ts
doc_anchors:
  - docs/features/F202-plugin-framework.md
  - docs/architecture/plugin-architecture.md
cited_by: [F202]
static_scan_hints: [official.github-operations, createPluginConversationDelivery, gh-process]
---

# GitHub Work Item Signals

## Ownership

The `official.github-operations` plugin owns GitHub collection, snapshots, collector cursors,
tracking predicates and notification rendering. The plugin repository implements these paths in
`packages/github-operations/src/tracking-runtime.ts`, `typed-wait-runtime.ts` and their business modules.
GitHub is external truth. Stored observations and fingerprints support deduplication and tracking;
they do not authorize a merge or determine who owns a Host task.

## Delivery

Plugin schedules use the ordinary contribution lifecycle. A matching observation produces a normal
message in the configured thread. It passes through the same conversation admission, queue and
recipient resolution as a user message. An unknown, disabled or deleted mentioned member therefore
uses the existing ordinary-message fallback to a healthy participant; it does not discard the body
or create a plugin-specific wake-failure state.

Collection cursors and notification state belong to plugin storage. Task access remains the generic
Host data API with its existing authorization. Host does not expose a deployment catalog for narrator
prechecks or a GitHub review terminal-predicate/completion service.

## Boundaries

- Community projections and draft workflows belong to `community-ops` in the same plugin.
- Host conversation delivery owns routing and queue execution, without GitHub actor or repository
  policy branches.
- GitHub commands use the canonical `gh` transport. Tracking facts must distinguish an actual
  failing check from infrastructure jobs that never executed the check.
- Neither a notification nor successful collection proves that a review was delivered or a task
  was completed. Those facts come from the relevant action and ordinary work record.
