import { type ContextAttachment, workspaceTextAnchorSchema } from '@cat-cafe/shared';
import { composerAttachments, queuedServerAckBlocks } from '@/components/composer-queue';
import { addWorkspaceFileQuoteToChat } from '@/components/workspace/workspace-file-quote';
import { useChatStore } from '@/stores/chatStore';

export interface TextChatRequest {
  readonly content: string;
  readonly revision: string;
}

type Outcome = 'added' | 'existing' | 'choose_places' | 'no_thread' | 'recall_pending' | 'refused';

/** Focus the one existing composer; this leaf neither opens a Chat nor owns its text or selection. */
function focusComposer() {
  const inputs = document.querySelectorAll<HTMLTextAreaElement>('[data-guide-id="chat.input"] textarea');
  if (inputs.length === 1 && !inputs[0].disabled) inputs[0].focus();
}

function quoteNamesFile(
  attachment: ContextAttachment,
  locator: { readonly worktreeId: string; readonly path: string },
  revision: string,
): boolean {
  return (
    attachment.kind === 'quote' &&
    attachment.source.kind === 'workspace_file' &&
    attachment.source.worktreeId === locator.worktreeId &&
    attachment.source.path === locator.path &&
    attachment.source.revision === revision
  );
}

function sameQueuedPlace(
  place: ContextAttachment,
  anchor: { readonly quote: string; readonly start: number; readonly end: number },
  uniquePlace: boolean,
): boolean {
  if (place.kind !== 'quote' || place.text !== anchor.quote) return false;
  return uniquePlace || (place.selectionStart === anchor.start && place.selectionEnd === anchor.end);
}

/** The original file quote admission is the only writer of new places; an existing place keeps its ID and comment. */
export function requestTextModificationInChat(
  threadId: string | null,
  locator: { readonly worktreeId: string; readonly path: string },
  request: TextChatRequest,
  selection?: unknown,
  requestedQuote?: string,
): Outcome {
  if (!threadId || useChatStore.getState().currentThreadId !== threadId) return 'no_thread';
  if (queuedServerAckBlocks()) return 'recall_pending';
  const places = composerAttachments(threadId).filter((attachment) =>
    quoteNamesFile(attachment, locator, request.revision),
  );
  if (selection === undefined) {
    if (requestedQuote !== undefined) return 'refused';
    if (!places.length) return 'choose_places';
    focusComposer();
    return 'existing';
  }
  const checked = workspaceTextAnchorSchema.safeParse(selection);
  if (!checked.success) return 'refused';
  const anchor = checked.data;
  if (
    (requestedQuote !== undefined && anchor.quote !== requestedQuote) ||
    anchor.baseRevision !== request.revision ||
    request.content.slice(anchor.start, anchor.end) !== anchor.quote ||
    anchor.end > request.content.length
  )
    return 'refused';
  const uniquePlace =
    request.content.indexOf(anchor.quote) === anchor.start &&
    request.content.lastIndexOf(anchor.quote) === anchor.start;
  if (places.some((place) => sameQueuedPlace(place, anchor, uniquePlace))) {
    focusComposer();
    return 'existing';
  }
  return addWorkspaceFileQuoteToChat(threadId, {
    text: anchor.quote,
    comment: '',
    ...locator,
    revision: request.revision,
    selectionStart: anchor.start,
    selectionEnd: anchor.end,
    language: /\.mdx?$/i.test(locator.path) ? 'markdown' : null,
  }).kind === 'added'
    ? 'added'
    : 'refused';
}
