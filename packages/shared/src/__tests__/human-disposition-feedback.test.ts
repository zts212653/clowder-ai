import { describe, expect, it } from 'vitest';
import { PROACTIVE_ECHO_KINDS } from '../types/auto-dream.js';
import {
  buildHumanDispositionEnvelope,
  buildHumanDispositionLedgerEntry,
  buildHumanDispositionLedgerReceipt,
  classifyHumanDispositionFeedbackReplay,
  classifyHumanDispositionSourceReplay,
  HUMAN_DISPOSITION_REASON_CODES,
  HUMAN_DISPOSITION_REASON_CORRECTIONS,
  humanDispositionDecisionEpisodeSchema,
  humanDispositionEligibilityContextSchema,
  humanDispositionEnvelopeSchema,
  humanDispositionFeedbackInputSchema,
  humanDispositionLedgerEntrySchema,
  humanDispositionLedgerReceiptSchema,
  humanDispositionServerBindingSchema,
  isHumanDispositionEnvelopeEligible,
} from '../types/human-disposition-feedback.js';

const baseBinding = {
  interactionKind: 'approval_proposal',
  subjectRef: 'person:zhou-yujing',
  proposalId: 'proposal:memory:1',
  decision: 'rejected',
  producerCatId: 'codex-terra',
  ownerUserId: 'user:landy',
  decidedAt: 1_753_876_800_000,
  scope: { kind: 'exact_subject' },
  expiry: { kind: 'none' },
  invalidator: { kind: 'none' },
  sourceRef: 'decision:f276:1',
};

function binding(overrides: Record<string, unknown> = {}) {
  return humanDispositionServerBindingSchema.parse({ ...baseBinding, ...overrides });
}

function envelope(overrides: Record<string, unknown> = {}) {
  const built = buildHumanDispositionEnvelope(
    humanDispositionFeedbackInputSchema.parse({ reasonCode: 'bad_evidence' }),
    binding(overrides),
  );
  if (!built) throw new Error('test fixture unexpectedly omitted feedback');
  return built;
}

function context(overrides: Record<string, unknown> = {}) {
  return humanDispositionEligibilityContextSchema.parse({
    subjectRef: baseBinding.subjectRef,
    proposalLineage: { status: 'not_applicable' },
    now: 1_753_876_800_001,
    invalidatorTruth: { kind: 'none', status: 'not_applicable' },
    ...overrides,
  });
}

