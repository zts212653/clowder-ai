import { describe, expect, it } from 'vitest';
import {
  contentModificationFollowUpCarrierV1Schema,
  contentModificationReceiptV1Schema,
  contentModificationRequestCarrierV1Schema,
} from '../index.js';

const base = {
  v: 1 as const,
  requestId: `f309-modification-${'a'.repeat(64)}`,
  sourceMessageId: 'message-human-1',
  targetCatId: 'codex-astra',
  taskId: 'task-1',
  receiptRef: 'receipt-1',
  observedAt: 1_790_967_000_000,
};

describe('contentModificationReceiptV1Schema', () => {
  it('binds a candidate to the request without starting an empty acknowledgement', () => {
    expect(
      contentModificationReceiptV1Schema.parse({
        ...base,
        state: 'candidate',
        candidateRef: 'content-patch:request:1',
        followUp: { kind: 'none', reason: 'not_applicable' },
      }),
    ).toMatchObject({ state: 'candidate', candidateRef: 'content-patch:request:1' });
  });

  it('allows an honestly unverified unknown result without inventing a candidate', () => {
    expect(
      contentModificationReceiptV1Schema.safeParse({
        ...base,
        state: 'unknown',
        followUp: { kind: 'unverified' },
      }).success,
    ).toBe(true);
  });

  it('requires candidate identity for candidate, rejection and known writeback outcomes', () => {
    for (const state of ['candidate', 'rejected', 'applied', 'conflict'] as const) {
      expect(
        contentModificationReceiptV1Schema.safeParse({
          ...base,
          state,
          followUp: { kind: 'none', reason: 'not_applicable' },
        }).success,
      ).toBe(false);
    }
  });

  it('carries the exact durable wake carrier when an open owner Task needs diagnosis', () => {
    expect(
      contentModificationReceiptV1Schema.safeParse({
        ...base,
        state: 'conflict',
        candidateRef: 'content-patch:request:1',
        followUp: { kind: 'cat_woken', executionRef: 'message:wake-1#queue-custody' },
      }).success,
    ).toBe(true);
  });
});

describe('contentModificationFollowUpCarrierV1Schema', () => {
  const carrier = {
    v: 1 as const,
    requestId: base.requestId,
    sourceMessageId: base.sourceMessageId,
    targetCatId: base.targetCatId,
    taskId: base.taskId,
    candidateRef: 'content-patch:request:1',
    receiptRef: base.receiptRef,
  };

  it('binds conflict and unknown Queue work to the exact source, owner and receipt', () => {
    for (const state of ['conflict', 'unknown'] as const) {
      expect(contentModificationFollowUpCarrierV1Schema.safeParse({ ...carrier, state }).success).toBe(true);
    }
  });

  it('rejects ordinary dispositions and untyped extra source fields', () => {
    expect(contentModificationFollowUpCarrierV1Schema.safeParse({ ...carrier, state: 'applied' }).success).toBe(false);
    expect(
      contentModificationFollowUpCarrierV1Schema.safeParse({ ...carrier, state: 'conflict', visibility: 'whisper' })
        .success,
    ).toBe(false);
  });
});

describe('contentModificationRequestCarrierV1Schema', () => {
  const carrier = {
    v: 1 as const,
    kind: 'request_text_edit' as const,
    requestId: base.requestId,
    sourceMessageId: base.sourceMessageId,
    targetCatId: base.targetCatId,
    taskId: base.taskId,
    expectedTaskRevision: 1,
    requestReceiptRef: `${base.requestId}#request`,
  };

  it('binds the initial Queue request to its exact source, Task, owner and receipt', () => {
    expect(contentModificationRequestCarrierV1Schema.safeParse(carrier).success).toBe(true);
  });

  it.each([
    'request_image_edit',
    'request_media_edit',
    'supersede_request',
  ])('binds the media %s request variant', (kind) => {
    expect(contentModificationRequestCarrierV1Schema.safeParse({ ...carrier, kind }).success).toBe(true);
  });

  it.each(['decide', 'reopen', 'submit_feedback'])('does not turn a %s receipt into a request carrier', (kind) => {
    expect(contentModificationRequestCarrierV1Schema.safeParse({ ...carrier, kind }).success).toBe(false);
  });

  it('rejects untyped audience fields and incomplete Task coordinates', () => {
    expect(contentModificationRequestCarrierV1Schema.safeParse({ ...carrier, visibility: 'whisper' }).success).toBe(
      false,
    );
    const { expectedTaskRevision: _, ...incomplete } = carrier;
    expect(contentModificationRequestCarrierV1Schema.safeParse(incomplete).success).toBe(false);
  });
});
