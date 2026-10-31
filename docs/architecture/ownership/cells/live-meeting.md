---
doc_kind: architecture
cell_id: live-meeting
title: Scoped Live meeting control
summary: 当前 owner 明确原话、单 App F195 采集和私密 Live grant 的受限控制接点。
canonical_features: [F317, F195]
code_anchors:
  - packages/api/src/domains/concierge/meeting/live-meeting-control.ts
  - packages/api/src/domains/concierge/meeting/live-meeting-request-authority.ts
  - packages/api/src/domains/concierge/meeting/f317-meeting-share-service.ts
  - packages/api/src/routes/f317-live-meeting-control.ts
  - packages/api/src/routes/f317-meeting-control-bundle.ts
  - packages/api/src/routes/audio-proxy.ts
  - packages/mcp-server/src/tools/live-meeting-tools.ts
doc_anchors:
  - docs/features/F317-coactive-companion.md
  - feature-specs/2026-09-28-f317-parallel-closure.md
  - feature-specs/2026-10-08-f317-live-meeting-control.md
static_scan_hints: [LiveMeetingControl, createLiveMeetingRequestAuthority, createF317MeetingControlBundle, liveMeetingTools]
cited_by:
  - {feature: F317, date: 2026-10-08, delta: bounded E meeting control consumer under the original parallel scope}
feature_ids: [F317, F195]
created: 2026-10-08
mcp_admission_status: accepted
mcp_admission_ref: "architecture-cell:live-meeting"
mcp_admission_claims:
  - {ref: "architecture-cell:live-meeting", toolName: cat_cafe_meeting_sources, resourceFamily: live-meeting, boundaryKind: resource-entry, decision: accepted}
  - {ref: "architecture-cell:live-meeting", toolName: cat_cafe_meeting_start, resourceFamily: live-meeting, boundaryKind: resource-entry, decision: accepted}
  - {ref: "architecture-cell:live-meeting", toolName: cat_cafe_meeting_attach, resourceFamily: live-meeting, boundaryKind: resource-entry, decision: accepted}
  - {ref: "architecture-cell:live-meeting", toolName: cat_cafe_meeting_status, resourceFamily: live-meeting, boundaryKind: resource-entry, decision: accepted}
  - {ref: "architecture-cell:live-meeting", toolName: cat_cafe_meeting_stop, resourceFamily: live-meeting, boundaryKind: resource-entry, decision: accepted}
---

# Scoped Live meeting control

Scope is the existing F317 meeting journey and original E responsibility, now expressly parallel under operator
`[thread-id]#private-source-id` and
`[thread-id]#private-source-id`, materialized in parallel-closure `69a1c29407`.
Admission accepts these bounded resource entries, not implementation approval, runtime activation,
real media permission or whole-journey PASS. E authors this adapter; A retains composition single-write.

Architecture cell: live-meeting
Map delta: four callback endpoints and five separate MCP actions on the existing capture/share authorities.
Why: owner Live may control an explicitly identified meeting without gaining unrestricted audio/MCP access.
Canonical source: F195 audio-proxy owns the only lease; F317MeetingShareService owns the one private grant;
MessageStore + directOwner + isLatestOwnerMessage + complete accepted utterance own current human evidence.
No capture engine, permission ledger, transcript store or task registry is added.

Consumer evidence: `rg -n 'createF317MeetingControlBundle|f317LiveMeetingControlRoutes|liveMeetingTools' packages/api/src packages/mcp-server/src`.
The API/MCP/index/profile consumer is A's in-flight composition, not an E claim of a loaded production entry.
Claim guards: `f317-meeting-control-roundtrip.test.ts` exercises real MCP HTTP transport, callback auth,
Host MessageStore, real Fastify controller and single share service with a fake sidecar. Authority tests
reject foreign/stale/interrupted input and include preceding voice negation; control tests distinguish
recording from private listening, source ownership changes, repeated requests and stop/start races;
controller tests reject changed targets and competing starts. Profile tests exclude readonly/agent-key,
other desktop and the entire audio server. Existing source/feed/Host tests cover late transcript isolation.

Only one catalog App with exact stable ID (including opaque PID coordinate) is accepted. No mic, system
mix, added sources, owner/call/thread overrides, enrollment, correction, external sharing or meeting-platform
join is exposed. Start recording alone saves through F195; only explicit listen/attach grants the private
Live consumer. Status reports capture/input/PCM/ASR observations, not speech or transcription success.
Grant abort precedes detach/stop awaits; exact capture coordinates are checked against the same controller
lease, stop is confirmed by readback, and teardown errors remain unconfirmed. On call finish, only capture
created by this call is automatically stopped; attaching another already-recording session never acquires
automatic stop-on-hangup authority. Explicit stop still requires its source thread's current owner.

Source ambiguity asks for clarification without recording. Missing complete-utterance Host seams fail
closed. Live meeting permission is independent of household-read; A must expose only the exact meeting
tools when home reads are off. Native window/media tests remain separately coordinated and authorized.
