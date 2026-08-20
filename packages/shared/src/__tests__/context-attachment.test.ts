import { describe, expect, it } from 'vitest';
import {
  ContextAttachmentContentSchema,
  ContextAttachmentSchema,
  ContextAttachmentsSchema,
  MessageContentSchema,
  MessageContentsSchema,
} from '../index.js';

const threadAttachment = {
  v: 1,
  id: 'ctx-thread-1',
  kind: 'thread',
  threadId: 'thread_abc123',
  title: 'F063 Context Attachments',
} as const;

describe('ContextAttachmentSchema', () => {
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
        lineStart: 177,
        lineEnd: 245,
      }),
    ).toMatchObject({ kind: 'workspace_file', lineStart: 177, lineEnd: 245 });
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
});
