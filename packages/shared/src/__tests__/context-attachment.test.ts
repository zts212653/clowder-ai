import { describe, expect, it } from 'vitest';
import {
  ContextAttachmentContentSchema,
  ContextAttachmentSchema,
  ContextAttachmentsSchema,
  contentModificationRequestContractSchema,
  contentModificationRequestSchema,
  contentModificationTakeoverSchema,
  MessageContentSchema,
  MessageContentsSchema,
  normalizeModificationSelections,
  respondContentTextSchema,
  VersionBoundContextAttachmentsSchema,
} from '../index.js';

const threadAttachment = {
  v: 1,
  id: 'ctx-thread-1',
  kind: 'thread',
  threadId: 'thread_abc123',
  title: 'F063 Context Attachments',
} as const;

describe('ContextAttachmentSchema', () => {
  it('retains a Channel quote in the same sourced quote contract without inventing a private Thread', () => {
    const quote = {
      v: 1,
      id: 'ctx-channel-quote',
      kind: 'quote',
      text: '这张图可以直接打开。',
      selectionStart: 2,
      selectionEnd: 14,
      source: {
        kind: 'collective_message',
        serviceInstanceId: 'svc_service01',
        collectiveId: 'col_collective01',
        channelId: 'general',
        eventId: 'evt_message01',
      },
    };
    expect(ContextAttachmentSchema.parse(quote)).toEqual(quote);
    expect(
      ContextAttachmentSchema.safeParse({ ...quote, source: { ...quote.source, threadId: 'private-thread' } }).success,
    ).toBe(false);
    expect(ContextAttachmentsSchema.safeParse([quote]).success).toBe(true);
  });
  it('preserves bounded source attribution separately from a user-authored quote comment', () => {
    const attachment = {
      v: 1,
      id: 'ctx-citation',
      kind: 'quote',
      text: '原文',
      source: {
        kind: 'message',
        threadId: 'thread-original',
        messageId: 'original',
        displayLabel: 'You · 10-15 09:08 · 已定',
      },
    };
    const parsed = ContextAttachmentSchema.parse(attachment);
    expect(parsed).toEqual(attachment);
    expect('comment' in parsed).toBe(false);
    expect(
      ContextAttachmentSchema.safeParse({
        ...attachment,
        source: { ...attachment.source, displayLabel: 'x'.repeat(513) },
      }).success,
    ).toBe(false);
  });

  it('accepts the versioned thread, workspace file, and sourced quote variants', () => {
    expect(ContextAttachmentSchema.parse(threadAttachment)).toEqual(threadAttachment);
    expect(
      ContextAttachmentSchema.parse({
        v: 1,
        id: 'ctx-file-1',
        kind: 'workspace_file',
        path: 'packages/web/src/components/ChatInput.tsx',
        worktreeId: 'wt-f063',
        branch: 'feat/f063-context-attachments',
        revision: `sha256:${'a'.repeat(64)}`,
        lineStart: 177,
        lineEnd: 245,
      }),
    ).toMatchObject({
      kind: 'workspace_file',
      revision: `sha256:${'a'.repeat(64)}`,
      lineStart: 177,
      lineEnd: 245,
    });
    expect(
      ContextAttachmentSchema.parse({
        v: 1,
        id: 'ctx-workspace-quote-1',
        kind: 'quote',
        text: 'const answer = 42;',
        source: {
          kind: 'workspace_file',
          path: 'src/answer.ts',
          worktreeId: 'wt-f063',
          revision: `sha256:${'b'.repeat(64)}`,
          lineStart: 3,
          lineEnd: 3,
        },
      }),
    ).toMatchObject({
      kind: 'quote',
      source: { kind: 'workspace_file', revision: `sha256:${'b'.repeat(64)}` },
    });
    expect(
      ContextAttachmentSchema.parse({
        v: 1,
        id: 'ctx-quote-1',
        kind: 'quote',
        text: 'selected CLI output',
        comment: 'This output explains the failure.',
        selectionStart: 8,
        selectionEnd: 23,
        source: { kind: 'cli_output', threadId: 'thread_abc123', messageId: 'msg_1', segmentId: 'stdout' },
      }),
    ).toMatchObject({
      kind: 'quote',
      comment: 'This output explains the failure.',
      selectionStart: 8,
      selectionEnd: 23,
      source: { kind: 'cli_output', segmentId: 'stdout' },
    });
  });

  it('keeps quote comments bounded and requires complete ordered selection coordinates', () => {
    const quote = {
      v: 1,
      id: 'ctx-quote-commented',
      kind: 'quote',
      text: 'selected message text',
      source: { kind: 'message', threadId: 'thread_abc123', messageId: 'msg_1' },
    } as const;

    expect(ContextAttachmentSchema.safeParse({ ...quote, comment: '   ' }).success).toBe(false);
    expect(
      ContextAttachmentSchema.safeParse({
        ...quote,
        comment: 'x'.repeat(10_001),
      }).success,
    ).toBe(false);
    expect(ContextAttachmentSchema.safeParse({ ...quote, selectionStart: 2 }).success).toBe(false);
    expect(ContextAttachmentSchema.safeParse({ ...quote, selectionStart: 8, selectionEnd: 8 }).success).toBe(false);
    expect(ContextAttachmentSchema.safeParse({ ...quote, selectionStart: 8, selectionEnd: 4 }).success).toBe(false);
    expect(
      ContextAttachmentSchema.safeParse({
        ...quote,
        selectionStart: 0,
        selectionEnd: 8,
        source: { kind: 'cli_output', threadId: 'thread_abc123', messageId: 'msg_1' },
      }).success,
    ).toBe(false);
  });

  it('fails closed for future versions, unknown fields, invalid ranges, and overlong quotes', () => {
    expect(ContextAttachmentSchema.safeParse({ ...threadAttachment, v: 2 }).success).toBe(false);
    expect(
      ContextAttachmentSchema.safeParse({ ...threadAttachment, legacyHref: '/thread/thread_abc123' }).success,
    ).toBe(false);
    expect(
      ContextAttachmentSchema.safeParse({
        v: 1,
        id: 'ctx-file-2',
        kind: 'workspace_file',
        path: 'README.md',
        lineStart: 20,
        lineEnd: 10,
      }).success,
    ).toBe(false);
    expect(
      ContextAttachmentSchema.safeParse({
        v: 1,
        id: 'ctx-file-bad-revision',
        kind: 'workspace_file',
        path: 'README.md',
        revision: 'v1',
      }).success,
    ).toBe(false);
    expect(
      ContextAttachmentSchema.safeParse({
        v: 1,
        id: 'ctx-quote-2',
        kind: 'quote',
        text: 'x'.repeat(20_001),
        source: { kind: 'message', threadId: 'thread_abc123', messageId: 'msg_1' },
      }).success,
    ).toBe(false);
  });

  it('is the context_attachment variant of the shared MessageContent contract', () => {
    const block = { type: 'context_attachment', attachment: threadAttachment } as const;
    expect(ContextAttachmentContentSchema.parse(block)).toEqual(block);
    expect(MessageContentSchema.parse(block)).toEqual(block);
  });

  it('rejects an attachment collection whose aggregate prompt payload exceeds the bounded contract', () => {
    const maximalQuotes = Array.from({ length: 12 }, (_, index) => ({
      v: 1 as const,
      id: `ctx-quote-${index}`,
      kind: 'quote' as const,
      text: 'x'.repeat(20_000),
      source: { kind: 'message' as const, threadId: 'thread_abc123', messageId: `msg_${index}` },
    }));

    expect(ContextAttachmentsSchema.safeParse(maximalQuotes).success).toBe(false);
    expect(
      MessageContentsSchema.safeParse(maximalQuotes.map((attachment) => ({ type: 'context_attachment', attachment })))
        .success,
    ).toBe(false);
  });

  it('accepts canonical persisted upload images without accepting traversal-like relative paths', () => {
    expect(MessageContentSchema.safeParse({ type: 'image', url: '/uploads/evidence.png' }).success).toBe(true);
    expect(MessageContentSchema.safeParse({ type: 'image', url: '/uploads/../evidence.png' }).success).toBe(false);
  });

  it('accepts canonical persisted generic files without accepting traversal-like relative paths', () => {
    const file = {
      type: 'file',
      url: '/uploads/evidence.pdf',
      fileName: 'evidence.pdf',
      mimeType: 'application/pdf',
      fileSize: 42,
    };
    expect(MessageContentSchema.safeParse(file).success).toBe(true);
    expect(MessageContentSchema.safeParse({ ...file, url: '/uploads/../evidence.pdf' }).success).toBe(false);
  });

  it('keeps legacy unversioned references readable but rejects them on the new Cat writer boundary', () => {
    const legacy = {
      v: 1 as const,
      id: 'ctx-legacy-file',
      kind: 'workspace_file' as const,
      path: 'docs/legacy.md',
    };
    expect(ContextAttachmentsSchema.safeParse([legacy]).success).toBe(true);
    expect(VersionBoundContextAttachmentsSchema.safeParse([legacy]).success).toBe(false);
    expect(
      VersionBoundContextAttachmentsSchema.safeParse([{ ...legacy, revision: `sha256:${'f'.repeat(64)}` }]).success,
    ).toBe(true);
  });
});

