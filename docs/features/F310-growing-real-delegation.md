---
feature_ids:
  - F310
topics:
  - mcp-governance-evidence
doc_kind: mcp-evidence
description: Public MCP governance evidence projection for F310.
description_source: model
description_author: codex-sol
tips_exempt: Derived governance evidence only; no new public user workflow.
mcp_admission_status: accepted
mcp_admission_ref: file:docs/features/F310-growing-real-delegation.md
mcp_admission_claims:
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_resolve_development_work
    resourceFamily: task-workflow
    boundaryKind: authority-boundary
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_read_development_return
    resourceFamily: task-workflow
    boundaryKind: authority-boundary
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_development_work
    resourceFamily: task-workflow
    boundaryKind: authority-boundary
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_development_return
    resourceFamily: task-workflow
    boundaryKind: authority-boundary
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_update_task
    resourceFamily: task-workflow
    boundaryKind: side-effect-boundary
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_read_entrusted_work
    resourceFamily: task-workflow
    boundaryKind: progressive-disclosure
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_update_entrusted_work
    resourceFamily: task-workflow
    boundaryKind: authority-boundary
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_admit_entrusted_work
    resourceFamily: task-workflow
    boundaryKind: authority-boundary
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_close_entrusted_work
    resourceFamily: task-workflow
    boundaryKind: destructive-boundary
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_offer_custody
    resourceFamily: source-custody
    boundaryKind: resource-entry
    decision: accepted
  - ref: file:docs/features/F310-growing-real-delegation.md
    toolName: cat_cafe_retry_custody_admission
    resourceFamily: source-custody
    boundaryKind: resource-entry
    decision: accepted
---

# F310 MCP governance evidence

This public projection contains only source-accepted MCP admission or selector claims. Product history and private operating context remain in the source repository.
