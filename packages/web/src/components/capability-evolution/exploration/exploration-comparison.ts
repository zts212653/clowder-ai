import {
  type EvolutionExplorationExperimentV1,
  type EvolutionExplorationRecordV1,
  refIdentity,
} from '@cat-cafe/shared';

export interface ExplorationComparisonSide {
  experiment: EvolutionExplorationExperimentV1;
  records: EvolutionExplorationRecordV1[];
}
export interface ExplorationComparison {
  status: 'unavailable' | 'scope_required' | 'paired' | 'unpaired';
  reasons: string[];
  pairs: Array<{ left: EvolutionExplorationRecordV1; right: EvolutionExplorationRecordV1 }>;
  leftOnly: EvolutionExplorationRecordV1[];
  rightOnly: EvolutionExplorationRecordV1[];
}
export function comparisonScopeKey(
  left: EvolutionExplorationExperimentV1,
  right: EvolutionExplorationExperimentV1,
): string {
  return JSON.stringify(
    [
      left.experimentRef,
      right.experimentRef,
      left.conditions.sampleSet.sourceRef,
      right.conditions.sampleSet.sourceRef,
    ].map(refIdentity),
  );
}
function completeSide(side: ExplorationComparisonSide): boolean {
  const { experiment, records } = side;
  return (
    records.length === experiment.recordCount &&
    records.every(
      (record) =>
        refIdentity(record.experimentRef) === refIdentity(experiment.experimentRef) &&
        refIdentity(record.nodeRef) === refIdentity(experiment.nodeRef) &&
        refIdentity(record.windowRef) === refIdentity(experiment.conditions.window.sourceRef) &&
        refIdentity(record.measurementRef) === refIdentity(experiment.conditions.measurement.sourceRef),
    )
  );
}

export function compareExplorationRecords(
  left: ExplorationComparisonSide,
  right: ExplorationComparisonSide,
  scope: 'full' | 'paired_subset',
  acceptedScopeKey?: string,
): ExplorationComparison {
  const result: ExplorationComparison = { status: 'unavailable', reasons: [], pairs: [], leftOnly: [], rightOnly: [] };
  const a = left.experiment.conditions;
  const b = right.experiment.conditions;
  if (refIdentity(left.experiment.experimentRef) === refIdentity(right.experiment.experimentRef))
    return { ...result, reasons: ['同一次实验不能作为自己的对照，请选择另一轮实际记录。'] };
  const labels = { environment: '环境', window: '观察窗口', measurement: '量尺', groundTruth: 'GT 来源' };
  for (const key of ['environment', 'window', 'measurement', 'groundTruth'] as const)
    if (refIdentity(a[key].sourceRef) !== refIdentity(b[key].sourceRef))
      result.reasons.push(`${labels[key]}不同，需按适用条件重新测量。`);
  if (a.exposure !== b.exposure || a.groundTruth.status !== b.groundTruth.status)
    result.reasons.push('证据的公开范围或 GT 可信性不同。');
  if (
    a.comparison.design === 'undeclared' ||
    a.comparison.design !== b.comparison.design ||
    !a.comparison.planRef ||
    !b.comparison.planRef ||
    refIdentity(a.comparison.planRef) !== refIdentity(b.comparison.planRef)
  )
    result.reasons.push('尚无同时适用的比较设计。');
  if (!completeSide(left) || !completeSide(right)) result.reasons.push('当前记录不完整或未绑定这一轮条件。');
  if (!left.records.length || !right.records.length) result.reasons.push('至少一侧没有实际记录。');
  if (result.reasons.length) return result;
  if (a.comparison.design === 'unpaired') return { ...result, status: 'unpaired' };
  const leftInputs = new Map(left.records.map((record) => [refIdentity(record.inputRef), record]));
  const rightInputs = new Map(right.records.map((record) => [refIdentity(record.inputRef), record]));
  if (leftInputs.size !== left.records.length || rightInputs.size !== right.records.length)
    return { ...result, reasons: ['同一输入包含多条重复记录，尚无明确的重复配对规则。'] };
  for (const record of left.records) {
    const paired = rightInputs.get(refIdentity(record.inputRef));
    if (paired) result.pairs.push({ left: record, right: paired });
    else result.leftOnly.push(record);
  }
  result.rightOnly = right.records.filter((record) => !leftInputs.has(refIdentity(record.inputRef)));
  if (!result.pairs.length) return { ...result, reasons: ['两侧没有相同输入，不能假装配对。'] };
  const partial = result.leftOnly.length > 0 || result.rightOnly.length > 0;
  const accepted =
    scope === 'paired_subset' && acceptedScopeKey === comparisonScopeKey(left.experiment, right.experiment);
  return { ...result, status: partial && !accepted ? 'scope_required' : 'paired' };
}
