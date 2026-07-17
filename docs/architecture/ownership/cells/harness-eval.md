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
  - packages/api/src/infrastructure/harness-eval/session-recovery/
  - packages/api/src/infrastructure/harness-eval/publish-verdict/session-recovery-generator-adapter.ts
  - packages/api/src/routes/session-recovery-eval.ts
  - packages/mcp-server/src/tools/session-recovery-eval-tools.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-signal-source.ts
  - packages/api/src/infrastructure/harness-eval/friction/paw-feel-marker.ts
  - packages/api/src/infrastructure/harness-eval/friction/paw-feel-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/cancel-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/user-feedback-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/eval-domain-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-aggregator.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-clusterer.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-rollup-input.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-rollup-report.ts
  - packages/shared/src/types/friction-signal.ts
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
  - docs/features/F245-friction-signal-eval.md
  - feature-specs/2026-07-16-f192-session-recovery-eval.md
  - docs/harness-feedback/eval-domains/eval-session-recovery.yaml
  - docs/harness-feedback/
  - feature-discussions/2026-05-21-f192-phase-e-eval-hub-kickoff/README.md
  - sop-definitions/README.md
static_scan_hints: [harness-eval, VerdictHandoffPacket, eval-domain, reeval, harness-fit-digest, Eval Hub, SopDefinition, sop-definitions, predicate, friction, paw-feel, FrictionSignal, SessionRecoveryTrial, session-recovery-window, continuedFromSessionId]
cited_by:
  - F192 Phase E-pilot
  - F192 Phase I session-recovery eval
  - F245 Phase A (paw-feel friction collector) + Phase B (cancel/user-feedback/eval-domain adapters + aggregator + clusterer + rollup input; domain registration + rollup sink land in Phase C)
---

# Harness Eval Control Plane

## Canonical Owner

F192 owns the socio-technical harness evaluation contract: harnesses declare expected behavior, runtime eval observes actual behavior, attribution explains gaps, verdict packets hand off evidence to feature owners, and later eval verifies closure.

## Use This When

- Adding or changing an Eval Contract for a harness, skill, MCP tool, SOP, or shared rule.
- Adding or changing a SOP stage definition or predicate-backed hard rule.
- Adding an eval domain registry entry such as `eval:a2a` or `eval:memory`.
- Adding a target-centric session recovery eval such as `eval:session-recovery`, including bounded preview, semantic assessment, sanitized bundle, and verdict publish contracts.
- Producing or validating Verdict Handoff Packets.
- Migrating legacy scheduled tasks into unified eval runtime.
- Deciding whether a harness should `fix`, `build`, `keep_observe`, or `delete_sunset`.

## Extend By

- Add domain-specific adapters under `packages/api/src/infrastructure/harness-eval/`.
- Keep raw telemetry ownership in F153; this cell consumes telemetry and produces derived verdicts.
- For session recovery, consume the target Session's immutable `openedByInvocationId` / `continuedFromSessionId` and canonical transcript event refs from `identity-session`; keep trials derived and owner-scoped instead of adding attempt/receipt state or a second transition store.
- Let the eval cat select the first substantive opening-invocation event and submit its ref; providers validate anchor ownership but do not assign semantic meaning from event type. Filtered target scans must page to completion or report `window_too_broad`, never silently truncate the population.
- Cross-cat recovery evidence must use the F192 evaluator-authorized reader: admit only the registry/OQ-20 override evaluator, re-resolve selector + trialId in the principal's owner scope, expose only fixed source/opening views, and derive Session/invocation coordinates server-side. Opening-event reads and publish allowlists share one bound. Never weaken generic transcript routes' per-cat boundary. Treat missing semantic transcript anchors as `400 invalid_assessment`, not infrastructure 500.
- Keep domain thread text as working context only; registry, snapshots, verdicts, and closure records are the state source of truth.
- Require dry-run evidence before disabling or redirecting legacy scheduled tasks.

## Do NOT Unify With

- Do not move canonical trace storage out of F153 into this cell.
- Do not replace F188 Health Dashboard or F200 memory recall metrics here; consume them as domain inputs.
- Do not treat Eval Hub as a metrics dashboard. A surfaced item must have verdict, owner ask, and re-eval plan.
- Do not let session-recovery grading create, infer, or repair session lineage. Minimal target backlink truth belongs to `identity-session`; deterministic transition/delivery behavior belongs to runtime tests; this cell only projects observed targets, validates semantic assessments, grades, and publishes evidence.

## Static Scan Hints

Watch for new `eval:*` domains, `VerdictHandoffPacket`, `harness-fit-digest`, `delete_sunset`, `reeval`, `legacy scheduled task`, `harness-feedback`, `SessionRecoveryTrial`, `continuedFromSessionId`, `SopDefinition`, `sop-definitions`, and `predicate` artifacts.
