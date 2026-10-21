---
feature_ids: [F292]
related_features: [F141, F168, F195, F202, F240, F285, F288, F290, F310]
topics: [feishu, lark, meeting-intake, plugin, input-source, signal-ingress, needs-me, transcript]
doc_kind: spec
created: 2026-08-08
updated: 2026-10-18
architecture-cell: plugin, signal-intake, approval-index
community_issue: "clowder-ai-plugins#23"
description: "飞书生成会议文字稿后，官方 input-source 插件把它变成可恢复的 Meeting Intake；人只补说话人、背景与去向，猫带着家里记忆产出纪要、决定、Roadmap 或任务。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-24T19:40:00Z
tips_exempt: "The existing feature-f292-feishu-meeting-intake tip already opens this capability; search and in-place Thread creation are contextual actions inside its existing Needs Me card."
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/features/F292-feishu-meeting-intake-plugin.md"
mcp_admission_claims:
  - ref: "file:docs/features/F292-feishu-meeting-intake-plugin.md"
    toolName: cat_cafe_meeting_records_read
    resourceFamily: meeting-artifact
    boundaryKind: resource-entry
    decision: accepted
---

# F292: Feishu Meeting Intake Plugin — 会后产物不再靠人搬运

## Behavior and Acceptance

The installed meeting plugin owns Feishu/Lark access, catch-up cursors, retained records and its
pending notification queue. It reads the configured `notificationThreadId` with ordinary
`threads.get`, then delivers a structured notification with `messaging.send`. Successful delivery
is recorded in the package; retries use the same notification identity. Its pending record type
and closed validation are local to the package, not a public event protocol.

The installed `cat_cafe_meeting_records_read` contribution reads retained records. It does not
provide the retired Host artifact tool or its historical snapshot/lease protocol. Host keeps the
ordinary Plugin Manager, lifecycle, client, message store and existing queue-to-memory consumer.
The package's credentials, source records and prior notification data are not reset by this change.

Current code: `clowder-ai-plugins/packages/feishu-meeting-intake/src/plugin-entrypoint.ts`,
`artifact.ts`, `state-store.ts` and the retained-record delivery implementation. The canonical
public contract is `clowder-ai-plugins/docs/plugin-development.md` (three sections only).

- [x] C1-A1: Current package uses ordinary message delivery and package-private pending state;
  notifications use the same Host message path as other plugins.
- [x] C1-A2: Package business/module tests cover notification validation, persistence and delivery;
  Host consumer tests exercise the installed-package boundary.
- [ ] C1-A3: Final operator experience and real-account acceptance remain distinct from automated
  package/Host tests. Automated checks do not establish the installed version or account availability.

The older public releases require a retired capability and are not installable by the current Host.
Existing installations remain visible but unavailable, with their configuration and data preserved.
A compatible public release is not yet available in the Host catalog.

## User Journey

Scope: one installed meeting-plugin instance and its configured notification thread.

1. In the plugin's Settings, authorize the Feishu/Lark account and select the notification thread.
2. Enable collection or invoke the package's collection action. The plugin retains source records
   and its pending notification state in its own data directory.
3. The plugin sends a structured notification to that ordinary Host thread. A failed delivery stays
   visible in the package's record list and can be retried without inventing a second Host intake.
4. Read a retained record through the installed meeting-record tool; the cat uses the normal thread
   workflow to respond. This automated path is distinct from pending real-account/operator acceptance.

## Architecture Ownership

Architecture cell: plugin, signal-intake, approval-index, mcp-surface-governance

The plugin cell owns generic Host integration. Meeting business belongs to the external package;
`signal-intake` documents the retained message-to-memory reader and the superseded Host design.
Any retained UI/Needs Me presentation is not evidence that the removed Host signal service exists.
MCP governance owns tool identity; the installed package owns the current record-reader behavior.

## Non-Goals and Limits

The plugin handles Feishu-generated meeting records, not local audio capture or arbitrary transcript
storage in Host. Reading records does not replace the cat's interpretation or the user's decisions.
Collection, credentials and retry state remain package-owned. Real-account experience, publication and
catalog admission require their own acceptance; automated tests do not establish those results.

## References

- [Plugin interfaces and ownership](F202-plugin-framework.md)
- [Meeting boundary](../architecture/ownership/cells/signal-intake.md)

Prior Host intake designs and acceptance checkpoints remain in Git history and independent audit records.
They do not define the installed plugin's current behavior.
