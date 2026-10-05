import type { ContextAttachment } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { createQuoteContextAttachment } from '../chat-context-reference';

/** A selection in one workspace file, with only the coordinates that were actually known. */
export interface WorkspaceFileQuote {
  readonly text: string;
  readonly comment: string;
  readonly path: string;
  readonly worktreeId?: string | null;
  readonly branch?: string | null;
  readonly language?: string | null;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
}

export function workspaceFileQuoteAttachment(quote: WorkspaceFileQuote): ContextAttachment {
  return createQuoteContextAttachment(
    quote.text,
    {
      kind: 'workspace_file',
      path: quote.path,
      ...(quote.worktreeId ? { worktreeId: quote.worktreeId } : {}),
      ...(quote.branch ? { branch: quote.branch } : {}),
      ...(quote.language ? { language: quote.language } : {}),
      ...(quote.lineStart !== undefined && quote.lineEnd !== undefined
        ? { lineStart: quote.lineStart, lineEnd: quote.lineEnd }
        : {}),
    },
    {
      comment: quote.comment,
      ...(quote.selectionStart !== undefined && quote.selectionEnd !== undefined
        ? { selectionStart: quote.selectionStart, selectionEnd: quote.selectionEnd }
        : {}),
    },
  );
}

/**
 * The one "add to chat" for a workspace file selection: it lands in that thread's chat input as an
 * annotation chip. It does not send, delegate, or record anything else.
 */
export function addWorkspaceFileQuoteToChat(threadId: string, quote: WorkspaceFileQuote): void {
  useChatStore.getState().setPendingChatInsert({
    threadId,
    text: '',
    contextAttachments: [workspaceFileQuoteAttachment(quote)],
  });
}
