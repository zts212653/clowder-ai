import { describe, expect, it } from 'vitest';
import {
  deferredPersonMemoryInputSchema,
  deferredPersonMemoryReceiptSchema,
} from '../types/proactive-memory-deferred-receipt.js';
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

  it('keeps abstention input content-free with an optional write-opportunity identity triple', () => {
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
      proactiveMemoryAbstentionInputSchema.parse({
        reasonCode: 'insufficient_owner_evidence',
        writeOpportunityRef: {
          opportunityId: `write_opp_${'a'.repeat(32)}`,
          dedupeLineage: `write_lineage_${'b'.repeat(32)}`,
          generation: 1,
        },
      }),
    ).toEqual({
      reasonCode: 'insufficient_owner_evidence',
      writeOpportunityRef: {
        opportunityId: `write_opp_${'a'.repeat(32)}`,
        dedupeLineage: `write_lineage_${'b'.repeat(32)}`,
        generation: 1,
      },
    });
    expect(
      proactiveMemoryAbstentionInputSchema.safeParse({
        reasonCode: 'insufficient_owner_evidence',
        writeOpportunityRef: {
          opportunityId: `write_opp_${'a'.repeat(32)}`,
          dedupeLineage: `write_lineage_${'b'.repeat(32)}`,
          generation: 1,
          transcript: 'private body',
        },
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

    const deferred = {
      opportunityRef: `opp_${'c'.repeat(32)}`,
      disposition: 'defer',
      reasonCode: 'deferred_receipt_recorded',
    };
    expect(proactiveMemoryOpportunityEpisodeSchema.parse(deferred)).toEqual(deferred);
    expect(
      proactiveMemoryOpportunityEpisodeSchema.safeParse({
        ...deferred,
        receiptId: 'deferred_receipt_secret',
      }).success,
    ).toBe(false);
  });
});

describe('F276 deferred person-memory receipt contract', () => {
  it('accepts only bounded subject and server-resolvable source coordinates', () => {
    const input = {
      subject: '黄挺',
      sources: [
        { kind: 'message', messageId: 'message-owner-text' },
        {
          kind: 'message_attachment',
          messageId: 'message-owner-asr',
          attachmentLocator: { surface: 'content_block', index: 0 },
          confirmationMessageId: 'message-owner-confirmation',
        },
      ],
      clientRequestId: 'defer-request-1',
    };
    expect(deferredPersonMemoryInputSchema.parse(input)).toEqual(input);
    for (const forbidden of [
      { ownerUserId: 'owner-secret' },
      { threadId: 'thread-secret' },
      { invocationId: 'invocation-secret' },
      { digest: 'a'.repeat(64) },
      { excerpt: 'private body' },
      { transcript: 'private ASR body' },
    ]) {
      expect(deferredPersonMemoryInputSchema.safeParse({ ...input, ...forbidden }).success).toBe(false);
    }
  });

  it('requires payload only while actionable and purges it from terminal receipts', () => {
    const base = {
      receiptId: `deferred_person_${'a'.repeat(32)}`,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      invocationId: 'invocation-1',
      originMessageRef: { kind: 'message', threadId: 'thread-current', messageId: 'message-current' },
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding: { kind: 'registered_person', ref: 'person-1' },
      sourceCoordinates: [
        {
          kind: 'message',
          sourceRef: { kind: 'message', threadId: 'thread-history', messageId: 'message-history' },
          resolvedDigest: 'b'.repeat(64),
        },
      ],
      sourceBundleDigest: 'c'.repeat(64),
      dedupeHash: 'd'.repeat(64),
      state: 'deferred',
      retention: 'owner_controlled_no_ttl',
      createdAt: 100,
      updatedAt: 100,
    };
    expect(deferredPersonMemoryReceiptSchema.parse(base)).toEqual(base);
    expect(
      deferredPersonMemoryReceiptSchema.safeParse({
        ...base,
        state: 'proposed',
        proposalId: 'person_candidate_1',
      }).success,
    ).toBe(false);
    const {
      invocationId,
      originMessageRef,
      subject,
      normalizedSubject,
      registryBinding,
      sourceCoordinates,
      sourceBundleDigest,
      ...terminal
    } = base;
    expect(
      deferredPersonMemoryReceiptSchema.parse({
        ...terminal,
        state: 'proposed',
        proposalId: 'person_candidate_1',
        updatedAt: 200,
      }),
    ).toMatchObject({ state: 'proposed', proposalId: 'person_candidate_1' });
  });
});
