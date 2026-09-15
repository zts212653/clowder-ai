import { evolutionExplorationReviewV1Schema } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { explorationFixture, source } from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { compareExplorationRecords, comparisonScopeKey } from '../exploration/exploration-comparison';

function sides() {
  const parsed = evolutionExplorationReviewV1Schema.parse(explorationFixture({ withDetail: true }));
  if (parsed.status !== 'resolved' || parsed.details[0]?.status !== 'resolved') throw new Error('invalid fixture');
  const left = { experiment: parsed.experiments[0]!, records: parsed.details[0].records };
  const right = structuredClone(left);
  right.experiment.experimentRef = source('right-run');
  right.records = right.records.map((record) => ({ ...record, experimentRef: right.experiment.experimentRef }));
  return { left, right };
}
describe('comparison follows the actual experiment method and record range', () => {
  it('refuses the same experiment even when its records are complete and the method is unpaired', () => {
    const { left } = sides();
    expect(compareExplorationRecords(left, structuredClone(left), 'full').status).toBe('unavailable');
    left.experiment.conditions.comparison.design = 'unpaired';
    expect(compareExplorationRecords(left, structuredClone(left), 'full').status).toBe('unavailable');
  });
  it('pairs matching inputs and retains failures for direct case inspection', () => {
    const { left, right } = sides();
    right.records[0]!.result = { status: 'violated', label: '意外放行' };
    const result = compareExplorationRecords(left, right, 'full');
    expect(result.status).toBe('paired');
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.right.result.label).toBe('意外放行');
  });
  it('requires an explicit subset before comparing unequal input sets and discloses exclusions', () => {
    const { left, right } = sides();
    right.records.push({
      ...right.records[0]!,
      recordRef: source('extra-record'),
      inputRef: source('extra-input'),
      caseId: 'extra',
    });
    right.experiment.recordCount = 2;
    const full = compareExplorationRecords(left, right, 'full');
    expect(full.status).toBe('scope_required');
    expect(full.rightOnly).toHaveLength(1);
    const subset = compareExplorationRecords(
      left,
      right,
      'paired_subset',
      comparisonScopeKey(left.experiment, right.experiment),
    );
    expect(subset.status).toBe('paired');
    expect(subset.pairs).toHaveLength(1);
    expect(subset.rightOnly).toHaveLength(1);
  });
  it('refuses incompatible windows, measurement, GT, environments and ambiguous repeat pairing', () => {
    for (const key of ['window', 'measurement', 'groundTruth', 'environment'] as const) {
      const { left, right } = sides();
      right.experiment.conditions[key].sourceRef = source(`other-${key}`);
      const result = compareExplorationRecords(left, right, 'full');
      expect(result.status).toBe('unavailable');
      expect(result.reasons.length).toBeGreaterThan(0);
    }
    const { left, right } = sides();
    right.records.push({ ...right.records[0]!, recordRef: source('repeat') });
    right.experiment.recordCount = 2;
    expect(compareExplorationRecords(left, right, 'paired_subset').status).toBe('unavailable');
  });
  it('supports an owner-declared unpaired method without inventing paired cases', () => {
    const { left, right } = sides();
    left.experiment.conditions.comparison.design = right.experiment.conditions.comparison.design = 'unpaired';
    right.records[0]!.inputRef = source('another-population-input');
    const result = compareExplorationRecords(left, right, 'full');
    expect(result.status).toBe('unpaired');
    expect(result.pairs).toHaveLength(0);
  });
  it('expires a persisted subset choice when either published sample set changes', () => {
    const { left, right } = sides();
    right.records.push({
      ...right.records[0]!,
      recordRef: source('extra'),
      inputRef: source('extra-input'),
      caseId: 'extra',
    });
    right.experiment.recordCount = 2;
    const consent = comparisonScopeKey(left.experiment, right.experiment);
    expect(compareExplorationRecords(left, right, 'paired_subset', consent).status).toBe('paired');
    // A raw persisted 'paired_subset' is not consent for a newer input set.
    right.experiment.conditions.sampleSet.sourceRef = source('new-samples');
    expect(compareExplorationRecords(left, right, 'paired_subset', consent).status).toBe('scope_required');
  });
});
