import { loadLegacyReevalCaseMigrations, loadLifecycleRootsWithLegacyCases } from '../legacy-reeval-case-migration.js';
import { deriveEvalCaseId, type LifecycleRootArtifact } from '../publish-verdict/lifecycle-root-artifact.js';
import { projectReevalCase } from '../reeval-case.js';
import { loadReevalCaseRoot } from '../reeval-case-root.js';
import { projectReevalClosure, type ReevalClosureRoot } from '../reeval-closure.js';
import type { IReevalClosureEventLog } from '../reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from '../reeval-closure-schema.js';
import { projectLifecyclePresentation } from './eval-hub-lifecycle-debt.js';
import { loadDomains } from './eval-hub-read-model.js';
import type { EvalHubItem, EvalHubLifecycleView, EvalHubSummary } from './eval-hub-read-model-types.js';

export interface ResolvedEvalVerdictLifecycleRoot {
  artifact: LifecycleRootArtifact;
  projectorRoot: ReevalClosureRoot;
}

export interface EnrichEvalHubLifecycleOptions {
  harnessFeedbackRoot: string;
  eventLog?: Pick<IReevalClosureEventLog, 'read'>;
  assignedEvalCatIds?: ReadonlyMap<string, string>;
}

export function loadEvalVerdictLifecycleRoots(
  harnessFeedbackRoot: string,
  assignedEvalCatIds?: ReadonlyMap<string, string>,
): Map<string, ResolvedEvalVerdictLifecycleRoot> {
  const domains = loadDomains(harnessFeedbackRoot);
  const artifacts = loadLifecycleRootsWithLegacyCases(harnessFeedbackRoot);

  const roots = new Map<string, ResolvedEvalVerdictLifecycleRoot>();
  for (const artifact of artifacts) {
    const domain = domains.get(artifact.domainId);
    if (!domain) {
      throw new Error(`lifecycle root ${artifact.verdictId} references unregistered domain ${artifact.domainId}`);
    }
    roots.set(artifact.verdictId, {
      artifact,
      projectorRoot: {
        verdictId: artifact.verdictId,
        domainId: artifact.domainId,
        targetOwnerCatId: artifact.ownerAsk.targetOwnerCatId,
        assignedEvalCatId: assignedEvalCatIds?.get(artifact.domainId) ?? domain.evalCat.catId,
        reevalWithinHours: domain.sla.reevalWithinHours,
      },
    });
  }
  return roots;
}

export function loadEvalVerdictLifecycleRoot(
  harnessFeedbackRoot: string,
  verdictId: string,
  assignedEvalCatIds?: ReadonlyMap<string, string>,
): ResolvedEvalVerdictLifecycleRoot | undefined {
  return loadEvalVerdictLifecycleRoots(harnessFeedbackRoot, assignedEvalCatIds).get(verdictId);
}

