import { describe, expect, it } from 'vitest';
import { humanizeEvolutionTarget, parseEvolutionProgramProjection } from '../capability-evolution-presentation';

describe('F311 capability evolution presentation adapter', () => {
  it('turns the production machine ref into a human title', () => {
    expect(
      humanizeEvolutionTarget({
        ownerFeatureId: 'F311',
        ownerStateRef: 'capability:f311-investor-roadshow-expression',
      }),
    ).toEqual({ eyebrow: 'F311', title: '投资人路演表达能力' });
  });

  it('round-trips human targets created by the Workspace without exposing ref syntax', () => {
    expect(
      humanizeEvolutionTarget({
        ownerFeatureId: 'F311',
        ownerStateRef: `capability:${encodeURIComponent('视频讲解能力')}`,
      }),
    ).toEqual({ eyebrow: 'F311', title: '视频讲解能力' });
  });

  it('rejects malformed list members instead of inventing a local projection', () => {
    expect(parseEvolutionProgramProjection({ program: { programId: 'not-canonical' } })).toBeNull();
  });
});
