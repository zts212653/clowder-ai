import type { RecallOpportunityV1 } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import { isTimelinePublished } from '../../../cats/services/stores/visibility.js';
import { prepareAbstractiveBatch, toAbstractiveMessages } from '../../abstractive-summary-input.js';
import type { LunaThreadLibrarian } from '../../curation/LunaThreadLibrarian.js';
import type { ThreadOverviewRepository } from '../../curation/ThreadOverviewRepository.js';
import type { MemoryCueOpportunitySeed } from '../MemoryCueInvocationPromptService.js';
import {
  buildCueEnvelope,
  type MemoryCueResolver,
  type MemoryCueResolverContext,
} from '../MemoryCueResolverRegistry.js';

const PREFIX = 'thread-overview:';
export class ThreadOverviewMemoryCueSource implements MemoryCueResolver {
  readonly family = 'thread_overview' as const;
  readonly resolverVersion = 1;
  constructor(
    private readonly deps: {
      repository: ThreadOverviewRepository;
      librarian: LunaThreadLibrarian;
      messageStore: Pick<IMessageStore, 'getById' | 'getByThreadAfter'>;
      enabled: () => boolean;
    },
  ) {}

  async prepareOpportunity(input: {
    ownerUserId: string;
    threadId: string;
    sourceMessageId?: string;
    consumerCatId?: string;
    occurredAt: number;
    signal?: AbortSignal;
  }): Promise<Extract<MemoryCueOpportunitySeed, { kind: 'thread_opened' }> | null> {
    if (
      !input.sourceMessageId ||
      !this.deps.enabled() ||
      !(await this.opening({ ...input, sourceMessageId: input.sourceMessageId }))
    )
      return null;
    return {
      kind: 'thread_opened',
      producer: 'owner_message',
      occurredAt: input.occurredAt,
      payload: { sourceMessageId: input.sourceMessageId },
    };
  }

  async resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext) {
    context.signal?.throwIfAborted();
    if (opportunity.kind !== 'thread_opened' || !context.consumerCatId || !this.deps.enabled()) return [];
    const request = {
      ...opportunity.scope,
      sourceMessageId: opportunity.payload.sourceMessageId,
      consumerCatId: context.consumerCatId,
      signal: context.signal,
    };
    const opening = await this.opening(request);
    if (!opening) return [];
    const [material] = await toAbstractiveMessages([opening], this.deps.messageStore);
    context.signal?.throwIfAborted();
    const backgrounds = await this.deps.librarian.recall({
      ownerUserId: opportunity.scope.ownerUserId,
      consumerCatId: context.consumerCatId,
      threadId: opportunity.scope.threadId,
      signal: context.signal,
      opening: prepareAbstractiveBatch({
        threadId: opening.threadId,
        previousSummary: null,
        messages: [material],
      })!.prompts.join('\n'),
    });
    context.signal?.throwIfAborted();
    if (!this.deps.enabled() || !(await this.opening(request))) return [];
    return backgrounds.map((item) =>
      buildCueEnvelope({
        opportunity,
        family: this.family,
        resolverVersion: this.resolverVersion,
        whyNow: item.reason,
        source: {
          title: item.overview.title.slice(0, 160),
          summary: `${item.background}\n来源：${item.sourceIds.map((id) => `${item.overview.threadId}#${id}`).join('，')}`,
          anchor: `${PREFIX}${item.overview.threadId}`,
          revision: item.overview.revision,
          visibility: 'owner_private',
          drillFamily: 'thread_overview',
        },
        context,
      }),
    );
  }

  async read(input: { ownerUserId: string; consumerCatId?: string; anchor: string; expectedRevision: string }) {
    if (!input.consumerCatId || !input.anchor.startsWith(PREFIX))
      return { status: 'not_available' as const, invalidationReason: 'scope_revoked' as const };
    const overview = await this.deps.repository.read(
      input.ownerUserId,
      input.consumerCatId,
      input.anchor.slice(PREFIX.length),
    );
    if (!overview) return { status: 'not_available' as const, invalidationReason: 'source_forgotten' as const };
    if (overview.revision !== input.expectedRevision)
      return { status: 'not_available' as const, invalidationReason: 'source_corrected' as const };
    return {
      status: 'ok' as const,
      payload: {
        ...overview,
        caution:
          '概况是历史线索。当前约定核 canonical 文档；工作进度核当前 Task/PR；逐条来源可用 get_thread_context 回读。',
      },
    };
  }

  private async opening(input: {
    ownerUserId: string;
    threadId: string;
    sourceMessageId: string;
    consumerCatId?: string;
    signal?: AbortSignal;
  }) {
    input.signal?.throwIfAborted();
    const thread = await this.deps.repository.deps.threadStore.get(input.threadId);
    input.signal?.throwIfAborted();
    if (
      !thread ||
      thread.createdBy !== input.ownerUserId ||
      thread.systemKind ||
      thread.deletedAt ||
      input.ownerUserId !== this.deps.repository.deps.ownerUserId
    )
      return null;
    const source = await this.deps.messageStore.getById(input.sourceMessageId);
    input.signal?.throwIfAborted();
    if (
      !source ||
      source.threadId !== input.threadId ||
      source.userId !== input.ownerUserId ||
      source.catId !== null ||
      source.source ||
      source.deletedAt ||
      source._tombstone ||
      source.recall ||
      source.visibility === 'whisper' ||
      !isTimelinePublished(source)
    )
      return null;
    let cursor: string | undefined;
    while (true) {
      input.signal?.throwIfAborted();
      const page = await this.deps.messageStore.getByThreadAfter(input.threadId, cursor, 200, input.ownerUserId, {
        includeQueuedUserMessages: true,
      });
      input.signal?.throwIfAborted();
      if (!page.length) return null;
      for (const message of page) {
        if (message.catId === null && message.userId === input.ownerUserId && !message.source)
          return message.id === source.id ? source : null;
      }
      if (page.some((message) => message.id === source.id) || page.length < 200) return null;
      cursor = page.at(-1)!.id;
    }
  }
}
