'use client';
import {
  type EvolutionExplorationExperimentV1,
  type EvolutionExplorationNodeV1,
  type EvolutionExplorationSelectionV1,
  type EvolutionResolvedExplorationReviewV1,
  type ExactAssetVersionRefV1,
  refIdentity,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEvolutionAssetReview } from '../evolution-asset-resource';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { DEFAULT_READING, useEvolutionReading } from '../evolution-reading-state';
import { projectAssetVersions } from '../evolution-version-view';
import { compareExplorationRecords, comparisonScopeKey } from './exploration-comparison';
import { suggestedComparison, suggestedExperiment } from './exploration-decision-model';
import { isHistoricalStep } from './exploration-history';
import { clearExplorationSelection, DEFAULT_EXPLORATION, type ExplorationReading } from './exploration-reading';
import { useEvolutionExploration } from './exploration-resource';

function versionStateKeys(versions: ReturnType<typeof projectAssetVersions>) {
  return {
    currentKeys: new Set(
      versions.filter((version) => version.sourceCurrent).map((version) => refIdentity(version.ref)),
    ),
    adoptedKeys: new Set(versions.filter((version) => version.adopted).map((version) => refIdentity(version.ref))),
  };
}

function resolveNode(
  catalog: EvolutionResolvedExplorationReviewV1 | undefined,
  selectedNodeRef: EvolutionExplorationNodeV1['nodeRef'] | undefined,
  exactSource: ExactAssetVersionRefV1 | undefined,
): EvolutionExplorationNodeV1 | undefined {
  if (selectedNodeRef) return catalog?.nodes.find((node) => refIdentity(node.nodeRef) === refIdentity(selectedNodeRef));
  if (exactSource)
    return catalog?.nodes.find(
      (node) => node.kind === 'owner_version' && refIdentity(node.versionRef) === refIdentity(exactSource),
    );
  return (
    catalog?.nodes.find(isHistoricalStep) ??
    catalog?.nodes.filter((entry) => entry.kind === 'owner_version').at(-1) ??
    catalog?.nodes.at(-1)
  );
}

function selectExperiment(
  catalog: EvolutionResolvedExplorationReviewV1 | undefined,
  experiments: EvolutionExplorationExperimentV1[],
  selectedRef: EvolutionExplorationExperimentV1['experimentRef'] | undefined,
): EvolutionExplorationExperimentV1 | undefined {
  if (selectedRef) return experiments.find((run) => refIdentity(run.experimentRef) === refIdentity(selectedRef));
  return catalog ? suggestedExperiment(catalog, experiments) : undefined;
}

