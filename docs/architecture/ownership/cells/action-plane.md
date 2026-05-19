---
cell_id: action-plane
title: Action Plane
summary: 外部动作的 typed service、CLI executor、callback route、权限、审计、dry-run 与资源句柄。
canonical_features: [ADR-029, F162]
code_anchors:
  - packages/api/src/infrastructure/enterprise/WeComActionService.ts
  - packages/api/src/infrastructure/enterprise/WeComCliExecutor.ts
  - packages/api/src/infrastructure/enterprise/LarkActionService.ts
  - packages/api/src/infrastructure/enterprise/LarkCliExecutor.ts
  - packages/api/src/routes/callback-wecom-action-routes.ts
  - packages/api/src/routes/callback-lark-action-routes.ts
doc_anchors:
  - docs/decisions/029-external-tool-integration-strategy.md
  - docs/features/F162-enterprise-action-toolkit.md
static_scan_hints: [ActionService, CliExecutor, callback-action, dry-run, audit, idempotency, resource handle]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
---

# Action Plane

## Canonical Owner

ADR-029 owns the external tool integration strategy: typed `ActionService` is the governance boundary, execution backend is chosen below it, and callback/import/MCP exposure is chosen above it. F162 is the first concrete implementation for WeCom and Lark.

## Use This When

- Adding or changing an external operation that creates or mutates resources such as docs, tasks, meetings, slides, tables, files, or workflow artifacts.
- Adding a vendor CLI executor, SDK/API client, callback route, audit log, dry-run behavior, idempotency key, or resource handle persistence.
- Deciding whether a capability belongs in a connector adapter, callback route, direct TypeScript service, or MCP wrapper.

## Extend By

- Add a typed `ActionService` method as the stable programming interface before exposing a new operation to cats or Hub.
- Use `CliExecutor`, direct `execFile`, SDK, or API client according to ADR-029 backend rules.
- Expose through callback routes for local cats, direct imports for Hub internals, and MCP only when cross-process callers truly need it.
- Keep permissions, audit, dry-run, idempotency, and error normalization inside the service boundary.

## Do NOT Unify With

- Do not put enterprise operations into F088 connector adapters. Transport Plane moves messages; Action Plane mutates external resources.
- Do not create an MCP wrapper only for governance or capability discovery. Governance belongs in `ActionService`; vendor CLI/help and skills provide discovery.
- Do not let cats bypass ActionService by shelling out directly when a service route exists; that loses audit and permission boundaries.
- Do not generalize a common ActionService interface before two concrete services prove the shared shape.

## Static Scan Hints

Watch for new or renamed `ActionService`, `CliExecutor`, `callback-*-action`, `dryRun`, `audit`, `idempotency`, `resourceHandle`, `wecom-cli`, `lark-cli`, and external mutation code.
