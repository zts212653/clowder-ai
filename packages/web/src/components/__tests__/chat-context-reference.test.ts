import { CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH, ContextAttachmentSchema } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { resolveChatThreadHref } from '@/components/ChatWorkspaceLink';
import {
  createFileContextAttachment,
  createQuoteContextAttachment,
  createThreadContextAttachment,
  detectContextShortcut,
} from '@/components/chat-context-reference';

describe('chat context references', () => {
  it('keeps both the thread title and stable thread id in a structured attachment', () => {
    expect(createThreadContextAttachment({ id: 'thread_abc123', title: 'F284 Workspace Shell' })).toMatchObject({
      v: 1,
      kind: 'thread',
      threadId: 'thread_abc123',
      title: 'F284 Workspace Shell',
    });
  });

  it('keeps the worktree identity on structured file attachments', () => {
    expect(createFileContextAttachment('docs/features/F063.md', 'main-worktree')).toMatchObject({
      v: 1,
      kind: 'workspace_file',
      path: 'docs/features/F063.md',
      worktreeId: 'main-worktree',
    });
  });

  it('bounds selected quotes through the shared attachment contract', () => {
    const attachment = createQuoteContextAttachment('x'.repeat(CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH + 100), {
      kind: 'message',
      threadId: 'thread_abc123',
      messageId: 'message_abc123',
    });
    expect(ContextAttachmentSchema.safeParse(attachment).success).toBe(true);
    expect(attachment.kind).toBe('quote');
    if (attachment.kind !== 'quote') throw new Error('expected quote attachment');
    expect(attachment.text).toHaveLength(CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH);
  });

  it('creates one flat Quote attachment that keeps the selected text paired with its comment', () => {
    const attachment = createQuoteContextAttachment(
      'selected passage',
      { kind: 'message', threadId: 'thread_abc123', messageId: 'message_abc123' },
      { comment: '  my comment  ', selectionStart: 4, selectionEnd: 20 },
    );
    expect(attachment).toMatchObject({
      kind: 'quote',
      text: 'selected passage',
      comment: 'my comment',
      selectionStart: 4,
      selectionEnd: 20,
    });
  });

  it('reserves @ for cats and uses explicit slash commands for context', () => {
    expect(detectContextShortcut('/thread')).toEqual({ mode: 'threads', start: 0, end: 7 });
    expect(detectContextShortcut('/file')).toEqual({ mode: 'files', start: 0, end: 5 });
    expect(detectContextShortcut('draft\t/thread')).toEqual({ mode: 'threads', start: 6, end: 13 });
    expect(detectContextShortcut('/game')).toBeNull();
    expect(detectContextShortcut('@thread')).toBeNull();
  });

  it('recognizes generated thread links as same-app navigation targets', () => {
    expect(resolveChatThreadHref('/thread/thread_abc123')).toBe('thread_abc123');
    expect(resolveChatThreadHref('https://example.com/thread/thread_abc123')).toBeNull();
  });
});
