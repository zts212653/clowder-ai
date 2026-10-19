import {
  type EvolutionArchivePublicationV1,
  type EvolutionExplorationSelectionV1,
  type EvolutionResolvedExplorationReviewV1,
  refIdentity,
} from '@cat-cafe/shared';
import {
  harnessHistoryDetailReadingIdentity,
  harnessHistoryExperimentReadingIdentity,
  harnessHistoryNodeReadingIdentity,
  sameLogicalExplorationRef,
} from './harness-history-reading-identity.js';

type Catalog = EvolutionResolvedExplorationReviewV1;
type Ref = Catalog['sourceRef'];
type UpdateKind = 'unchanged' | 'modified' | 'moved';
type ExperimentSelectionKey = 'selectedExperimentRef' | 'comparisonExperimentRef';

function mapExperimentSelection(
  key: ExperimentSelectionKey,
  selected: Ref,
  previous: Catalog,
  current: Catalog,
  next: EvolutionExplorationSelectionV1,
  priorKind: UpdateKind,
): UpdateKind | 'removed' {
  const oldExperiment = previous.experiments.find((item) => refIdentity(item.experimentRef) === refIdentity(selected));
  const newExperiment = current.experiments.find((item) => sameLogicalExplorationRef(item.experimentRef, selected));
  if (!oldExperiment || !newExperiment) return 'removed';
  next[key] = newExperiment.experimentRef;
  let kind = priorKind;
  if (!sameLogicalExplorationRef(oldExperiment.nodeRef, newExperiment.nodeRef)) {
    if (key === 'comparisonExperimentRef') return 'removed';
    next.selectedNodeRef = newExperiment.nodeRef;
    kind = 'moved';
  }
  const oldDetail = previous.details.find((item) => refIdentity(item.experimentRef) === refIdentity(selected));
  const newDetail = current.details.find(
    (item) => refIdentity(item.experimentRef) === refIdentity(newExperiment.experimentRef),
  );
  if (
    kind === 'unchanged' &&
    (JSON.stringify(harnessHistoryExperimentReadingIdentity(oldExperiment, previous)) !==
      JSON.stringify(harnessHistoryExperimentReadingIdentity(newExperiment, current)) ||
      JSON.stringify(harnessHistoryDetailReadingIdentity(oldDetail, previous)) !==
        JSON.stringify(harnessHistoryDetailReadingIdentity(newDetail, current)))
  )
    return 'modified';
  return kind;
}

function mapNodeSelection(
  selectedNode: NonNullable<EvolutionExplorationSelectionV1['selectedNodeRef']>,
  previous: Catalog,
  current: Catalog,
  next: EvolutionExplorationSelectionV1,
  priorKind: UpdateKind,
): UpdateKind | 'removed' {
  const oldNode = previous.nodes.find((node) => refIdentity(node.nodeRef) === refIdentity(selectedNode));
  const targetNode = next.selectedNodeRef ?? selectedNode;
  const newNode = current.nodes.find((node) => sameLogicalExplorationRef(node.nodeRef, targetNode));
  if (!oldNode || !newNode) return 'removed';
  next.selectedNodeRef = newNode.nodeRef;
  // Publication versions re-sign the same logical read. Exact evidence identities still count as content changes.
  if (
    priorKind === 'unchanged' &&
    JSON.stringify(harnessHistoryNodeReadingIdentity(oldNode, previous)) !==
      JSON.stringify(harnessHistoryNodeReadingIdentity(newNode, current))
  )
    return 'modified';
  return priorKind;
}

/** Called only with the two verified owner publications; clients never strip versions themselves. */
export function mapHarnessHistorySelection(
  previous: Catalog,
  current: Catalog,
  selection: EvolutionExplorationSelectionV1,
): NonNullable<EvolutionArchivePublicationV1['selectionUpdate']> {
  const next: EvolutionExplorationSelectionV1 = { selectedSourceRef: current.sourceRef };
  let kind: UpdateKind =
    previous.overview === current.overview && previous.overviewMarkdown === current.overviewMarkdown
      ? 'unchanged'
      : 'modified';
  for (const key of ['selectedExperimentRef', 'comparisonExperimentRef'] as const) {
    const selected = selection[key];
    if (!selected) continue;
    const mapped = mapExperimentSelection(key, selected, previous, current, next, kind);
    if (mapped === 'removed') return { kind: 'removed' };
    kind = mapped;
  }
  if (selection.selectedNodeRef) {
    const mapped = mapNodeSelection(selection.selectedNodeRef, previous, current, next, kind);
    if (mapped === 'removed') return { kind: 'removed' };
    kind = mapped;
  }
  return { kind, nextSelection: next };
}