describe('F281 human-disposition shared feedback contract', () => {
  it('keeps the six correction directions distinct and reuses F272 names', () => {
    expect(HUMAN_DISPOSITION_REASON_CODES).toEqual([
      'not_important',
      'wrong_lane',
      'bad_evidence',
      'not_now',
      'wrong',
      'other',
    ]);
    const directions = Object.values(HUMAN_DISPOSITION_REASON_CORRECTIONS).map(
      ({ correctionDirection }) => correctionDirection,
    );
    expect(new Set(directions)).toHaveLength(HUMAN_DISPOSITION_REASON_CODES.length);
    expect(PROACTIVE_ECHO_KINDS).toEqual(expect.arrayContaining(['not_now', 'wrong']));
  });

  it('strictly separates public feedback from server-bound identity and decision fields', () => {
    expect(humanDispositionFeedbackInputSchema.parse({ reasonCode: 'wrong' })).toEqual({ reasonCode: 'wrong' });
    expect(humanDispositionFeedbackInputSchema.parse({ reasonCode: 'other', detail: '请先解释来源' })).toEqual({
      reasonCode: 'other',
      detail: '请先解释来源',
    });
    expect(humanDispositionFeedbackInputSchema.safeParse({ reasonCode: 'other', detail: '   ' }).success).toBe(false);
    expect(humanDispositionFeedbackInputSchema.safeParse({ reasonCode: 'wrong', detail: '不允许' }).success).toBe(
      false,
    );

    for (const [field, value] of Object.entries({
      ownerUserId: 'user:spoof',
      producerCatId: 'spoof-cat',
      subjectRef: 'person:spoof',
      decision: 'approved',
      sourceRef: 'source:spoof',
    })) {
      expect(humanDispositionFeedbackInputSchema.safeParse({ reasonCode: 'wrong', [field]: value }).success).toBe(
        false,
      );
    }
  });

  it('ends the feedback path without an envelope when the decision has no feedback', () => {
    expect(
      humanDispositionDecisionEpisodeSchema.parse({
        interactionKind: baseBinding.interactionKind,
        subjectRef: baseBinding.subjectRef,
        proposalId: baseBinding.proposalId,
        decision: baseBinding.decision,
        producerCatId: baseBinding.producerCatId,
        ownerUserId: baseBinding.ownerUserId,
        decidedAt: baseBinding.decidedAt,
        sourceRef: baseBinding.sourceRef,
      }),
    ).not.toHaveProperty('feedback');

    const noEnvelope = buildHumanDispositionEnvelope(undefined, binding());
    expect(noEnvelope).toBeNull();
    expect([noEnvelope].filter(Boolean)).toEqual([]);

    const complete = envelope();
    const { feedback, ...missingFeedback } = complete;
    expect(feedback.reasonCode).toBe('bad_evidence');
    expect(humanDispositionEnvelopeSchema.safeParse(missingFeedback).success).toBe(false);
  });

  it('locks the producer-owned episode and optional envelope into one strict ledger entry', () => {
    const episodeOnly = buildHumanDispositionLedgerEntry(undefined, binding());
    expect(humanDispositionLedgerEntrySchema.parse(episodeOnly)).not.toHaveProperty('envelope');
    const complete = buildHumanDispositionLedgerEntry({ reasonCode: 'bad_evidence' }, binding());
    expect(humanDispositionLedgerEntrySchema.parse(complete).envelope?.feedback).toEqual({
      reasonCode: 'bad_evidence',
    });
    for (const [field, value] of Object.entries({
      sourceRef: 'decision:f276:other',
      ownerUserId: 'user:other',
      producerCatId: 'codex-other',
      subjectRef: 'person:other',
      proposalId: 'proposal:other',
      decision: 'cancelled',
      decidedAt: baseBinding.decidedAt + 1,
    })) {
      expect(
        humanDispositionLedgerEntrySchema.safeParse({
          ...complete,
          envelope: { ...complete.envelope, [field]: value },
        }).success,
      ).toBe(false);
    }
    expect(humanDispositionLedgerEntrySchema.safeParse({ episode: complete.episode }).success).toBe(false);
    expect(
      humanDispositionLedgerEntrySchema.safeParse({
        ...complete,
        envelope: { ...complete.envelope, feedback: { reasonCode: 'wrong' } },
      }).success,
    ).toBe(false);
    expect(humanDispositionLedgerEntrySchema.safeParse({ ...complete, acceptanceRate: 1 }).success).toBe(false);
  });

  it('keeps the F281 receipt content-free and rejects producer or score projections', () => {
    const receipt = buildHumanDispositionLedgerReceipt(buildHumanDispositionLedgerEntry(undefined, binding()));
    expect(humanDispositionLedgerReceiptSchema.parse(receipt)).toEqual({
      sourceRef: baseBinding.sourceRef,
      subjectRef: baseBinding.subjectRef,
      interactionKind: baseBinding.interactionKind,
      decidedAt: baseBinding.decidedAt,
    });
    for (const field of ['feedback', 'reasonCode', 'detail', 'producerCatId', 'proposalId', 'decision', 'score']) {
      expect(humanDispositionLedgerReceiptSchema.safeParse({ ...receipt, [field]: 'forbidden' }).success).toBe(false);
    }
  });

  it('requires sourceRef as the durable idempotency identity input', () => {
    expect(humanDispositionServerBindingSchema.safeParse({ ...baseBinding, sourceRef: '' }).success).toBe(false);
    const original = envelope();
    expect(classifyHumanDispositionSourceReplay(original, envelope())).toBe('replay');
    expect(
      classifyHumanDispositionSourceReplay(
        original,
        humanDispositionEnvelopeSchema.parse({ ...original, feedback: { reasonCode: 'wrong' } }),
      ),
    ).toBe('conflict');
    expect(classifyHumanDispositionSourceReplay(original, envelope({ sourceRef: 'decision:f276:2' }))).toBe('distinct');
    expect(envelope({ sourceRef: 'decision:f276:2' }).sourceRef).toBe('decision:f276:2');
  });

  it('classifies optional producer feedback replay without allowing a late gift to overwrite truth', () => {
    expect(classifyHumanDispositionFeedbackReplay(undefined, undefined)).toBe('replay');
    expect(classifyHumanDispositionFeedbackReplay({ reasonCode: 'wrong' }, { reasonCode: 'wrong' })).toBe('replay');
    expect(
      classifyHumanDispositionFeedbackReplay(
        { reasonCode: 'other', detail: '证据对象错了' },
        { reasonCode: 'other', detail: '证据对象错了' },
      ),
    ).toBe('replay');
    expect(classifyHumanDispositionFeedbackReplay(undefined, { reasonCode: 'wrong' })).toBe('conflict');
    expect(classifyHumanDispositionFeedbackReplay({ reasonCode: 'wrong' }, undefined)).toBe('conflict');
    expect(classifyHumanDispositionFeedbackReplay({ reasonCode: 'wrong' }, { reasonCode: 'bad_evidence' })).toBe(
      'conflict',
    );
    expect(classifyHumanDispositionFeedbackReplay({ reasonCode: 'other', detail: '   ' }, undefined)).toBe('conflict');
  });

  it('injects only an exact subject and never expands exact_subject through a lane or cat', () => {
    const exact = envelope();
    expect(isHumanDispositionEnvelopeEligible(exact, context())).toBe(true);
    expect(isHumanDispositionEnvelopeEligible(exact, context({ subjectRef: 'person:someone-else' }))).toBe(false);
  });

  it('requires both exact subject and a verified exact root for proposal lineage', () => {
    const lineage = envelope({ scope: { kind: 'proposal_lineage', rootProposalId: 'root:memory:1' } });
    expect(
      isHumanDispositionEnvelopeEligible(
        lineage,
        context({ proposalLineage: { status: 'verified', rootProposalId: 'root:memory:1' } }),
      ),
    ).toBe(true);
    expect(
      isHumanDispositionEnvelopeEligible(
        lineage,
        context({ proposalLineage: { status: 'verified', rootProposalId: 'root:memory:other' } }),
      ),
    ).toBe(false);
    expect(isHumanDispositionEnvelopeEligible(lineage, context({ proposalLineage: { status: 'unknown' } }))).toBe(
      false,
    );
    expect(
      isHumanDispositionEnvelopeEligible(lineage, context({ proposalLineage: { status: 'not_applicable' } })),
    ).toBe(false);
    expect(
      isHumanDispositionEnvelopeEligible(
        lineage,
        context({
          subjectRef: 'person:someone-else',
          proposalLineage: { status: 'verified', rootProposalId: 'root:memory:1' },
        }),
      ),
    ).toBe(false);
  });

  it('fails closed for expiry and every revision invalidator uncertainty', () => {
    const expiring = envelope({ expiry: { kind: 'at', expiresAt: 100 } });
    expect(isHumanDispositionEnvelopeEligible(expiring, context({ now: 99 }))).toBe(true);
    expect(isHumanDispositionEnvelopeEligible(expiring, context({ now: 100 }))).toBe(false);
    expect(isHumanDispositionEnvelopeEligible(expiring, { ...context({ now: 99 }), now: Number.NaN })).toBe(false);

    const revision = envelope({ invalidator: { kind: 'subject_revision', expectedRevisionRef: 'rev:2' } });
    expect(
      isHumanDispositionEnvelopeEligible(
        revision,
        context({ invalidatorTruth: { kind: 'subject_revision', status: 'verified', currentRevisionRef: 'rev:2' } }),
      ),
    ).toBe(true);
    expect(
      isHumanDispositionEnvelopeEligible(
        revision,
        context({ invalidatorTruth: { kind: 'subject_revision', status: 'verified', currentRevisionRef: 'rev:1' } }),
      ),
    ).toBe(false);
    expect(
      isHumanDispositionEnvelopeEligible(
        revision,
        context({ invalidatorTruth: { kind: 'subject_revision', status: 'unknown' } }),
      ),
    ).toBe(false);
    expect(
      isHumanDispositionEnvelopeEligible(
        revision,
        context({ invalidatorTruth: { kind: 'source_superseded', status: 'unknown' } }),
      ),
    ).toBe(false);
  });

  it('fails closed for supersession uncertainty, mismatch, or a superseded source', () => {
    const supersession = envelope({ invalidator: { kind: 'source_superseded', supersessionKey: 'source:memory:1' } });
    expect(
      isHumanDispositionEnvelopeEligible(
        supersession,
        context({
          invalidatorTruth: {
            kind: 'source_superseded',
            status: 'verified',
            supersessionKey: 'source:memory:1',
            superseded: false,
          },
        }),
      ),
    ).toBe(true);
    expect(
      isHumanDispositionEnvelopeEligible(
        supersession,
        context({
          invalidatorTruth: {
            kind: 'source_superseded',
            status: 'verified',
            supersessionKey: 'source:memory:other',
            superseded: false,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isHumanDispositionEnvelopeEligible(
        supersession,
        context({
          invalidatorTruth: {
            kind: 'source_superseded',
            status: 'verified',
            supersessionKey: 'source:memory:1',
            superseded: true,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isHumanDispositionEnvelopeEligible(
        supersession,
        context({ invalidatorTruth: { kind: 'source_superseded', status: 'unknown' } }),
      ),
    ).toBe(false);
  });

  it('keeps other in the ledger-only path, never the automatic consumer path', () => {
    const other = buildHumanDispositionEnvelope(
      humanDispositionFeedbackInputSchema.parse({ reasonCode: 'other', detail: '这张卡让我无法判断' }),
      binding(),
    );
    if (!other) throw new Error('other feedback must still create a ledger envelope');
    expect(humanDispositionEnvelopeSchema.parse(other).feedback).toEqual({
      reasonCode: 'other',
      detail: '这张卡让我无法判断',
    });
    expect(isHumanDispositionEnvelopeEligible(other, context())).toBe(false);
  });

  it('derives automatic eligibility from the correction table for every reason code', () => {
    for (const reasonCode of HUMAN_DISPOSITION_REASON_CODES) {
      const feedback =
        reasonCode === 'other'
          ? humanDispositionFeedbackInputSchema.parse({ reasonCode, detail: '需要人工判断' })
          : humanDispositionFeedbackInputSchema.parse({ reasonCode });
      const candidate = buildHumanDispositionEnvelope(feedback, binding());
      if (!candidate) throw new Error('feedback fixture must create an envelope');
      expect(isHumanDispositionEnvelopeEligible(candidate, context())).toBe(
        HUMAN_DISPOSITION_REASON_CORRECTIONS[reasonCode].autoInject,
      );
    }
  });
});
