import type { EvolutionExplorationRecordV1 } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { duckWalkObservation } from '../exploration/duck-walk-observations';

const record = (caseId: string, hash: string) =>
  ({
    caseId,
    media: [{ kind: 'video', mediaRef: { version: hash } }],
  }) as EvolutionExplorationRecordV1;

it('never lends the northstar left-far observation to a new replay or neighboring case', () => {
  const hash = '2d45a5581573c0b2cb2256d967f4a31d3d3ac39a7f0f98a2bf0028b7806a6b30';
  expect(duckWalkObservation('v2', record('approach-left-far', hash))).toContain('2.6秒');
  expect(duckWalkObservation('v2', record('approach-right-far', hash))).toBeUndefined();
  expect(duckWalkObservation('v2', record('approach-left-far', 'f'.repeat(64)))).toBeUndefined();
  expect(duckWalkObservation('unknown-version', record('approach-left-far', hash))).toBeUndefined();
});
