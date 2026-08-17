import { describe, expect, it } from 'vitest';
import { MessageBundleCarrierV1Schema, MessageBundleSelectionSchema } from '../src/schemas/message-bundle.schema.js';

const digest = 'a'.repeat(64);

function carrier(items: unknown[]) {
  return {
    v: 1,
    sourceThreadId: 'thread-source',
    items,
  };
}

describe('F294 MessageBundleCarrierV1Schema', () => {
  it('accepts whole-message and anchored Quote refs without copying source bodies', () => {
    const result = MessageBundleCarrierV1Schema.safeParse(
      carrier([
        { kind: 'message', messageId: 'message-1' },
        {
          kind: 'quote',
          messageId: 'message-2',
          selectionStart: 3,
          selectionEnd: 8,
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digest,
          comment: 'Why this excerpt matters',
        },
      ]),
    );

    expect(result.success).toBe(true);
  });

  it('requires between 1 and 50 items', () => {
    expect(MessageBundleCarrierV1Schema.safeParse(carrier([])).success).toBe(false);
    expect(
      MessageBundleCarrierV1Schema.safeParse(
        carrier(Array.from({ length: 50 }, (_, index) => ({ kind: 'message', messageId: `message-${index}` }))),
      ).success,
    ).toBe(true);
    expect(
      MessageBundleCarrierV1Schema.safeParse(
        carrier(Array.from({ length: 51 }, (_, index) => ({ kind: 'message', messageId: `message-${index}` }))),
      ).success,
    ).toBe(false);
  });

  it('rejects duplicate message identities across whole-message and Quote refs', () => {
    expect(
      MessageBundleCarrierV1Schema.safeParse(
        carrier([
          { kind: 'message', messageId: 'message-1' },
          {
            kind: 'quote',
            messageId: 'message-1',
            selectionStart: 0,
            selectionEnd: 4,
            sourceProjectionVersion: 1,
            sourceProjectionSha256: digest,
          },
        ]),
      ).success,
    ).toBe(false);
  });

  it('rejects copied body/text and admission-only target cats at every carrier boundary', () => {
    expect(
      MessageBundleCarrierV1Schema.safeParse({
        ...carrier([{ kind: 'message', messageId: 'message-1' }]),
        targetCats: ['codex-sol'],
      }).success,
    ).toBe(false);
    expect(
      MessageBundleCarrierV1Schema.safeParse(carrier([{ kind: 'message', messageId: 'message-1', body: 'copy' }]))
        .success,
    ).toBe(false);
    expect(
      MessageBundleCarrierV1Schema.safeParse(
        carrier([
          {
            kind: 'quote',
            messageId: 'message-2',
            selectionStart: 0,
            selectionEnd: 4,
            sourceProjectionVersion: 1,
            sourceProjectionSha256: digest,
            text: 'copy',
          },
        ]),
      ).success,
    ).toBe(false);
  });

  it('requires valid Quote offsets, v1 projection, and a lowercase 64-char digest', () => {
    const baseQuote = {
      kind: 'quote',
      messageId: 'message-2',
      selectionStart: 3,
      selectionEnd: 8,
      sourceProjectionVersion: 1,
      sourceProjectionSha256: digest,
    };

    expect(MessageBundleCarrierV1Schema.safeParse(carrier([{ ...baseQuote, selectionEnd: 3 }])).success).toBe(false);
    expect(
      MessageBundleCarrierV1Schema.safeParse(carrier([{ ...baseQuote, sourceProjectionVersion: 2 }])).success,
    ).toBe(false);
    expect(
      MessageBundleCarrierV1Schema.safeParse(carrier([{ ...baseQuote, sourceProjectionSha256: 'A'.repeat(64) }]))
        .success,
    ).toBe(false);
    expect(
      MessageBundleCarrierV1Schema.safeParse(carrier([{ ...baseQuote, sourceProjectionSha256: 'a'.repeat(63) }]))
        .success,
    ).toBe(false);
  });
});

describe('F294 MessageBundleSelectionSchema', () => {
  it('accepts temporary Quote evidence while keeping the durable carrier strict', () => {
    const selection = {
      sourceThreadId: 'thread-source',
      items: [
        {
          kind: 'quote',
          messageId: 'message-1',
          text: 'selected evidence',
          selectionStart: 2,
          selectionEnd: 19,
          comment: 'why it matters',
        },
      ],
    };

    expect(MessageBundleSelectionSchema.safeParse(selection).success).toBe(true);
    expect(
      MessageBundleCarrierV1Schema.safeParse({
        v: 1,
        sourceThreadId: selection.sourceThreadId,
        items: selection.items,
      }).success,
    ).toBe(false);
  });
});
