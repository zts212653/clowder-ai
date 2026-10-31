import { evolutionExplorationReviewV1Schema } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { explorationFixture, source } from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { ExplorationPairedResults } from '../exploration/ExplorationPairedResults';
import { compareExplorationRecords, comparisonScopeKey } from '../exploration/exploration-comparison';
import { DEFAULT_EXPLORATION } from '../exploration/exploration-reading';

test.each([
  [1, 0],
  [0, 1],
  [1, 2],
  [0, 0],
])('discloses a partial scope with %i/%i unmatched records and preserves full pairing', async (leftOnly, rightOnly) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const review = evolutionExplorationReviewV1Schema.parse(explorationFixture({ withDetail: true }));
  if (review.status !== 'resolved' || review.details[0]?.status !== 'resolved' || !review.experiments[0])
    throw Error('fixture');
  const left = { experiment: review.experiments[0], records: review.details[0].records };
  const right = structuredClone(left);
  right.experiment.experimentRef = source('right-run');
  right.records = right.records.map((record) => ({ ...record, experimentRef: right.experiment.experimentRef }));
  for (const [side, count, name] of [
    [left, leftOnly, 'left'],
    [right, rightOnly, 'right'],
  ] as const) {
    const seed = side.records[0];
    if (!seed) throw Error('record');
    for (let i = 0; i < count; i++)
      side.records.push({
        ...seed,
        recordRef: source(`${name}-${i}`),
        inputRef: source(`${name}-input-${i}`),
        caseId: `${name}-${i}`,
        label: `${name} omitted ${i}`,
      });
    side.experiment.recordCount = side.records.length;
  }
  const scopeKey = comparisonScopeKey(left.experiment, right.experiment);
  const result = compareExplorationRecords(left, right, 'paired_subset', scopeKey);
  expect(result.status).toBe('paired');
  const change = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ExplorationPairedResults
          programId={review.programRef.ownerStateRef}
          left={left}
          right={right}
          result={result}
          reading={{ ...DEFAULT_EXPLORATION, comparisonScope: 'paired_subset', comparisonScopeKey: scopeKey }}
          onChange={change}
          onRetry={() => {}}
        />,
      ),
    );
    const scope = host.querySelector('[aria-label="本次比较范围"]');
    if (leftOnly || rightOnly) {
      expect(scope?.textContent).toContain('仅比较共同的 1 个场景，不能外推到整批。');
      expect(scope?.textContent).toContain(`未纳入本次比较：对照侧 ${leftOnly} 条，本版侧 ${rightOnly} 条。`);
      for (const record of [...result.leftOnly, ...result.rightOnly])
        expect(scope?.textContent).toContain(record.label);
      const button = scope?.querySelector('button');
      expect(button?.textContent).toBe('返回完整范围');
      await act(async () => button?.click());
      expect(change).toHaveBeenCalledWith({ comparisonScope: 'full', comparisonScopeKey: undefined });
    } else expect(scope).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
