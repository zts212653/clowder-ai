'use client';
import { type EvolutionExplorationNodeV1, refIdentity } from '@cat-cafe/shared';
import { useEffect, useMemo } from 'react';
import { useEvolutionAssetReview } from '../evolution-asset-resource';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { DEFAULT_READING, useEvolutionReading } from '../evolution-reading-state';
import { compareExplorationRecords, comparisonScopeKey } from './exploration-comparison';
import { clearExplorationSelection, DEFAULT_EXPLORATION, type ExplorationReading } from './exploration-reading';
import { useEvolutionExploration } from './exploration-resource';

/** One selection controller shared by the narrow summary and main work surface. */
export function useExplorationWorkspace(projection: EvolutionProgramProjection) {
  const id = projection.program.programId;
  const saved = useEvolutionReading((state) => state.programs[id] ?? DEFAULT_READING);
  const update = useEvolutionReading((state) => state.update);
  const reading = saved.exploration ?? DEFAULT_EXPLORATION;
  const asset = useEvolutionAssetReview(projection, saved.selectedVersionRef);
  const change = (patch: Partial<ExplorationReading>) =>
    update(id, {
      exploration: { ...(useEvolutionReading.getState().programs[id]?.exploration ?? DEFAULT_EXPLORATION), ...patch },
    });
  const resource = useEvolutionExploration(projection, {
    selectedNodeRef: reading.selectedNodeRef,
    selectedExperimentRef: reading.selectedExperimentRef,
    comparisonExperimentRef: reading.comparisonExperimentRef,
  });
  const catalog = resource.catalog;
  const exactSource = saved.selectedVersionRef;
  const node = reading.selectedNodeRef
    ? catalog?.nodes.find((node) => refIdentity(node.nodeRef) === refIdentity(reading.selectedNodeRef!))
    : exactSource
      ? catalog?.nodes.find(
          (node) => node.kind === 'owner_version' && refIdentity(node.versionRef) === refIdentity(exactSource),
        )
      : (catalog?.nodes.filter((entry) => entry.kind === 'owner_version').at(-1) ?? catalog?.nodes.at(-1));
  const experiments = useMemo(
    () =>
      node ? (catalog?.experiments.filter((run) => refIdentity(run.nodeRef) === refIdentity(node.nodeRef)) ?? []) : [],
    [catalog, node],
  );
  const experiment = reading.selectedExperimentRef
    ? experiments.find((run) => refIdentity(run.experimentRef) === refIdentity(reading.selectedExperimentRef!))
    : experiments.at(-1);
  const selectedNodeKey = node ? refIdentity(node.nodeRef) : undefined;
  const selectedExperimentKey = experiment ? refIdentity(experiment.experimentRef) : undefined;
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
        selectedNodeRef: node.nodeRef,
        ...(experiment ? { selectedExperimentRef: experiment.experimentRef } : {}),
      },
    });
  }, [id, reading, node, experiment, update]);
  const detail = resource.review?.details.find((entry) => refIdentity(entry.experimentRef) === selectedExperimentKey);
  const records = detail?.status === 'resolved' ? detail.records : [];
  const record = reading.selectedCaseId
    ? records.find((record) => record.caseId === reading.selectedCaseId)
    : records[0];
  const compareExperiment = reading.comparisonExperimentRef
    ? catalog?.experiments.find(
        (run) => refIdentity(run.experimentRef) === refIdentity(reading.comparisonExperimentRef!),
      )
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
      },
      ...(next.kind === 'owner_version' ? { selectedVersionRef: next.versionRef } : {}),
    });
  const currentKeys = new Set((asset.catalog?.currentVersionRefs ?? []).map(refIdentity));
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
    acceptComparisonScope,
    selectNode,
    currentKeys,
    resetSelection,
  };
}