function availableCaseLifecycle(
  item: EvalHubItem,
  harnessFeedbackRoot: string,
  root: ResolvedEvalVerdictLifecycleRoot,
  events: readonly EvalLifecycleEvent[],
  generatedAt: string,
  assignedEvalCatIds?: ReadonlyMap<string, string>,
): EvalHubLifecycleView {
  if (root.artifact.schemaVersion !== 2) throw new Error(`verdict ${item.id} does not belong to a stable case`);
  const resolved = loadReevalCaseRoot(harnessFeedbackRoot, item.id, assignedEvalCatIds?.get(root.artifact.domainId));
  if (!resolved) throw new Error(`stable case root unavailable for verdict ${item.id}`);
  const projection = projectReevalCase(resolved.projectorRoot, events);
  const activeRoot = resolved.roots.find((candidate) => candidate.verdictId === projection.activeVerdictId);
  const presentation = projectLifecyclePresentation(projection, generatedAt, activeRoot);
  return {
    availability: 'available',
    closureStatus: projection.status,
    ...presentation,
    sequence: projection.sequence,
    caseId: projection.caseId,
    activeVerdictId: projection.activeVerdictId,
    observedVerdictIds: [...projection.observedVerdictIds],
    targetOwnerCatId: projection.targetOwnerCatId,
    ...(projection.lifecycleOwnerCatId ? { lifecycleOwnerCatId: projection.lifecycleOwnerCatId } : {}),
    ...(projection.taskId ? { taskId: projection.taskId } : {}),
    ...(projection.leaseId ? { leaseId: projection.leaseId } : {}),
    ...(projection.leaseGeneration ? { leaseGeneration: projection.leaseGeneration } : {}),
    ...(projection.responsibilityBlocker
      ? {
          responsibilityBlocker: {
            ...projection.responsibilityBlocker,
            candidateThreadIds: [...projection.responsibilityBlocker.candidateThreadIds],
          },
        }
      : {}),
    ...(projection.mainCommitSha ? { mainCommitSha: projection.mainCommitSha } : {}),
    ...(projection.liveCommitSha ? { liveCommitSha: projection.liveCommitSha } : {}),
    ...(projection.reevalTaskId ? { reevalTaskId: projection.reevalTaskId } : {}),
    ...(projection.reevalLeaseId ? { reevalLeaseId: projection.reevalLeaseId } : {}),
    ...(projection.reevalLeaseGeneration ? { reevalLeaseGeneration: projection.reevalLeaseGeneration } : {}),
    ownerResponseRefs: [...projection.ownerResponseRefs],
    planRefs: [...projection.planRefs],
    actionRefs: [...projection.actionRefs],
    reevalRefs: [...projection.reevalRefs],
    unavailableRefs: projection.refs.filter((ref) => ref.availability === 'unavailable'),
    ...(projection.closureReason ? { closureReason: projection.closureReason } : {}),
    diagnosisTarget: diagnosisTarget(item, root.artifact),
  };
}

function diagnosisTarget(item: EvalHubItem, artifact: LifecycleRootArtifact) {
  return {
    featureId: artifact.harnessUnderEval.featureId,
    componentId: artifact.harnessUnderEval.componentId,
    name: artifact.harnessUnderEval.name,
    attributionRefs: [...item.evidence.attributionRefs],
    metricRefs: [...item.evidence.metricRefs],
  };
}

function requiresAction(item: EvalHubItem): boolean {
  return (
    item.lifecycle.repairDebtStatus === 'active' ||
    item.lifecycle.reevalDebtStatus === 'due' ||
    item.lifecycle.reevalDebtStatus === 'in_progress'
  );
}

function availableLifecycle(
  item: EvalHubItem,
  root: ResolvedEvalVerdictLifecycleRoot,
  events: readonly EvalLifecycleEvent[],
  generatedAt: string,
): EvalHubLifecycleView {
  const projection = projectReevalClosure(root.projectorRoot, events);
  const presentation = projectLifecyclePresentation(projection, generatedAt);
  return {
    availability: 'available',
    closureStatus: projection.status,
    ...presentation,
    sequence: projection.sequence,
    targetOwnerCatId: projection.targetOwnerCatId,
    ...(projection.lifecycleOwnerCatId ? { lifecycleOwnerCatId: projection.lifecycleOwnerCatId } : {}),
    ownerResponseRefs: [...projection.ownerResponseRefs],
    planRefs: [...projection.planRefs],
    actionRefs: [...projection.actionRefs],
    reevalRefs: [...projection.reevalRefs],
    unavailableRefs: projection.refs.filter((ref) => ref.availability === 'unavailable'),
    ...(projection.closureReason ? { closureReason: projection.closureReason } : {}),
    diagnosisTarget: diagnosisTarget(item, root.artifact),
  };
}

