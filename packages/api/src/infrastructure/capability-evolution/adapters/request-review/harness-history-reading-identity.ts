import type { EvolutionResolvedExplorationReviewV1 } from '@cat-cafe/shared';

type Catalog = EvolutionResolvedExplorationReviewV1;
type Ref = Catalog['sourceRef'];
type Experiment = Catalog['experiments'][number];
type Detail = Catalog['details'][number];
type Node = Catalog['nodes'][number];

export const sameLogicalExplorationRef = (a: Ref, b: Ref) =>
  a.ownerFeatureId === b.ownerFeatureId && a.ownerStateRef === b.ownerStateRef;
const logicalRefIdentity = (ref: Ref) => [ref.ownerFeatureId, ref.ownerStateRef];
const sourceRefIdentity = (ref: Ref, catalog: Catalog) =>
  sameLogicalExplorationRef(ref, catalog.sourceRef)
    ? logicalRefIdentity(ref)
    : [...logicalRefIdentity(ref), ref.version];
const sourceIdentity = (source: { label: string; ref: Ref; href?: string }, catalog: Catalog) => [
  source.label,
  sourceRefIdentity(source.ref, catalog),
  source.href,
];
const conditionIdentity = (condition: { label: string; detail: string; sourceRef: Ref }, catalog: Catalog) => [
  condition.label,
  condition.detail,
  sourceRefIdentity(condition.sourceRef, catalog),
];

export function harnessHistoryExperimentReadingIdentity(experiment: Experiment, catalog: Catalog) {
  const conditions = experiment.conditions;
  return {
    logicalRef: logicalRefIdentity(experiment.experimentRef),
    sourceRef: sourceRefIdentity(experiment.sourceRef, catalog),
    title: experiment.title,
    status: experiment.status,
    recordCount: experiment.recordCount,
    conditions: {
      environment: conditionIdentity(conditions.environment, catalog),
      sampleSet: conditionIdentity(conditions.sampleSet, catalog),
      measurement: conditionIdentity(conditions.measurement, catalog),
      groundTruth: [...conditionIdentity(conditions.groundTruth, catalog), conditions.groundTruth.status],
      window: conditionIdentity(conditions.window, catalog),
      exposure: conditions.exposure,
      limitation: conditions.limitation,
      threshold:
        conditions.threshold.status === 'frozen'
          ? [
              conditions.threshold.status,
              conditions.threshold.detail,
              sourceRefIdentity(conditions.threshold.sourceRef, catalog),
            ]
          : [conditions.threshold.status, conditions.threshold.detail],
      comparison: [
        conditions.comparison.design,
        conditions.comparison.method,
        conditions.comparison.planRef ? sourceRefIdentity(conditions.comparison.planRef, catalog) : undefined,
      ],
      preparationRefs: conditions.preparationRefs.map((source) => sourceIdentity(source, catalog)),
    },
    metrics: experiment.metrics.map((metric) => [
      metric.key,
      metric.label,
      metric.unit,
      metric.definition,
      sourceRefIdentity(metric.sourceRef, catalog),
    ]),
  };
}

export function harnessHistoryDetailReadingIdentity(detail: Detail | undefined, catalog: Catalog) {
  if (!detail) return undefined;
  if (detail.status !== 'resolved') return [detail.status, detail.reason];
  return detail.records.map((record) => ({
    caseId: record.caseId,
    label: record.label,
    bodyMarkdown: record.bodyMarkdown,
    inputRef: sourceRefIdentity(record.inputRef, catalog),
    evidenceRef: sourceRefIdentity(record.evidenceRef, catalog),
    windowRef: sourceRefIdentity(record.windowRef, catalog),
    measurementRef: sourceRefIdentity(record.measurementRef, catalog),
    input: record.input,
    output: record.output,
    result: record.result,
    values: record.values,
    trace: record.trace
      ? { ...record.trace, sourceRef: sourceRefIdentity(record.trace.sourceRef, catalog) }
      : undefined,
    media: record.media.map((media) => ({
      ...media,
      mediaRef: sourceRefIdentity(media.mediaRef, catalog),
      sourceRecordRef: sourceRefIdentity(media.sourceRecordRef, catalog),
    })),
    mediaStatus: record.mediaStatus,
    sources: record.sources.map((source) => sourceIdentity(source, catalog)),
  }));
}

export function harnessHistoryNodeReadingIdentity(node: Node, catalog: Catalog) {
  return {
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    bodyMarkdown: node.bodyMarkdown,
    history: node.kind === 'public_archive' ? node.history : undefined,
    sourceRef: sourceRefIdentity(node.sourceRef, catalog),
    sources: node.sources?.map((source) => sourceIdentity(source, catalog)),
    changes: node.changes.map((change) => [
      change.label,
      change.detail,
      sourceRefIdentity(change.sourceRef, catalog),
      change.ownerHref,
    ]),
    parents: node.parentEdges.map((edge) => [
      logicalRefIdentity(edge.parentNodeRef),
      edge.description,
      sourceRefIdentity(edge.sourceRef, catalog),
    ]),
    cases: catalog.experiments
      .filter((item) => sameLogicalExplorationRef(item.nodeRef, node.nodeRef))
      .map((item) => harnessHistoryExperimentReadingIdentity(item, catalog)),
  };
}
