import {
  ContextAttachmentSchema,
  type QuoteContextAttachment,
  type WorkspaceFileQuotePage,
  type WorkspaceFileQuoteReference,
  type WorkspaceFileQuoteSource,
} from '@cat-cafe/shared';
import {
  canAccessSourceThread,
  isAccessibleSourceRecord,
} from '../../cats/services/context/MessageBundleSourceProjection.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import {
  WorkspaceContentSourceError,
  type WorkspaceContentSourceService,
  type WorkspaceTextQuoteResolutionV1,
} from '../../workspace/workspace-content-source.js';

export interface WorkspaceFileQuoteDependencies {
  readonly source: WorkspaceContentSourceService;
  readonly messages: Pick<IMessageStore, 'getBefore' | 'getById'>;
  readonly threads: Pick<IThreadStore, 'list'>;
}

/** Projects existing authorized messages without preparing a review or writing any source/Task/message state. */
export class WorkspaceFileQuoteProjection {
  constructor(private readonly deps: WorkspaceFileQuoteDependencies) {}

  async read(
    input: {
      locator: { worktreeId: string; path: string };
      expectedSourceRevision: string;
      before?: { timestamp: number; messageId: string };
      limit: number;
    },
    principal: MediaReviewPrincipal,
  ): Promise<WorkspaceFileQuotePage> {
    if (principal.actor.kind !== 'human') throw new WorkspaceContentSourceError('access_denied');
    const description = await this.deps.source.describe({ principal, locator: input.locator });
    if (description.kind !== 'text') throw new WorkspaceContentSourceError('unsupported_text');
    if (description.revision !== input.expectedSourceRevision)
      throw new WorkspaceContentSourceError('revision_changed');
    const batch = await this.deps.messages.getBefore(
      input.before?.timestamp ?? Number.MAX_SAFE_INTEGER,
      input.limit + 1,
      principal.userId,
      input.before?.messageId,
      { includeQueuedCatMessages: true },
    );
    const page = batch.slice(-input.limit);
    // list is a read; the legacy get('default') may materialize a missing conversation.
    const allowedThreads = new Map(
      (await this.deps.threads.list(principal.userId)).map((thread) => [thread.id, thread]),
    );
    const eligible: { message: StoredMessage; attachment: FileQuote; quoteNumber: number }[] = [];
    for (const message of page) {
      const thread = allowedThreads.get(message.threadId) ?? null;
      if (!canAccessSourceThread(thread, principal) || !isAccessibleSourceRecord(message, message.threadId, principal))
        continue;
      for (const { attachment, quoteNumber } of fileQuotesOf(message)) {
        const source = attachment.source;
        if (source.worktreeId !== description.locator.worktreeId || source.path !== description.locator.path) continue;
        eligible.push({ message, attachment, quoteNumber });
      }
    }
    const currentQuotes = eligible.filter(({ attachment }) => attachment.source.revision === description.revision);
    const resolved = new Map<string, WorkspaceTextQuoteResolutionV1>();
    if (currentQuotes.length) {
      const batch = await this.deps.source.resolveRenderedTextSelections({
        principal,
        locator: description.locator,
        expectedRevision: description.revision,
        quotes: currentQuotes.map(({ attachment }) => attachment.text),
      });
      currentQuotes.forEach(({ attachment }, index) => resolved.set(attachment.text, batch.resolutions[index]));
    }
    const quotes: WorkspaceFileQuoteReference[] = eligible.map(({ message, attachment, quoteNumber }) => ({
      threadId: message.threadId,
      messageId: message.id,
      authorCatId: message.catId,
      timestamp: message.timestamp,
      attachment,
      quoteNumber,
      ...locate(attachment, description.revision, resolved.get(attachment.text)),
    }));
    const fresh = await this.deps.source.describe({ principal, locator: description.locator });
    if (fresh.revision !== description.revision) throw new WorkspaceContentSourceError('revision_changed');
    const oldest = page[0];
    const freshThreads = new Map((await this.deps.threads.list(principal.userId)).map((thread) => [thread.id, thread]));
    // A later source read may outlive an earlier message check. Recheck the whole page at publication.
    const currentMessages = new Map(
      await Promise.all(
        [...new Set(quotes.map((quote) => quote.messageId))].map(
          async (id) => [id, await this.deps.messages.getById(id)] as const,
        ),
      ),
    );
    return {
      sourceRevision: description.revision,
      quotes: quotes.filter(
        (quote) =>
          canAccessSourceThread(freshThreads.get(quote.threadId) ?? null, principal) &&
          publishesQuote(currentMessages.get(quote.messageId), quote.threadId, quote.attachment, principal),
      ),
      ...(batch.length > input.limit && oldest ? { nextCursor: `${oldest.timestamp}:${oldest.id}` } : {}),
    };
  }
}

type FileQuote = QuoteContextAttachment & { source: WorkspaceFileQuoteSource };

function locate(
  attachment: FileQuote,
  revision: string,
  resolved: WorkspaceTextQuoteResolutionV1 | undefined,
): Pick<WorkspaceFileQuoteReference, 'state' | 'anchor'> {
  if (!attachment.source.revision) return { state: 'unversioned' };
  if (attachment.source.revision !== revision) return { state: 'changed' };
  return resolved?.status === 'attached' ? { state: 'current', anchor: resolved.anchor } : { state: 'unlocated' };
}

function fileQuotesOf(message: StoredMessage): { attachment: FileQuote; quoteNumber: number }[] {
  const quotes: { attachment: FileQuote; quoteNumber: number }[] = [];
  for (const block of message.contentBlocks ?? []) {
    if (block.type !== 'context_attachment') continue;
    const parsed = ContextAttachmentSchema.safeParse(block.attachment);
    if (!parsed.success || parsed.data.kind !== 'quote' || parsed.data.source.kind !== 'workspace_file') continue;
    quotes.push({ attachment: { ...parsed.data, source: parsed.data.source }, quoteNumber: quotes.length + 1 });
  }
  return quotes;
}

function publishesQuote(
  message: StoredMessage | null | undefined,
  threadId: string,
  attachment: QuoteContextAttachment,
  principal: MediaReviewPrincipal,
): boolean {
  if (!isAccessibleSourceRecord(message ?? null, threadId, principal)) return false;
  return (
    message?.contentBlocks?.some((block) => {
      if (block.type !== 'context_attachment') return false;
      const parsed = ContextAttachmentSchema.safeParse(block.attachment);
      return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(attachment);
    }) ?? false
  );
}