export async function enrichEvalHubLifecycle(
  summary: EvalHubSummary,
  options: EnrichEvalHubLifecycleOptions,
): Promise<EvalHubSummary> {
  if (!options.eventLog) return summary;
  const roots = loadEvalVerdictLifecycleRoots(options.harnessFeedbackRoot, options.assignedEvalCatIds);
  const legacyMigrations = loadLegacyReevalCaseMigrations(options.harnessFeedbackRoot);
  const stableCaseIds = new Set(
    [...roots.values()]
      .filter((root) => root.artifact.schemaVersion === 2)
      .map((root) => (root.artifact.schemaVersion === 2 ? root.artifact.caseId : '')),
  );
  const processedCaseIds = new Set<string>();
  const items: EvalHubItem[] = [];
  for (const item of summary.items) {
    const root = roots.get(item.id);
    const legacyCase = legacyMigrations.find(
      (migration) =>
        migration.domainId === item.domainId &&
        migration.selectors.some(
          (selector) =>
            selector.featureId === item.harnessUnderEval.featureId &&
            selector.componentId === item.harnessUnderEval.componentId,
        ),
    );
    if (
      legacyCase &&
      root?.artifact.schemaVersion !== 2 &&
      stableCaseIds.has(deriveEvalCaseId(legacyCase.domainId, legacyCase.findingKey))
    ) {
      continue;
    }
    if (!root) {
      if (item.verdict === 'keep_observe') {
        items.push(item);
        continue;
      }
      items.push({
        ...item,
        lifecycle: { ...item.lifecycle, unavailableReason: 'immutable lifecycle root unavailable' },
      });
      continue;
    }
    if (root.artifact.schemaVersion === 2) {
      const caseId = root.artifact.caseId;
      if (processedCaseIds.has(caseId)) continue;
      processedCaseIds.add(caseId);
      const candidates = summary.items
        .map((candidate) => ({ item: candidate, root: roots.get(candidate.id) }))
        .filter(
          (candidate): candidate is { item: EvalHubItem; root: ResolvedEvalVerdictLifecycleRoot } =>
            candidate.root?.artifact.schemaVersion === 2 && candidate.root.artifact.caseId === caseId,
        )
        .sort((left, right) => {
          if (left.root.artifact.schemaVersion !== 2 || right.root.artifact.schemaVersion !== 2) return 0;
          return (
            right.root.artifact.createdAt.localeCompare(left.root.artifact.createdAt) ||
            right.item.id.localeCompare(left.item.id)
          );
        });
      let representative = candidates[0];
      if (!representative) continue;
      const events = await options.eventLog.read(caseId);
      if (events.length > 0) {
        const resolved = loadReevalCaseRoot(
          options.harnessFeedbackRoot,
          representative.item.id,
          options.assignedEvalCatIds?.get(root.artifact.domainId),
        );
        if (!resolved) throw new Error(`stable case root unavailable for verdict ${representative.item.id}`);
        const projection = projectReevalCase(resolved.projectorRoot, events);
        if (
          representative.item.verdict === 'keep_observe' &&
          projection.status !== 'resolved' &&
          projection.status !== 'suppressed_with_reason'
        ) {
          representative =
            candidates.find((candidate) => candidate.item.id === projection.activeVerdictId) ?? representative;
        }
      }
      items.push({
        ...representative.item,
        lifecycle:
          events.length === 0
            ? {
                ...representative.item.lifecycle,
                stale: false,
                unavailableReason: 'canonical lifecycle record not initialized',
              }
            : availableCaseLifecycle(
                representative.item,
                options.harnessFeedbackRoot,
                representative.root,
                events,
                summary.generatedAt,
                options.assignedEvalCatIds,
              ),
      });
      continue;
    }
    if (item.verdict === 'keep_observe') {
      items.push(item);
      continue;
    }
    const events = await options.eventLog.read(item.id);
    if (!events || events.length === 0) {
      items.push({
        ...item,
        lifecycle: { ...item.lifecycle, unavailableReason: 'canonical lifecycle record not initialized' },
      });
      continue;
    }
    items.push({ ...item, lifecycle: availableLifecycle(item, root, events, summary.generatedAt) });
  }
  const domains = summary.domains?.map((domain) => {
    const representative = items.find((item) => item.domainId === domain.domainId);
    if (!representative || domain.latestVerdictId === representative.id) return domain;
    return { ...domain, latestVerdictId: representative.id, latestVerdict: representative.verdict };
  });
  return {
    ...summary,
    ...(domains ? { domains } : {}),
    counts: {
      ...summary.counts,
      total: items.length,
      actionable: items.filter(requiresAction).length,
      keepObserve: items.filter((item) => item.verdict === 'keep_observe').length,
      stale: items.filter((item) => item.lifecycle.stale).length,
    },
    items,
  };
}
