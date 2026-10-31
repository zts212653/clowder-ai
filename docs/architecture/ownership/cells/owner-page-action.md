---
doc_kind: architecture
cell_id: owner-page-action
title: Owner page action
summary: 获准页面的 Jev 候选选择、owner 一次性确认及原 Host/CDP 回读边界。
canonical_features: [F317]
code_anchors:
  - packages/api/src/domains/concierge/action/jev/ConfiguredJevPage.ts
  - packages/api/src/domains/concierge/action/jev/OwnerCurrentPageSource.ts
  - packages/api/src/domains/concierge/action/jev/JevPageSelector.ts
  - packages/api/src/domains/concierge/live/host/owner-page-action-service.ts
  - packages/api/src/domains/concierge/live/host/page-action/live-page-action-authority.ts
  - packages/api/src/domains/concierge/live/host/page-action/live-page-action-approval-ledger.ts
  - packages/api/src/routes/f317-live-page-action.ts
  - packages/mcp-server/src/tools/page-action-tools.ts
  - packages/api/src/utils/cli-spawn.ts
doc_anchors:
  - docs/features/F317-coactive-companion.md
  - project-runbooks/f317-jev-page-entry.md
static_scan_hints: [OwnerPageActionService, LivePageActionAuthority, LivePageActionApprovalLedger, JevPageSelector]
cited_by:
  - {feature: F317, date: 2026-10-08, delta: complete index metadata for the existing owner-page-action boundary}
feature_ids: [F317]
created: 2026-10-04
updated: 2026-10-08
mcp_admission_status: accepted
mcp_admission_ref: "architecture-cell:owner-page-action"
mcp_admission_claims:
  - ref: "architecture-cell:owner-page-action"
    toolName: cat_cafe_page_action_inspect
    resourceFamily: owner-page-action
    boundaryKind: resource-entry
    decision: accepted
  - ref: "architecture-cell:owner-page-action"
    toolName: cat_cafe_page_action_status
    resourceFamily: owner-page-action
    boundaryKind: resource-entry
    decision: accepted
---

# Owner page action

Scope admission comes from operator sources `private-source-id` and
`private-source-id`, materialized in main `455e3bd37f`, under the
existing A owner continuation `[thread-id]#private-source-id`.
This accepts a product resource entry; it does not claim implementation approval,
real voice acceptance, daily activation, or private-page export permission.

Architecture cell: owner-page-action

A owns Live/Host composition; original F retains PageActionLoop,
CDP commit fences, and approval-ledger authorship. The incremental A/F seam invokes
real Jev before exact owner consent and reuses that request-bound decision at execution.
Map delta: two invocation-bound inspection/status consumers. No callback confirmation,
arbitrary page/selector, shell, browser launch, navigation, or fallback model.
Why: Preview displays a result; it cannot select or execute an owner page action.

Canonical source: `LivePageActionAuthority` and `LivePageActionApprovalLedger` remain
the authority for scope, source revision, interruption epoch, grant, expiry and single use.
`OwnerPageActionService` remains the single owner consent lifecycle; the reviewed lab
profile still restores. The configured product profile retains effects until a new request.

Consumer evidence: `rg -n 'f317LivePageActionRoutes|readConfiguredPageAction|pageActionTools' packages/api/src/index.ts packages/api/src/routes/f317-live-page-action.ts packages/mcp-server/src/canonical-server-tools.ts`.
Claim guards: `f317-jev-product-journey.test.mjs` rejects a foreign invocation, callback
confirmation, caller-supplied source/URL, cancellation, amendment, replaced DOM and expired
consent; `f317-jev-selector.test.ts` rejects invented target/value, foreign/missing served
model, provider failure and oversized responses. `f317-live-front-desk.test.ts` checks
actual mounted tools and the household-off path. Implementation is not releasable until
the risk-matched non-author review and the affected checks pass.

The TypeSafe transport uses the official [HTTP contract](https://docs.typesafe.ai/api.md),
checked 2026-10-04: one bounded `POST /v1/systemone`, fixed HTTPS endpoint, bearer credential,
`jev-latest`, Choice questions and actual returned model. No research-script import,
retry, credential/body logging, DOM fingerprint, whole-page readback or screenshot export.
Only the direct request and configured, currently visible candidate labels are projected.
The common child-environment boundary strips the three API-owned Jev credential/config
variables from both ambient environment and overrides; invocation and model-account
credentials retain their existing rules.
The owner explicitly enables that projection in local configuration; ordinary private
pages, accounts, audio and screenshots remain outside this delivery authorization.

The candidate current-page continuation follows owner correction
`[thread-id]#private-source-id` under the same A046 responsibility.
Map delta: two owner-session HTTP read/selection consumers (`/pages`, `/select`) on the
existing guarded route, an opaque request-bound page choice and dynamically discovered
control candidates. The model has no page-selection or confirmation entry. Public B
schema/SDK and the original writer, authority, ledger and receipt owner do not move.

The browser configuration grants one existing loopback CDP endpoint and explicit label
projection. Tab containers permit transport discovery; only the chosen page ID is exposed.
The owner sees title/URL metadata before choosing, then only the selected page's bounded
visible control labels are projected. Generic click permits no expected business readback
only while retaining unknown/no_effect semantics; fill still requires known readback.
These read/contract deltas need independent review and do not inherit the old implementation
approval. `f317-current-page-browser.test.mjs` covers an unconfigured page, duplicate URLs,
same-DOM replacement, sensitivity/visibility change, cancellation and late model choice;
the original authority/ledger/route/CDP tests remain separate regression obligations.

Current-page invocation callbacks use an explicit observation projection at
`page-action/owner-page-action-invocation-view.ts`. Owner GET/consent retains the URL,
selectors and preview capability; callbacks expose request/state, bounded control labels,
Jev selection and result status without page coordinates, confirmation IDs or field readbacks.
Current-page result messages and native Live result context use the same observation projection;
the owner consent response and owner view retain the actual readbacks. Configured-page receipts
keep their existing contract.
The actor checks pointer-events and topmost hit eligibility both at discovery and after
the Host commit fence. A control's own descendant is eligible; unrelated overlays are not.
