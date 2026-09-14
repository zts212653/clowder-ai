import { resolve } from 'node:path';
import type { EvaluationUnitRef, MetricDefinition } from '@cat-cafe/shared';
import { loadObjectiveRegistry, type ObjectiveRegistry } from '../objective-registry.js';
import { loadUnitEvaluationManifest, type UnitEvaluationManifest } from '../unit-evaluation-manifest.js';

export interface EvaluationCatalog {
  registry: ObjectiveRegistry;
  manifest: UnitEvaluationManifest;
}

export interface EvaluationCoordinate {
  objectiveId: string;
  metricId: string;
  unitRefs: EvaluationUnitRef[];
}

export async function loadEvaluationCatalog(
  projectRoot: string,
): Promise<{ ok: true; catalog: EvaluationCatalog } | { ok: false; error: string }> {
  const registry = await loadObjectiveRegistry(
    resolve(projectRoot, 'docs', 'harness-feedback', 'objectives', 'registry.yaml'),
  );
  if (!registry.ok) return registry;
  const manifest = await loadUnitEvaluationManifest(
    resolve(projectRoot, 'docs', 'harness-feedback', 'objectives', 'unit-evaluation-manifest.yaml'),
    registry.registry,
  );
  if (!manifest.ok) return manifest;
  return { ok: true, catalog: { registry: registry.registry, manifest: manifest.manifest } };
}

/**
 * Re-read `unit-evaluation-manifest.yaml` into a live catalog in place. The
 * catalog object is the process-wide holder shared by every constructor-
 * injected reader (runtime, executor, describer, read models): its identity
 * never changes, only `manifest` does. Called from the governance
 * `reloadPipeline` seam so a hook directory write (registry rescan) and the
 * unit-manifest append are observed together — memory follows disk, no reader
 * keeps a startup snapshot.
 *
 * `registry` (Objective / evaluation-model definitions) is deliberately NOT
 * re-read. A cycle freezes an Objective version ref, but assignment,
 * submission validation and trigger counting resolve the model from the live
 * registry (KD-22: before/after keep one evaluator model version). Hot-swapping
 * it here would let an unrelated governance action change every Objective's
 * metrics mid-cycle; a versioned registry reload is a separate design.
 *
 * On failure the previous manifest stays in place and the error is returned;
 * the caller decides how to surface it.
 */
export async function reloadEvaluationUnits(
  catalog: EvaluationCatalog,
  projectRoot: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const manifest = await loadUnitEvaluationManifest(
    resolve(projectRoot, 'docs', 'harness-feedback', 'objectives', 'unit-evaluation-manifest.yaml'),
    catalog.registry,
  );
  if (!manifest.ok) return manifest;
  catalog.manifest = manifest.manifest;
  return { ok: true };
}

export function findMetricDefinition(
  catalog: EvaluationCatalog,
  objectiveId: string,
  metricId: string,
): { metric: MetricDefinition; ruleVersion: string } | null {
  const objective = catalog.registry.objectives.find((definition) => definition.id === objectiveId);
  if (!objective) return null;
  const model = catalog.registry.evaluationModels.find((definition) => definition.id === objective.evaluationModelId);
  const metric = model?.metrics.find((definition) => definition.id === metricId);
  return metric && model ? { metric, ruleVersion: model.ruleVersion } : null;
}

export function validateEvaluationCoordinate(
  catalog: EvaluationCatalog,
  coordinate: EvaluationCoordinate,
): string | null {
  const objective = catalog.registry.objectives.find((definition) => definition.id === coordinate.objectiveId);
  if (!objective) return `unknown objectiveId "${coordinate.objectiveId}"`;
  if (objective.lifecycle === 'retired') return `Objective "${coordinate.objectiveId}" is retired`;
  if (!findMetricDefinition(catalog, coordinate.objectiveId, coordinate.metricId)) {
    return `metricId "${coordinate.metricId}" does not belong to Objective "${coordinate.objectiveId}"`;
  }

  for (const unitRef of coordinate.unitRefs) {
    const unit = catalog.manifest.units.find((definition) => definition.unitId === unitRef.unitId);
    if (!unit) return `unknown segment unitId "${unitRef.unitId}"`;
    const matches = unit.objectives.some(
      (attachment) => attachment.objectiveId === coordinate.objectiveId && unitRef.clauseId === undefined,
    );
    if (!matches) {
      const unitCoordinate = `${unitRef.unitId}${unitRef.clauseId ? `.${unitRef.clauseId}` : ''}`;
      return `segment coordinate "${unitCoordinate}" is not attached to Objective "${coordinate.objectiveId}"`;
    }
  }
  return null;
}
