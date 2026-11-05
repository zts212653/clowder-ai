---
cell_id: signal-intake
title: Meeting Intake Boundary
doc_kind: architecture
created: 2026-08-08
summary: Retained meeting-message and memory-consumption boundary; C1 meeting collection, pending notifications and records are plugin-owned and use ordinary messaging.
canonical_features: [F292]
code_anchors:
  - packages/shared/src/types/signal-ingress.ts
  - packages/shared/src/types/meeting-intake.ts
  - packages/api/src/domains/signal-intake/AsrPersonMemoryQueueCarrier.ts
  - packages/shared/src/types/memory-write-opportunity.ts
doc_anchors:
  - docs/features/F292-feishu-meeting-intake-plugin.md
static_scan_hints: [bindAsrPersonMemoryScenesFromQueueMessage, meetingArtifact, signal-ingress, meeting-intake]
cited_by:
  - {feature: F292, date: 2026-08-08, delta: "new Host-side cell separates durable external-signal truth from plugin lifecycle and source-specific collectors"}
  - {feature: F292, date: 2026-08-10, delta: "Historical K-2B checkpoint, superseded by C1 ordinary messaging; no current public event publication adapter"}
  - {feature: F276, date: 2026-08-15, delta: "confirmed meeting artifacts may emit one bounded mechanical WriteOpportunity scene and exact owner-message carrier; memory retains all judgment and destination authority"}
  - {feature: F292, date: 2026-08-24, delta: "source-owned transcript bytes are consumed through one version-fenced bounded reader; initial cat delivery becomes a provider-authored refs-only envelope"}
---

# Meeting Intake Boundary

Architecture cell: signal-intake

## Current C1 Ownership

Meeting collection, account access, catch-up cursors, retained records, pending notification data
and retries belong to `clowder-ai-plugins/packages/feishu-meeting-intake`. Its module entrypoint
uses the configured `notificationThreadId`, reads it with ordinary `threads.get`, and sends the
record notification through `messaging.send` with structured metadata. The package persists its
notification receipt and retry state. It does not call a separate Host event-publication port.

The `plugin` cell owns the ordinary Host client, manifest admission, configuration and lifecycle.
The public API baseline is `clowder-ai-plugins/docs/plugin-development.md`. Signal declaration
schemas are static manifest metadata; they do not establish an event bus or a second dispatch path.
Meeting record reads use the installed plugin's `cat_cafe_meeting_records_read` contribution.

The remaining Host code anchors below describe retained message types and the live queue-to-memory
binding. `AsrPersonMemoryQueueCarrier` consumes an already persisted message and binds eligible
scenes to that exact message. It neither collects meetings nor restores the former intake router.
Memory judgment and destination authority remain with the `memory` cell.

## Current Extension Points

- Evolve collection, records, pending validation and source-specific recovery in the meeting package.
- Reuse ordinary messages for user/Agent-visible notification; keep package-only state in its store.
- Preserve existing message/record data and reference semantics; reading this cell is not permission
  to migrate or delete user data.
- Change the Host queue-to-memory reader only for its existing message-consumption responsibility.
- Keep plugin activation separate from notification delivery and from memory judgment.

## Superseded Host Intake Design

The 2026-08 K-2B/K-3a admission, source-lease, durable-intake and Needs Me design is a historical
checkpoint, superseded for C1 by the package path above. Its removed services and routes are not
code anchors or static-scan hints. The original design remains in Git history and the explicitly
historical sections of F292; it is not a current SDK requirement or an available Host transport.