describe('message-origin content modification contract', () => {
  const revision = `sha256:${'a'.repeat(64)}`;
  const anchor = (quote: string, start: number) => ({
    kind: 'text_quote' as const,
    baseRevision: revision,
    start,
    end: start + quote.length,
    quote,
    quoteDigest: `sha256:${'b'.repeat(64)}`,
    contextDigest: `sha256:${'c'.repeat(64)}`,
  });
  const base = {
    operationId: '11111111-1111-4111-8111-111111111111',
    targetCatId: 'codex-astra',
    threadId: 'thread-a',
    source: {
      kind: 'workspace' as const,
      locator: { worktreeId: 'worktree-a', path: 'guide.md' },
      expectedSourceRevision: revision,
      reviewId: 'review-a',
      expectedReviewRevision: 1,
    },
  };

  it('keeps the request object schema available to field-level consumers', () => {
    expect(contentModificationRequestSchema.shape.intent).toBeDefined();
  });

  it('keeps the legacy single selection and accepts stable multi-selection items', () => {
    expect(
      contentModificationRequestSchema.safeParse({
        ...base,
        intent: { body: 'legacy', selection: anchor('Guide', 2) },
      }).success,
    ).toBe(true);

    const parsed = contentModificationRequestSchema.parse({
      ...base,
      intent: {
        body: 'Change both passages once.',
        selections: [
          { id: 'ctx-1', selection: anchor('Guide', 2), instruction: 'Use a clearer heading.' },
          { id: 'ctx-2', selection: anchor('Summary', 20) },
        ],
      },
    });
    expect(parsed.intent.selections?.map((item) => item.id)).toEqual(['ctx-1', 'ctx-2']);
  });

  it('normalizes legacy and multi selections while rejecting two different truths', () => {
    const first = { id: 'ctx-1', selection: anchor('Guide', 2) };
    const compatible = contentModificationRequestSchema.parse({
      ...base,
      intent: { body: 'compatible alias', selection: first.selection, selections: [first] },
    });
    expect(normalizeModificationSelections(compatible.intent)).toEqual([first]);
    const legacy = contentModificationRequestSchema.parse({
      ...base,
      intent: { body: 'legacy alias', selection: first.selection },
    });
    expect(normalizeModificationSelections(legacy.intent)).toEqual([{ id: 'legacy-1', selection: first.selection }]);
    expect(
      contentModificationRequestSchema.safeParse({
        ...base,
        intent: {
          body: 'ambiguous shape',
          selection: anchor('Summary', 20),
          selections: [first],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate ids and a selection from another base, but accepts per-selection instruction only', () => {
    const first = { id: 'ctx-1', selection: anchor('Guide', 2) };
    expect(
      contentModificationRequestSchema.safeParse({
        ...base,
        intent: { body: 'duplicate ids', selections: [first, { ...first, selection: anchor('Summary', 20) }] },
      }).success,
    ).toBe(false);
    expect(
      contentModificationRequestContractSchema.safeParse({
        ...base,
        intent: {
          body: 'wrong base',
          selections: [
            first,
            { id: 'ctx-2', selection: { ...anchor('Summary', 20), baseRevision: `sha256:${'d'.repeat(64)}` } },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      contentModificationRequestContractSchema.safeParse({
        ...base,
        source: { kind: 'artifact-review', reviewId: 'review-a', round: 1, expectedReviewRevision: 1 },
        intent: { body: 'wrong source', selections: [first] },
      }).success,
    ).toBe(false);
    expect(
      contentModificationRequestSchema.safeParse({
        ...base,
        intent: { body: '', selections: [{ ...first, instruction: 'Only this heading changes.' }] },
      }).success,
    ).toBe(true);
  });

  it('lets a returned text edit explicitly name one requested selection without guessing by range', () => {
    const command = respondContentTextSchema.parse({
      requestId: 'request-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      expectedTaskRevision: 1,
      expectedProposalRevision: 0,
      baseRevision: revision,
      edits: [
        {
          selectionId: 'ctx-1',
          start: 2,
          end: 7,
          expectedText: 'Guide',
          replacement: 'Precise guide',
        },
        { start: 20, end: 20, expectedText: '', replacement: 'Extra context' },
      ],
      response: 'Updated the requested heading and added one unscoped clarification.',
    });
    expect(command.edits[0]?.selectionId).toBe('ctx-1');
    expect(command.edits[1]?.selectionId).toBeUndefined();
  });

  it('exposes a minimal takeover command with no caller-supplied actor or content coordinates', () => {
    expect(
      contentModificationTakeoverSchema.parse({
        sourceMessageId: 'message-1',
        operationId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toEqual({
      sourceMessageId: 'message-1',
      operationId: '22222222-2222-4222-8222-222222222222',
    });
    expect(
      contentModificationTakeoverSchema.safeParse({
        sourceMessageId: 'message-1',
        operationId: '22222222-2222-4222-8222-222222222222',
        targetCatId: 'forged-human-choice',
      }).success,
    ).toBe(false);
  });
});
