---
cell_id: harness-eval
title: Harness Eval Control Plane
summary: Harness contract、runtime eval、verdict handoff、domain registry、legacy scheduled-task migration 与 re-eval closure。
canonical_features: [F192]
code_anchors:
  - packages/api/src/infrastructure/harness-eval/f167-eval.ts
  - packages/api/src/infrastructure/harness-eval/attribution.ts
  - packages/api/src/infrastructure/harness-eval/eval-domain-registry.ts
  - packages/api/src/infrastructure/harness-eval/verdict-handoff.ts
  - packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts
  - packages/api/src/infrastructure/harness-eval/legacy-task-cleanup.ts
  - packages/api/src/infrastructure/harness-eval/reeval-closure.ts
  - packages/api/src/infrastructure/harness-eval/eval-a2a-adapter.ts
  - packages/api/src/infrastructure/harness-eval/eval-hub-read-model.ts
  - packages/api/src/routes/eval-hub.ts
  - packages/web/src/components/HubEvalTab.tsx
  - sop-definitions/development.yaml
  - sop-definitions/stubs/video-cocreation.yaml
  - sop-definitions/stubs/tech-article.yaml
  - sop-definitions/stubs/family-office.yaml
  - scripts/sop-definitions.mjs
  - scripts/lib/sop-definition-codegen.mjs
  - packages/shared/src/types/sop-definition.generated.ts
doc_anchors:
  - docs/features/F192-socio-technical-harness-eval.md
  - docs/harness-feedback/
  - feature-discussions/2026-05-21-f192-phase-e-eval-hub-kickoff/README.md
  - sop-definitions/README.md
static_scan_hints: [harness-eval, VerdictHandoffPacket, eval-domain, reeval, harness-fit-digest, Eval Hub, SopDefinition, sop-definitions, predicate]
cited_by:
  - F192 Phase E-pilot
---

# Harness Eval Control Plane

## Canonical Owner

F192 owns the socio-technical harness evaluation contract: harnesses declare expected behavior, runtime eval observes actual behavior, attribution explains gaps, verdict packets hand off evidence to feature owners, and later eval verifies closure.

## Use This When

- Adding or changing an Eval Contract for a harness, skill, MCP tool, SOP, or shared rule.
- Adding or changing a SOP stage definition or predicate-backed hard rule.
- Adding an eval domain registry entry such as `eval:a2a` or `eval:memory`.
- Producing or validating Verdict Handoff Packets.
- Migrating legacy scheduled tasks into unified eval runtime.
- Deciding whether a harness should `fix`, `build`, `keep_observe`, or `delete_sunset`.

## Extend By

- Add domain-specific adapters under `packages/api/src/infrastructure/harness-eval/`.
- Keep raw telemetry ownership in F153; this cell consumes telemetry and produces derived verdicts.
- Keep domain thread text as working context only; registry, snapshots, verdicts, and closure records are the state source of truth.
- Require dry-run evidence before disabling or redirecting legacy scheduled tasks.

## Do NOT Unify With

- Do not move canonical trace storage out of F153 into this cell.
- Do not replace F188 Health Dashboard or F200 memory recall metrics here; consume them as domain inputs.
- Do not treat Eval Hub as a metrics dashboard. A surfaced item must have verdict, owner ask, and re-eval plan.

## Static Scan Hints

Watch for new `eval:*` domains, `VerdictHandoffPacket`, `harness-fit-digest`, `delete_sunset`, `reeval`, `legacy scheduled task`, `harness-feedback`, `SopDefinition`, `sop-definitions`, and `predicate` artifacts.
