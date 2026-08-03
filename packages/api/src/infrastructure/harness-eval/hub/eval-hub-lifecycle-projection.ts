import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildCapabilityWakeupClosureImport } from '../capability-wakeup-closure-import.js';
import { type LifecycleRootArtifact, scanLifecycleRootArtifacts } from '../publish-verdict/lifecycle-root-artifact.js';
import { projectReevalCase, type ReevalCaseProjection } from '../reeval-case.js';
import { loadReevalCaseRoot } from '../reeval-case-root.js';
import { projectReevalClosure, type ReevalClosureProjection, type ReevalClosureRoot } from '../reeval-closure.js';
import type { IReevalClosureEventLog } from '../reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from '../reeval-closure-schema.js';
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
  const artifacts = scanLifecycleRootArtifacts(harnessFeedbackRoot);
  const historical = buildCapabilityWakeupClosureImport();
  const historicalVerdictPath = join(harnessFeedbackRoot, 'verdicts', `${historical.root.verdictId}.md`);
  if (
    existsSync(historicalVerdictPath) &&
    !artifacts.some((artifact) => artifact.verdictId === historical.root.verdictId)
  ) {
    artifacts.push(historical.root);
  }

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

type LifecyclePresentation = Pick<
  EvalHubLifecycleView,
  'ownerResponseStatus' | 'reevalStatus' | 'reevalDueAt' | 'escalation' | 'stale'
>;

function latestReevalResult(
  projection: ReevalClosureProjection | ReevalCaseProjection,
): NonNullable<EvalHubLifecycleView['reevalStatus']> {
  const activeVerdictId = 'activeVerdictId' in projection ? projection.activeVerdictId : undefined;
  for (let index = projection.history.length - 1; index >= 0; index -= 1) {
    const event = projection.history[index];
    if (activeVerdictId && event?.verdictId !== activeVerdictId) continue;
    const type = event?.type;
    if (type === 'reeval_passed') return 'passed';
    if (type === 'reeval_failed') return 'failed';
  }
  return 'not_requested';
}

function lifecyclePresentation(
  projection: ReevalClosureProjection | ReevalCaseProjection,
  generatedAt: string,
): LifecyclePresentation {
  const suppressed = projection.status === 'suppressed_with_reason';
  const activeReeval =
    projection.status === 'reeval_pending' ||
    (projection.status === 'escalated' && projection.escalation?.stage === 'reevaluation');
  const reevalStatus = suppressed ? 'not_required' : activeReeval ? 'pending' : latestReevalResult(projection);
  const stale =
    projection.status === 'escalated' ||
    (projection.status === 'reeval_pending' &&
      projection.reevalDueAt !== undefined &&
      Date.parse(generatedAt) >= Date.parse(projection.reevalDueAt));
  return {
    ownerResponseStatus: suppressed ? 'not_required' : projection.lifecycleOwnerCatId ? 'acknowledged' : 'not_started',
    reevalStatus,
    stale,
    ...(activeReeval && projection.reevalDueAt ? { reevalDueAt: projection.reevalDueAt } : {}),
    ...(projection.status === 'escalated' && projection.escalation ? { escalation: projection.escalation } : {}),
  };
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
  const presentation = lifecyclePresentation(projection, generatedAt);
  const ownerResponseRefs = projection.history
    .filter((event) => event.type === 'responsibility_bound' && event.verdictId === projection.activeVerdictId)
    .flatMap((event) => event.refs);
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
    ...(projection.mainCommitSha ? { mainCommitSha: projection.mainCommitSha } : {}),
    ...(projection.liveCommitSha ? { liveCommitSha: projection.liveCommitSha } : {}),
    ownerResponseRefs,
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
  if (item.verdict === 'keep_observe') return false;
  return item.lifecycle.closureStatus !== 'resolved' && item.lifecycle.closureStatus !== 'suppressed_with_reason';
}

function availableLifecycle(
  item: EvalHubItem,
  root: ResolvedEvalVerdictLifecycleRoot,
  events: readonly EvalLifecycleEvent[],
  generatedAt: string,
): EvalHubLifecycleView {
  const projection = projectReevalClosure(root.projectorRoot, events);
  const presentation = lifecyclePresentation(projection, generatedAt);
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
  const processedCaseIds = new Set<string>();
  const items: EvalHubItem[] = [];
  for (const item of summary.items) {
    const root = roots.get(item.id);
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
