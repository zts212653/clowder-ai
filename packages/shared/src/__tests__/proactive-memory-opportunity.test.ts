import { describe, expect, it } from 'vitest';
import {
  PROACTIVE_MEMORY_ABSTENTION_REASON_CODES,
  proactiveMemoryAbstentionInputSchema,
  proactiveMemoryOpportunityEpisodeSchema,
  proactiveMemoryOpportunityRefSchema,
} from '../types/proactive-memory-opportunity.js';

describe('F282 proactive-memory opportunity contract', () => {
  it('accepts only projector-derived opaque refs', () => {
    expect(proactiveMemoryOpportunityRefSchema.parse(`opp_${'a'.repeat(32)}`)).toBe(`opp_${'a'.repeat(32)}`);

    for (const invalid of [
      'message:0001785450060679-000707-a063812b',
      'nudge:claim-1',
      'fixture:alden',
      `opp_${'A'.repeat(32)}`,
      `opp_${'a'.repeat(31)}`,
      `opp_${'a'.repeat(33)}`,
      'opp_张三告诉我他昨天去了北京',
      'opp_source excerpt',
    ]) {
      expect(proactiveMemoryOpportunityRefSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('keeps abstention input enum-only and caller-ref-free', () => {
    expect(PROACTIVE_MEMORY_ABSTENTION_REASON_CODES).toEqual([
      'not_continuity_valued',
      'insufficient_owner_evidence',
      'bad_timing',
      'authorization_boundary',
      'already_registered_or_pending',
      'privacy_boundary',
    ]);
    expect(proactiveMemoryAbstentionInputSchema.parse({ reasonCode: 'insufficient_owner_evidence' })).toEqual({
      reasonCode: 'insufficient_owner_evidence',
    });
    expect(
      proactiveMemoryAbstentionInputSchema.safeParse({
        reasonCode: 'insufficient_owner_evidence',
        opportunityRef: `opp_${'a'.repeat(32)}`,
      }).success,
    ).toBe(false);
    expect(
      proactiveMemoryAbstentionInputSchema.safeParse({
        reasonCode: 'other',
      }).success,
    ).toBe(false);
  });

  it('keeps episodes minimal and rejects private rationale fields', () => {
    const episode = {
      opportunityRef: `opp_${'b'.repeat(32)}`,
      disposition: 'abstain',
      reasonCode: 'bad_timing',
    };
    expect(proactiveMemoryOpportunityEpisodeSchema.parse(episode)).toEqual(episode);
    expect(
      proactiveMemoryOpportunityEpisodeSchema.safeParse({
        ...episode,
        rationale: '张三最近似乎很重要',
      }).success,
    ).toBe(false);
    expect(
      proactiveMemoryOpportunityEpisodeSchema.safeParse({
        ...episode,
        sourceMessageId: 'message-secret',
      }).success,
    ).toBe(false);
  });
});
