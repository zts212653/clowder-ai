import { describe, expect, it } from 'vitest';
import { projectCliToolUseLabel } from '../src/cli-tool-label.js';
import { MessageBundleCarrierV1Schema, MessageBundleSelectionSchema } from '../src/schemas/message-bundle.schema.js';

const digest = 'a'.repeat(64);

describe('canonical CLI tool label projection', () => {
  it('keeps the visible Web label and server-side source verification identical', () => {
    expect(projectCliToolUseLabel('codex-sol → Read', '{"file_path":"src/index.ts"}')).toBe('Read src/index.ts');
    expect(projectCliToolUseLabel('opus → Bash', '{"command":"pnpm test","unfinished":')).toBe('Bash pnpm test');
    expect(projectCliToolUseLabel('opus → Read', JSON.stringify({ file_path: 'a'.repeat(80) }))).toBe(
      `Read ${'a'.repeat(57)}...`,
    );
  });
});

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

  it('requires valid Quote offsets, a known projection version, and a lowercase 64-char digest', () => {
    const baseQuote = {
      kind: 'quote',
      messageId: 'message-2',
      selectionStart: 3,
      selectionEnd: 8,
      sourceProjectionVersion: 1,
      sourceProjectionSha256: digest,
    };

    expect(MessageBundleCarrierV1Schema.safeParse(carrier([{ ...baseQuote, selectionEnd: 3 }])).success).toBe(false);
    // Historical v1/v2 row planes and the v3 canonical-bubble plane remain resolvable.
    expect(
      MessageBundleCarrierV1Schema.safeParse(carrier([{ ...baseQuote, sourceProjectionVersion: 2 }])).success,
    ).toBe(true);
    expect(
      MessageBundleCarrierV1Schema.safeParse(carrier([{ ...baseQuote, sourceProjectionVersion: 3 }])).success,
    ).toBe(true);
    expect(
      MessageBundleCarrierV1Schema.safeParse(carrier([{ ...baseQuote, sourceProjectionVersion: 4 }])).success,
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

  it('accepts an attributed bundle note plus refs-only CLI Quote and Rich Block items', () => {
    const result = MessageBundleCarrierV1Schema.safeParse({
      ...carrier([
        {
          kind: 'cli_quote',
          messageId: 'message-cli',
          sourceMessageIds: ['message-cli', 'message-cli-stream'],
          segmentId: 'stdout',
          selectionStart: 6,
          selectionEnd: 10,
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digest,
          comment: 'this exact phrase',
        },
        {
          kind: 'rich_block',
          messageId: 'message-rich',
          sourceMessageIds: ['message-rich'],
          blockId: 'decision-card',
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digest,
        },
      ]),
      note: '  why I am forwarding this  ',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.note).toBe('why I am forwarding this');
  });

  it('keeps raw CLI carriers on v1 while accepting durable Markdown-readable CLI carriers on v2', () => {
    const cliQuote = {
      kind: 'cli_quote',
      messageId: 'message-cli',
      sourceMessageIds: ['message-cli'],
      segmentId: 'stdout',
      selectionStart: 6,
      selectionEnd: 10,
      sourceProjectionVersion: 1,
      sourceProjectionSha256: digest,
    };

    expect(MessageBundleCarrierV1Schema.safeParse(carrier([cliQuote])).success).toBe(true);
    expect(MessageBundleCarrierV1Schema.safeParse(carrier([{ ...cliQuote, sourceProjectionVersion: 2 }])).success).toBe(
      true,
    );
    expect(
      MessageBundleCarrierV1Schema.safeParse(
        carrier([{ ...cliQuote, segmentId: 'tool-detail:tool-1', sourceProjectionVersion: 2 }]),
      ).success,
    ).toBe(false);
    expect(MessageBundleCarrierV1Schema.safeParse(carrier([{ ...cliQuote, sourceProjectionVersion: 3 }])).success).toBe(
      false,
    );
  });

  it('rejects malformed CLI/Rich refs and copied source payloads', () => {
    const cliQuote = {
      kind: 'cli_quote',
      messageId: 'message-cli',
      sourceMessageIds: ['message-cli'],
      segmentId: 'stdout',
      selectionStart: 6,
      selectionEnd: 10,
      sourceProjectionVersion: 1,
      sourceProjectionSha256: digest,
    };
    const richBlock = {
      kind: 'rich_block',
      messageId: 'message-rich',
      sourceMessageIds: ['message-rich'],
      blockId: 'decision-card',
      sourceProjectionVersion: 1,
      sourceProjectionSha256: digest,
    };

    expect(MessageBundleCarrierV1Schema.safeParse(carrier([{ ...cliQuote, selectionEnd: 6 }])).success).toBe(false);
    expect(
      MessageBundleCarrierV1Schema.safeParse(carrier([{ ...cliQuote, sourceMessageIds: ['another-message'] }])).success,
    ).toBe(false);
    expect(
      MessageBundleCarrierV1Schema.safeParse(
        carrier([{ ...cliQuote, sourceMessageIds: ['message-cli', 'message-cli'] }]),
      ).success,
    ).toBe(false);
    expect(MessageBundleCarrierV1Schema.safeParse(carrier([{ ...cliQuote, text: 'copied text' }])).success).toBe(false);
    expect(
      MessageBundleCarrierV1Schema.safeParse(carrier([{ ...richBlock, block: { title: 'copied' } }])).success,
    ).toBe(false);
    expect(MessageBundleCarrierV1Schema.safeParse({ ...carrier([richBlock]), note: 'x'.repeat(10_001) }).success).toBe(
      false,
    );
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

  it('accepts CLI text evidence and a Rich Block identity without accepting a client block payload', () => {
    const selection = {
      sourceThreadId: 'thread-source',
      note: 'context for the recipients',
      items: [
        {
          kind: 'cli_quote',
          messageId: 'message-cli',
          sourceMessageIds: ['message-cli'],
          segmentId: 'tool-detail:tool-1',
          text: 'exact selected text',
          selectionStart: 2,
          selectionEnd: 21,
        },
        {
          kind: 'rich_block',
          messageId: 'message-rich',
          sourceMessageIds: ['message-rich'],
          blockId: 'decision-card',
        },
      ],
    };

    expect(MessageBundleSelectionSchema.safeParse(selection).success).toBe(true);
    expect(
      MessageBundleSelectionSchema.safeParse({
        ...selection,
        items: [{ ...selection.items[1], block: { title: 'client payload' } }],
      }).success,
    ).toBe(false);
  });

  it('accepts an explicit Markdown-readable CLI selection proof without changing legacy raw selections', () => {
    const base = {
      kind: 'cli_quote',
      messageId: 'message-cli',
      sourceMessageIds: ['message-cli'],
      segmentId: 'stdout',
      text: 'visible table row',
      selectionStart: 2,
      selectionEnd: 19,
    };

    expect(MessageBundleSelectionSchema.safeParse({ sourceThreadId: 'thread-source', items: [base] }).success).toBe(
      true,
    );
    expect(
      MessageBundleSelectionSchema.safeParse({
        sourceThreadId: 'thread-source',
        items: [{ ...base, sourceProjectionVersion: 2, renderedOccurrences: 1 }],
      }).success,
    ).toBe(true);
    expect(
      MessageBundleSelectionSchema.safeParse({
        sourceThreadId: 'thread-source',
        items: [
          {
            ...base,
            segmentId: 'tool-detail:tool-1',
            sourceProjectionVersion: 2,
            renderedOccurrences: 1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      MessageBundleSelectionSchema.safeParse({
        sourceThreadId: 'thread-source',
        items: [{ ...base, sourceProjectionVersion: 3, renderedOccurrences: 1 }],
      }).success,
    ).toBe(false);
  });
});
