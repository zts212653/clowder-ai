import { evolutionExplorationReviewV1Schema, refIdentity } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { mockExploration } from '../../../../test/browser/f311-duck-exploration.data.mjs';
import { compareExplorationRecords } from '../exploration/exploration-comparison';

describe('mock data through the production exploration contract', () => {
  it('preserves four compositions, two parents, seven experiments and exact selected records', () => {
    const catalog = evolutionExplorationReviewV1Schema.parse(mockExploration());
    if (catalog.status !== 'resolved') throw Error('mock catalog must resolve');
    expect(catalog.nodes).toHaveLength(4);
    expect(catalog.nodes[3].parentEdges).toHaveLength(2);
    expect(catalog.experiments).toHaveLength(7);
    expect(catalog.details).toHaveLength(0);
    const selected = catalog.experiments[4];
    const review = evolutionExplorationReviewV1Schema.parse(
      mockExploration({ selectedNodeRef: selected.nodeRef, selectedExperimentRef: selected.experimentRef }),
    );
    if (review.status !== 'resolved') throw Error('selected mock must resolve');
    expect(review.details).toHaveLength(1);
    expect(refIdentity(review.details[0].experimentRef)).toBe(refIdentity(selected.experimentRef));
    expect(() =>
      mockExploration({ selectedNodeRef: catalog.nodes[0].nodeRef, selectedExperimentRef: selected.experimentRef }),
    ).toThrow();
  });
  it('uses the real comparison rules: same ruler pairs, changed ruler and aborted loads do not', () => {
    const catalog = evolutionExplorationReviewV1Schema.parse(mockExploration());
    if (catalog.status !== 'resolved') throw Error('mock catalog must resolve');
    const pair = (a: number, b: number) => {
      const left = catalog.experiments[a],
        right = catalog.experiments[b];
      const review = evolutionExplorationReviewV1Schema.parse(
        mockExploration({
          selectedNodeRef: right.nodeRef,
          selectedExperimentRef: right.experimentRef,
          comparisonExperimentRef: left.experimentRef,
        }),
      );
      if (review.status !== 'resolved') throw Error('mock detail must resolve');
      const side = (experiment: typeof left) => {
        const detail = review.details.find(
          (d) => refIdentity(d.experimentRef) === refIdentity(experiment.experimentRef),
        );
        if (detail?.status !== 'resolved') throw Error('detail required');
        return { experiment, records: detail.records };
      };
      return compareExplorationRecords(side(left), side(right), 'full');
    };
    expect(pair(0, 1).status).toBe('paired');
    expect(pair(0, 3).status).toBe('unavailable');
    expect(pair(1, 2).status).toBe('unavailable');
    expect(pair(3, 4).pairs).toHaveLength(6);
    expect(pair(5, 6).pairs).toHaveLength(8);
  });
});
