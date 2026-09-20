import { type EvalLifecycleSpace, loadLifecycleSpaceMigrations, loadLifecycleSpaceRoots } from '../lifecycle-space.js';
import { deriveEvalCaseId } from '../publish-verdict/lifecycle-root-artifact.js';
import { projectReevalCase } from '../reeval-case.js';
import { loadReevalCaseRoot } from '../reeval-case-root.js';
import type { IReevalClosureEventLog } from '../reeval-closure-event-log.js';
import {
  availableCaseLifecycle,
  availableLifecycle,
  type ResolvedEvalVerdictLifecycleRoot,
} from './eval-hub-lifecycle-views.js';
import { loadDomains } from './eval-hub-read-model.js';
import type { EvalHubItem, EvalHubSummary } from './eval-hub-read-model-types.js';

export type { ResolvedEvalVerdictLifecycleRoot } from './eval-hub-lifecycle-views.js';

type LifecycleEventReader = Pick<IReevalClosureEventLog, 'read'>;

export interface EnrichEvalHubLifecycleOptions {
  /**
   * The reader's lifecycle space. The summary's runtime verdicts must be the reader's
   * own, so they belong to this space whenever it holds an artifact store.
   */
  space: EvalLifecycleSpace;
  /** The space's log; without one, items stay as the read model built them. */
  eventLog?: LifecycleEventReader;
  assignedEvalCatIds?: ReadonlyMap<string, string>;
}

export function loadEvalVerdictLifecycleRoots(
  space: EvalLifecycleSpace,
  assignedEvalCatIds?: ReadonlyMap<string, string>,
): Map<string, ResolvedEvalVerdictLifecycleRoot> {
  const domains = loadDomains(space.harnessFeedbackRoot);
  const artifacts = loadLifecycleSpaceRoots(space);

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
  space: EvalLifecycleSpace,
  verdictId: string,
  assignedEvalCatIds?: ReadonlyMap<string, string>,
): ResolvedEvalVerdictLifecycleRoot | undefined {
  return loadEvalVerdictLifecycleRoots(space, assignedEvalCatIds).get(verdictId);
}

function requiresAction(item: EvalHubItem): boolean {
  return (
    item.lifecycle.repairDebtStatus === 'active' ||
    item.lifecycle.reevalDebtStatus === 'due' ||
    item.lifecycle.reevalDebtStatus === 'in_progress'
  );
}

interface IndexedItem {
  /** Position in the summary, so projected items and items outside the space keep their order. */
  index: number;
  item: EvalHubItem;
}

interface SpaceLifecycle {
  space: EvalLifecycleSpace;
  eventLog: LifecycleEventReader;
}

async function enrichSpaceItems(
  spaceItems: readonly IndexedItem[],
  { space, eventLog }: SpaceLifecycle,
  generatedAt: string,
  assignedEvalCatIds: ReadonlyMap<string, string> | undefined,
): Promise<IndexedItem[]> {
  const roots = loadEvalVerdictLifecycleRoots(space, assignedEvalCatIds);
  const legacyMigrations = loadLifecycleSpaceMigrations(space);
  const stableCaseIds = new Set(
    [...roots.values()]
      .filter((root) => root.artifact.schemaVersion === 2)
      .map((root) => (root.artifact.schemaVersion === 2 ? root.artifact.caseId : '')),
  );
  const processedCaseIds = new Set<string>();
  const enriched: IndexedItem[] = [];
  for (const { index, item } of spaceItems) {
    const emit = (projected: EvalHubItem) => enriched.push({ index, item: projected });
    const root = roots.get(item.id);
    if (root?.artifact.schemaVersion === 3) {
      emit({
        ...item,
        lifecycle: {
          ...item.lifecycle,
          availability: 'unavailable',
          ownerResponseStatus: 'unavailable',
          closureStatus: 'unavailable',
          stale: false,
          unavailableReason: 'schema-v3 known but quarantined until Phase C cutover',
        },
      });
      continue;
    }
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
      emit(
        item.verdict === 'keep_observe'
          ? item
          : { ...item, lifecycle: { ...item.lifecycle, unavailableReason: 'immutable lifecycle root unavailable' } },
      );
      continue;
    }
    if (root.artifact.schemaVersion === 2) {
      const caseId = root.artifact.caseId;
      if (processedCaseIds.has(caseId)) continue;
      processedCaseIds.add(caseId);
      const candidates = spaceItems
        .map(({ item: candidate }) => ({ item: candidate, root: roots.get(candidate.id) }))
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
      const events = await eventLog.read(caseId);
      if (events.length > 0) {
        const resolved = loadReevalCaseRoot(
          space,
          representative.item.id,
          assignedEvalCatIds?.get(root.artifact.domainId),
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
      emit({
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
                space,
                representative.root,
                events,
                generatedAt,
                assignedEvalCatIds,
              ),
      });
      continue;
    }
    if (item.verdict === 'keep_observe') {
      emit(item);
      continue;
    }
    const events = await eventLog.read(item.id);
    emit(
      !events || events.length === 0
        ? { ...item, lifecycle: { ...item.lifecycle, unavailableReason: 'canonical lifecycle record not initialized' } }
        : { ...item, lifecycle: availableLifecycle(item, root, events, generatedAt) },
    );
  }
  return enriched;
}

/** Committed verdicts are the install's; runtime verdicts are the reader's own. */
function belongsToSpace(item: EvalHubItem, space: EvalLifecycleSpace): boolean {
  return item.source.kind === 'artifact' ? space.artifactStore !== undefined : space.kind === 'install';
}

function outsideSpace({ index, item }: IndexedItem): IndexedItem {
  if (item.verdict === 'keep_observe') return { index, item };
  const lifecycle = { ...item.lifecycle, unavailableReason: 'verdict lifecycle belongs to another lifecycle space' };
  return { index, item: { ...item, lifecycle } };
}

/**
 * Projects the lifecycles of the reader's space — every verdict in it, whichever store
 * holds it, from the space's roots and log — so a stable case is one item however its
 * cycles are stored. A verdict outside the reader's space is not the reader's
 * lifecycle and is not projected. Without a log, items stay as the read model built them.
 */
export async function enrichEvalHubLifecycle(
  summary: EvalHubSummary,
  options: EnrichEvalHubLifecycleOptions,
): Promise<EvalHubSummary> {
  const { space, eventLog } = options;
  if (!eventLog) return summary;
  const indexed = summary.items.map((item, index) => ({ index, item }));
  const projected = await enrichSpaceItems(
    indexed.filter(({ item }) => belongsToSpace(item, space)),
    { space, eventLog },
    summary.generatedAt,
    options.assignedEvalCatIds,
  );
  const outside = indexed.filter(({ item }) => !belongsToSpace(item, space)).map(outsideSpace);
  const items = [...projected, ...outside].sort((left, right) => left.index - right.index).map(({ item }) => item);

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
