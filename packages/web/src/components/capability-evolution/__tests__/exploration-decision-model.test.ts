import { refIdentity } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { mockExploration } from '../../../../test/browser/f311-duck-exploration.data.mjs';
import { compareExplorationRecords } from '../exploration/exploration-comparison';
import {
  suggestedComparison,
  suggestedExperiment,
  summarizePairChanges,
} from '../exploration/exploration-decision-model';

describe('comparison reading defaults and outcome slices', () => {
  const catalog = mockExploration();
  const run = (id: string) => catalog.experiments.find((entry) => entry.title.startsWith(`${id} ·`))!;
  it('starts a version on recorded evidence while retaining failed runs and never ranking by outcome', () => {
    const runs = [run('X2'), run('X3')];
    expect(suggestedExperiment(catalog, runs)).toBe(runs[0]);
    expect(runs).toHaveLength(2);
    const latest = {
      ...runs[0],
      title: 'All six cases regress',
      experimentRef: { ...runs[0].experimentRef, version: 'later' },
    };
    expect(suggestedExperiment(catalog, [...runs, latest])).toBe(latest);
    expect(suggestedExperiment(catalog, [run('X3')])).toBe(run('X3'));
    expect(suggestedExperiment(catalog, [])).toBeUndefined();
  });
  it('suggests a unique compatible parent experiment, not the latest run or an incompatible parent', () => {
    expect(suggestedComparison(catalog, run('X2'))?.experimentRef).toEqual(run('X1').experimentRef);
    expect(suggestedComparison(catalog, run('X5'))?.experimentRef).toEqual(run('X4').experimentRef);
    expect(suggestedComparison(catalog, run('X7'))?.experimentRef).toEqual(run('X6').experimentRef);
    expect(suggestedComparison(catalog, run('X4'))).toBeUndefined();
    expect(suggestedComparison(catalog, run('X3'))).toBeUndefined();
    const ambiguous = {
      ...catalog,
      experiments: [
        ...catalog.experiments,
        { ...run('X1'), experimentRef: { ...run('X1').experimentRef, version: 'another' } },
      ],
    };
    expect(suggestedComparison(ambiguous, run('X2'))).toBeUndefined();
  });
  it('keeps gains, regressions, ties and unknowns separate, without inferring metric direction', () => {
    const left = run('X1'),
      right = run('X2');
    const review = mockExploration({
      selectedExperimentRef: right.experimentRef,
      comparisonExperimentRef: left.experimentRef,
    });
    const records = (experiment: typeof left) => {
      const detail = review.details.find(
        (item) => refIdentity(item.experimentRef) === refIdentity(experiment.experimentRef),
      );
      if (detail?.status !== 'resolved') throw Error('missing fixture');
      return detail.records;
    };
    const comparison = compareExplorationRecords(
      { experiment: left, records: records(left) },
      { experiment: right, records: records(right) },
      'full',
    );
    const summary = summarizePairChanges(comparison.pairs);
    expect(summary.improved.map((p) => p.right.caseId)).toEqual(['D1-1', 'D1-2']);
    expect(summary.regressed.map((p) => p.right.caseId)).toEqual(['D1-5']);
    expect(summary.unchanged).toHaveLength(3);
    const unknown = {
      ...comparison.pairs[0],
      right: { ...comparison.pairs[0].right, result: { status: 'unknown' as const, label: '未判断' } },
    };
    expect(summarizePairChanges([unknown]).unknown).toHaveLength(1);
    expect(summarizePairChanges([unknown]).unchanged).toHaveLength(0);
  });
});
