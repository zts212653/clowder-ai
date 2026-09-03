import { describe, expect, it } from 'vitest';
import { custodyAdmissionRequestV1Schema } from '../types/entrusted-work-actions.js';
import {
  custodyOfferV1Schema,
  entrustedWorkOwnerReadV1Schema,
  entrustedWorkV1Schema,
  producerAttentionReceiptV1Schema,
} from '../types/growing.js';

const sourceMessageRevision = `sha256:${'a'.repeat(64)}`;

const admittedOffer = {
  disposition: 'accepted' as const,
  offerId: 'custody-offer:tomorrows-ppt',
  sourceMessageRevision,
  policyVersion: 'f310.phase-b.v1',
  reasonCode: 'plausible_future_obligation',
  actorRef: 'user:operator',
  dispositionAt: 1_788_192_000_000,
  admission: {
    state: 'resulted' as const,
    idempotencyKey: 'message:tomorrows-ppt#custody',
    result: {
      result: 'admitted' as const,
      subjectRef: 'task:work:tomorrows-ppt',
      ownerRef: 'task:item:tomorrows-ppt',
      revision: 7,
      receiptRef: 'task:receipt:tomorrows-ppt:7',
    },
  },
};

const entrustedWork = {
  revision: 7,
  admission: {
    basis: 'accepted_offer' as const,
    sourceRefs: ['message:tomorrows-ppt'],
    idempotencyKey: 'message:tomorrows-ppt#custody',
    receiptRef: 'task:receipt:tomorrows-ppt:7',
    admittedAt: 1_788_192_000_000,
  },
  intendedOutcome: 'A reviewable presentation for tomorrow',
  time: {
    businessDeadline: { value: 1_788_278_400_000, sourceRef: 'message:tomorrows-ppt' },
    reviewBy: { value: 1_788_235_200_000, sourceRef: 'message:tomorrows-ppt' },
  },
  artifactRefs: ['artifact:ppt:tomorrows-ppt'],
  closure: {
    condition: 'The owner accepts the delivered presentation',
    expectedSignal: 'artifact_acceptance',
    state: 'open' as const,
    evidenceRefs: [],
  },
};

const eligibleReceipt = {
  eligible: true as const,
  producer: {
    producerId: 'f246.approval' as const,
    ownerRef: 'approval:proposal:ppt-direction',
    subjectRef: 'approval:proposal:ppt-direction',
    revision: 12,
  },
  taskRef: { subjectRef: 'task:work:tomorrows-ppt', observedRevision: 7 },
  kind: 'judgment' as const,
  reasonCode: 'artifact_direction_choice',
  recommendation: 'Use the evidence-first narrative',
  salience: 'normal' as const,
  action: {
    actionRef: 'approval:proposal:ppt-direction#decide',
    expectedProducerRevision: 12,
  },
  reEvaluateActionRef: 'approval:proposal:ppt-direction#reevaluate',
};

const ownerRead = {
  envelope: {
    subjectRef: 'task:work:tomorrows-ppt',
    ownerRef: 'task:item:tomorrows-ppt',
    sourceRefs: ['message:tomorrows-ppt'],
    revision: 7,
    freshness: { state: 'current' as const, observedRevision: 7 },
    visibility: { ownerUserId: 'operator', human: true, cat: true },
  },
  preparedArtifact: {
    artifactRef: 'artifact:ppt:tomorrows-ppt',
    artifactRevision: '7',
    completenessRef: 'artifact:ppt:tomorrows-ppt#completeness:7',
    previewRef: 'artifact:ppt:tomorrows-ppt#preview:7',
    openInWorkspaceRef: 'workspace:artifact:ppt:tomorrows-ppt:7',
  },
  timeRefs: [
    {
      role: 'business_deadline' as const,
      subjectRef: 'task:work:tomorrows-ppt',
      ownerRef: 'task:item:tomorrows-ppt',
      revision: 7,
      value: 1_788_278_400_000,
    },
    {
      role: 'review_by' as const,
      subjectRef: 'task:work:tomorrows-ppt',
      ownerRef: 'task:item:tomorrows-ppt',
      revision: 7,
      value: 1_788_235_200_000,
    },
  ],
  attentionReceipts: [eligibleReceipt],
};

