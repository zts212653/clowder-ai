import {
  CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH,
  type ContextAttachment,
  ContextAttachmentSchema,
  type QuoteContextSource,
  type WorkspaceFileContextAttachment,
} from '@cat-cafe/shared';
import type { Thread } from '@/stores/chat-types';

export type ContextPickerMode = 'all' | 'threads' | 'files';

function createAttachmentId(kind: ContextAttachment['kind']): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ctx-${kind}-${random}`;
}

function parseCreatedAttachment(candidate: ContextAttachment): ContextAttachment {
  return ContextAttachmentSchema.parse(candidate) as ContextAttachment;
}

export function createThreadContextAttachment(thread: Pick<Thread, 'id' | 'title'>): ContextAttachment {
  return parseCreatedAttachment({
    v: 1,
    id: createAttachmentId('thread'),
    kind: 'thread',
    threadId: thread.id,
    title: thread.title?.trim() || '未命名 Thread',
  });
}

export function createFileContextAttachment(
  path: string,
  worktreeId?: string | null,
  metadata: Pick<WorkspaceFileContextAttachment, 'branch' | 'lineStart' | 'lineEnd'> = {},
): ContextAttachment {
  return parseCreatedAttachment({
    v: 1,
    id: createAttachmentId('workspace_file'),
    kind: 'workspace_file',
    path,
    ...(worktreeId ? { worktreeId } : {}),
    ...metadata,
  });
}

export function createQuoteContextAttachment(
  text: string,
  source: QuoteContextSource,
  annotation: { comment?: string; selectionStart?: number; selectionEnd?: number } = {},
): ContextAttachment {
  return parseCreatedAttachment({
    v: 1,
    id: createAttachmentId('quote'),
    kind: 'quote',
    text: text.trim().slice(0, CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH),
    ...(annotation.comment?.trim() ? { comment: annotation.comment.trim() } : {}),
    ...(annotation.selectionStart !== undefined && annotation.selectionEnd !== undefined
      ? { selectionStart: annotation.selectionStart, selectionEnd: annotation.selectionEnd }
      : {}),
    source,
  });
}

export function detectContextShortcut(
  value: string,
): { mode: Exclude<ContextPickerMode, 'all'>; start: number; end: number } | null {
  const match = value.match(/(?:^|\s)(\/(?:thread|file))$/i);
  if (!match || match.index == null) return null;
  const command = match[1].toLowerCase();
  const start = match.index + match[0].length - match[1].length;
  return { mode: command === '/thread' ? 'threads' : 'files', start, end: value.length };
}
