import { describe, expect, it } from 'vitest';
import { parseEvolutionProgramProjection } from '../capability-evolution-presentation';
import { isProjection } from '../evolution-program-projection';
import { assetRef, ownerRef, programFixture } from './evolution-fixtures';

describe('one owner projection for every Workspace surface', () => {
  it('retains exact versions, lineage and observation instead of reducing them to a status', () => {
    const value = programFixture();
    expect(parseEvolutionProgramProjection(value)).toMatchObject({
      program: { currentAssetVersionRefs: [assetRef('v1')] },
      observation: value.observation,
      lineage: value.lineage,
      drafts: value.drafts,
    });
  });

  it('rejects malformed optional owner facts instead of showing an invented empty history', () => {
    expect(parseEvolutionProgramProjection({ ...programFixture(), lineage: { cycles: 'bad' } })).toBeNull();
    expect(parseEvolutionProgramProjection({ ...programFixture(), attribution: { verdict: 'attributed' } })).toBeNull();
  });

  it('applies the same complete state validation to command and read responses', () => {
    const value = programFixture();
    expect(isProjection(value)).toBe(true);
    expect(isProjection({ ...value, program: { ...value.program, currentAssetVersionRefs: undefined } })).toBe(false);
    expect(isProjection({ ...value, program: { ...value.program, stage: 'made_up' } })).toBe(false);
  });

  it('does not accept an outcome without the owner execution and fresh proof chain', () => {
    const change = {
      caseRef: ownerRef('case'),
      proposalRef: ownerRef('proposal'),
      ownerAuthorizationRef: ownerRef('permission'),
      targetVersionRef: assetRef('v1'),
      status: 'outcome',
      assetVersionRef: assetRef('v2'),
    };
    expect(
      parseEvolutionProgramProjection({
        ...programFixture(),
        lineage: { cycles: [{ cycle: 1, changes: [change] }], current: change },
      }),
    ).toBeNull();
  });
});