describe('F310 shared Growing contracts', () => {
  it('accepts complete source, Task, producer, and owner-read truth', () => {
    expect(custodyOfferV1Schema.parse(admittedOffer)).toEqual(admittedOffer);
    expect(entrustedWorkV1Schema.parse(entrustedWork)).toEqual(entrustedWork);
    expect(producerAttentionReceiptV1Schema.parse(eligibleReceipt)).toEqual(eligibleReceipt);
    expect(entrustedWorkOwnerReadV1Schema.parse(ownerRead)).toEqual(ownerRead);
  });

  it('rejects accepted custody without a complete admission state', () => {
    expect(custodyOfferV1Schema.safeParse({ ...admittedOffer, admission: undefined }).success).toBe(false);
    expect(
      custodyOfferV1Schema.safeParse({
        ...admittedOffer,
        admission: {
          state: 'resulted',
          idempotencyKey: admittedOffer.admission.idempotencyKey,
          result: { result: 'admitted', subjectRef: 'task:work:tomorrows-ppt' },
        },
      }).success,
    ).toBe(false);
  });

  it('requires exact source-owner coordinates for accepted-offer Task admission', () => {
    const admission = {
      basis: 'accepted_offer' as const,
      sourceRefs: ['message:tomorrows-ppt'],
      offerId: admittedOffer.offerId,
      sourceMessageRevision,
      intendedOutcome: 'A reviewable presentation for tomorrow',
      idempotencyKey: admittedOffer.admission.idempotencyKey,
    };
    expect(custodyAdmissionRequestV1Schema.parse(admission)).toEqual(admission);
    expect(custodyAdmissionRequestV1Schema.safeParse({ ...admission, offerId: undefined }).success).toBe(false);
    expect(custodyAdmissionRequestV1Schema.safeParse({ ...admission, sourceMessageRevision: undefined }).success).toBe(
      false,
    );
  });

  it('rejects terminal refusal without actor/time and rejects mutable or unknown source revisions', () => {
    const refusal = {
      disposition: 'declined' as const,
      offerId: 'custody-offer:declined',
      sourceMessageRevision,
      policyVersion: 'f310.phase-b.v1',
      reasonCode: 'owner_declined',
      actorRef: 'user:operator',
      dispositionAt: 1_788_192_000_000,
    };
    expect(custodyOfferV1Schema.parse(refusal)).toEqual(refusal);
    expect(custodyOfferV1Schema.safeParse({ ...refusal, actorRef: undefined }).success).toBe(false);
    expect(custodyOfferV1Schema.safeParse({ ...refusal, dispositionAt: undefined }).success).toBe(false);
    expect(custodyOfferV1Schema.safeParse({ ...refusal, sourceMessageRevision: 7 }).success).toBe(false);
    expect(custodyOfferV1Schema.safeParse({ ...refusal, sourceMessageRevision: 'sha256:mutable' }).success).toBe(false);
  });

  it('requires visible owner coordinates and a truthful freshness relation', () => {
    const withoutVisibility = {
      ...ownerRead,
      envelope: { ...ownerRead.envelope, visibility: undefined },
    };
    expect(entrustedWorkOwnerReadV1Schema.safeParse(withoutVisibility).success).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        envelope: {
          ...ownerRead.envelope,
          freshness: { state: 'current', observedRevision: 6 },
        },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        envelope: {
          ...ownerRead.envelope,
          freshness: { state: 'stale', observedRevision: 7 },
        },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        envelope: {
          ...ownerRead.envelope,
          freshness: { state: 'stale', observedRevision: 6 },
        },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        envelope: {
          ...ownerRead.envelope,
          freshness: { state: 'stale', observedRevision: 6 },
        },
        attentionReceipts: [],
      }).success,
    ).toBe(true);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        envelope: {
          ...ownerRead.envelope,
          freshness: { state: 'stale', observedRevision: 6 },
        },
        attentionReceipts: [
          {
            eligible: false,
            producer: eligibleReceipt.producer,
            taskRef: eligibleReceipt.taskRef,
            reEvaluateActionRef: eligibleReceipt.reEvaluateActionRef,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires typed disposition provenance before Task cancellation or abandonment', () => {
    const cancelled = {
      ...entrustedWork,
      closure: {
        ...entrustedWork.closure,
        state: 'cancelled' as const,
        disposition: {
          kind: 'cancelled' as const,
          actorKind: 'human' as const,
          actorRef: 'user:operator',
          authorityRef: 'task:item:tomorrows-ppt#cancel',
          dispositionRef: 'message:tomorrows-ppt#cancelled',
          disposedAt: 1_788_193_000_000,
        },
      },
    };
    const abandoned = {
      ...entrustedWork,
      closure: {
        ...entrustedWork.closure,
        state: 'abandoned' as const,
        disposition: {
          kind: 'abandoned' as const,
          actorKind: 'owner' as const,
          actorRef: 'task:item:tomorrows-ppt',
          authorityRef: 'task:policy:abandon-stale-work',
          dispositionRef: 'task:disposition:tomorrows-ppt:abandoned',
          disposedAt: 1_788_193_000_000,
        },
      },
    };

    expect(entrustedWorkV1Schema.safeParse(cancelled).success).toBe(true);
    expect(entrustedWorkV1Schema.safeParse(abandoned).success).toBe(true);
    expect(
      entrustedWorkV1Schema.safeParse({
        ...cancelled,
        closure: { ...cancelled.closure, disposition: undefined },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkV1Schema.safeParse({
        ...abandoned,
        closure: { ...abandoned.closure, disposition: undefined },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkV1Schema.safeParse({
        ...cancelled,
        closure: {
          ...cancelled.closure,
          disposition: { ...cancelled.closure.disposition, kind: 'abandoned' },
        },
      }).success,
    ).toBe(false);
    for (const field of ['actorKind', 'actorRef', 'authorityRef', 'dispositionRef', 'disposedAt'] as const) {
      expect(
        entrustedWorkV1Schema.safeParse({
          ...cancelled,
          closure: {
            ...cancelled.closure,
            disposition: { ...cancelled.closure.disposition, [field]: undefined },
          },
        }).success,
      ).toBe(false);
    }
  });

  it('requires typed time roles and current producer identity/revisions', () => {
    const [deadline] = ownerRead.timeRefs;
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        timeRefs: [{ ...deadline, role: 'due_at' }],
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        timeRefs: [{ ...deadline, subjectRef: undefined }],
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        attentionReceipts: [{ ...eligibleReceipt, producer: { ...eligibleReceipt.producer, ownerRef: undefined } }],
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        attentionReceipts: [
          { ...eligibleReceipt, action: { ...eligibleReceipt.action, expectedProducerRevision: 11 } },
        ],
      }).success,
    ).toBe(false);
  });

  it('structurally rejects Task-side judgment, recommendation, salience, or action mirrors', () => {
    for (const forbidden of [
      { judgment: 'needs_owner' },
      { recommendation: 'Use the evidence-first narrative' },
      { salience: 'high_risk' },
      { action: { actionRef: 'approval:proposal:ppt-direction#decide' } },
    ]) {
      expect(entrustedWorkV1Schema.safeParse({ ...entrustedWork, ...forbidden }).success).toBe(false);
    }
  });
});