/** One selection controller shared by the narrow summary and main work surface. */
export function useExplorationWorkspace(projection: EvolutionProgramProjection) {
  const id = projection.program.programId;
  const saved = useEvolutionReading((state) => state.programs[id] ?? DEFAULT_READING);
  const update = useEvolutionReading((state) => state.update);
  const reading = saved.exploration ?? DEFAULT_EXPLORATION;
  const asset = useEvolutionAssetReview(projection, saved.selectedVersionRef);
  const change = useCallback(
    (patch: Partial<ExplorationReading>) =>
      update(id, {
        exploration: { ...(useEvolutionReading.getState().programs[id]?.exploration ?? DEFAULT_EXPLORATION), ...patch },
      }),
    [id, update],
  );
  const resource = useEvolutionExploration(projection, {
    selectedSourceRef: reading.selectedSourceRef,
    selectedNodeRef: reading.selectedNodeRef,
    selectedExperimentRef: reading.selectedExperimentRef,
    comparisonExperimentRef: reading.comparisonExperimentRef,
  });
  const catalog = resource.catalog;
  const [publicationError, setPublicationError] = useState<string>();
  const publicationSwitch = useRef(false);
  const adoptPublication = useCallback(
    async (next: EvolutionExplorationSelectionV1) => {
      if (publicationSwitch.current) return;
      publicationSwitch.current = true;
      setPublicationError(undefined);
      try {
        if (!(await resource.prepareSelection(next))) {
          setPublicationError('新版暂时无法读取，当前内容已保留。请重试。');
          return;
        }
        change({
          selectedSourceRef: next.selectedSourceRef,
          selectedNodeRef: next.selectedNodeRef,
          selectedExperimentRef: next.selectedExperimentRef,
          comparisonExperimentRef: next.comparisonExperimentRef,
          ...(!next.selectedExperimentRef ? { selectedCaseId: undefined } : {}),
        });
      } finally {
        publicationSwitch.current = false;
      }
    },
    [change, resource.prepareSelection],
  );
  const publicationUpdate = catalog?.publication?.selectionUpdate;
  useEffect(() => {
    if (publicationUpdate?.kind === 'unchanged' && publicationUpdate.nextSelection)
      void adoptPublication(publicationUpdate.nextSelection);
  }, [publicationUpdate, adoptPublication]);
  const exactSource = saved.selectedVersionRef;
  const node = resolveNode(catalog, reading.selectedNodeRef, exactSource);
  const experiments = useMemo(
    () =>
      node
        ? (catalog?.experiments.filter((run) => refIdentity(run.nodeRef) === refIdentity(node.nodeRef)) ?? []).sort(
            (a, b) => (isHistoricalStep(node) ? a.conditions.window.label.localeCompare(b.conditions.window.label) : 0),
          )
        : [],
    [catalog, node],
  );
  const experiment =
    !reading.selectedExperimentRef && isHistoricalStep(node)
      ? experiments[0]
      : selectExperiment(catalog, experiments, reading.selectedExperimentRef);
  const selectedNodeKey = node ? refIdentity(node.nodeRef) : undefined;
  const selectedExperimentKey = experiment ? refIdentity(experiment.experimentRef) : undefined;
  useEffect(() => {
    if (
      !catalog ||
      !experiment ||
      isHistoricalStep(node) ||
      reading.comparisonExperimentRef ||
      reading.comparisonChoice === 'manual'
    )
      return;
    const suggested = suggestedComparison(catalog, experiment);
    if (suggested) change({ comparisonExperimentRef: suggested.experimentRef, comparisonChoice: 'auto' });
  }, [catalog, experiment, node, reading.comparisonExperimentRef, reading.comparisonChoice, change]);
  useEffect(() => {
    if (!node) return;
    const current = useEvolutionReading.getState().programs[id]?.exploration ?? DEFAULT_EXPLORATION;
    if (
      current.selectedNodeRef &&
      (refIdentity(current.selectedNodeRef) !== refIdentity(node.nodeRef) ||
        current.selectedExperimentRef ||
        !experiment)
    )
      return;
    update(id, {
      ...(node.kind === 'owner_version' ? { selectedVersionRef: node.versionRef } : {}),
      exploration: {
        ...current,
        ...(catalog?.publication ? { selectedSourceRef: catalog.sourceRef } : {}),
        selectedNodeRef: node.nodeRef,
        ...(experiment ? { selectedExperimentRef: experiment.experimentRef } : {}),
      },
    });
  }, [id, node, experiment, update, catalog]);
  const detail = resource.review?.details.find((entry) => refIdentity(entry.experimentRef) === selectedExperimentKey);
  const records = detail?.status === 'resolved' ? detail.records : [];
  const record = reading.selectedCaseId
    ? records.find((record) => record.caseId === reading.selectedCaseId)
    : records[0];
  const comparisonExperimentRef = reading.comparisonExperimentRef;
  const compareExperiment = comparisonExperimentRef
    ? catalog?.experiments.find((run) => refIdentity(run.experimentRef) === refIdentity(comparisonExperimentRef))
    : undefined;
  const compareDetail = compareExperiment
    ? resource.review?.details.find(
        (entry) => refIdentity(entry.experimentRef) === refIdentity(compareExperiment.experimentRef),
      )
    : undefined;
  const comparison =
    experiment && compareExperiment && compareDetail?.status === 'resolved'
      ? compareExplorationRecords(
          { experiment: compareExperiment, records: compareDetail.records },
          { experiment, records },
          reading.comparisonScope,
          reading.comparisonScopeKey,
        )
      : undefined;
  const pairedMediaVisible =
    comparison?.status === 'paired' && comparison.pairs.some((pair) => pair.right.caseId === record?.caseId);
  const acceptComparisonScope = (scope: 'full' | 'paired_subset') =>
    change({
      comparisonScope: scope,
      comparisonScopeKey:
        scope === 'paired_subset' && compareExperiment && experiment
          ? comparisonScopeKey(compareExperiment, experiment)
          : undefined,
    });
  const selectNode = (next: EvolutionExplorationNodeV1) =>
    update(id, {
      exploration: {
        ...(useEvolutionReading.getState().programs[id]?.exploration ?? DEFAULT_EXPLORATION),
        selectedNodeRef: next.nodeRef,
        selectedExperimentRef: undefined,
        comparisonExperimentRef: undefined,
        selectedCaseId: undefined,
        comparisonScope: 'full',
        comparisonScopeKey: undefined,
        comparisonChoice: 'auto',
        caseFilter: 'all',
      },
      ...(next.kind === 'owner_version' ? { selectedVersionRef: next.versionRef } : {}),
    });
  const { currentKeys, adoptedKeys } = versionStateKeys(projectAssetVersions(projection, asset.catalog));
  const resetSelection = () =>
    update(id, {
      selectedVersionRef: undefined,
      exploration: clearExplorationSelection(
        useEvolutionReading.getState().programs[id]?.exploration ?? DEFAULT_EXPLORATION,
      ),
    });
  return {
    id,
    reading,
    asset,
    change,
    resource,
    catalog,
    exactSource,
    node,
    experiments,
    experiment,
    selectedNodeKey,
    selectedExperimentKey,
    detail,
    records,
    record,
    compareExperiment,
    compareDetail,
    pairedMediaVisible,
    comparison,
    acceptComparisonScope,
    selectNode,
    currentKeys,
    adoptedKeys,
    resetSelection,
    adoptPublication,
    publicationError,
  };
}
