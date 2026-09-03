import { createCatId } from '@cat-cafe/shared';
import { hydrateReplyPreview, type IMessageStore, type StoredMessage } from '../stores/ports/MessageStore.js';
import { resolveVisibleReplyParent } from '../stores/visibility.js';
import type { AgentMessage } from '../types.js';
import type { CloudReturnGrantClaim, CloudReturnGrantStore } from './cloud-return-grant.js';
import { buildCloudReturnMessageIdempotencyKey } from './cloud-return-message.js';

const TARGET_CAT_ID = createCatId('gpt-pro');
const MAX_CONTENT_BYTES = 128 * 1024;

interface AssistantReturnLogger {
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

interface AssistantReturnSocketManager {
  broadcastAgentMessage(message: AgentMessage, threadId?: string): void;
}

export type CloudAssistantReturnIngestOutcome =
  | { readonly status: 'persisted' | 'duplicate'; readonly messageId: string }
  | { readonly status: 'retry'; readonly reason: string }
  | { readonly status: 'rejected'; readonly reason: string };

export interface CloudAssistantReturnIngestInput {
  readonly sourceMessageId: string;
  readonly content: string;
}

function validContent(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_CONTENT_BYTES;
}

export class CloudAssistantReturnIngestService {
  constructor(
    private readonly deps: {
      readonly messageStore: IMessageStore;
      readonly grantStore: Pick<CloudReturnGrantStore, 'claim' | 'commit' | 'release'>;
      readonly socketManager: AssistantReturnSocketManager;
      readonly logger: AssistantReturnLogger;
      readonly now?: () => number;
    },
  ) {}

  private async broadcast(message: StoredMessage): Promise<void> {
    const replyPreview = message.replyTo
      ? await hydrateReplyPreview(this.deps.messageStore, message.replyTo)
      : undefined;
    this.deps.socketManager.broadcastAgentMessage(
      {
        type: 'text',
        catId: TARGET_CAT_ID,
        content: message.content,
        origin: 'callback',
        messageId: message.id,
        invocationId: message.id,
        extra: { isExplicitPost: true },
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(replyPreview ? { replyPreview } : {}),
        timestamp: this.deps.now?.() ?? Date.now(),
      },
      message.threadId,
    );
  }

  private async commitAfterPersistence(claim: CloudReturnGrantClaim, message: StoredMessage): Promise<void> {
    try {
      if (!(await this.deps.grantStore.commit(claim))) {
        this.deps.logger.error(
          { sourceMessageId: claim.sourceMessageId, messageId: message.id },
          '[F247] browser assistant return persisted; grant commit will recover by durable source idempotency',
        );
      }
    } catch (error) {
      this.deps.logger.error(
        { error, sourceMessageId: claim.sourceMessageId, messageId: message.id },
        '[F247] browser assistant return survived a transient grant commit failure',
      );
    }
  }

  async ingest(input: CloudAssistantReturnIngestInput): Promise<CloudAssistantReturnIngestOutcome> {
    if (!input.sourceMessageId || input.sourceMessageId.length > 512 || !validContent(input.content)) {
      return { status: 'rejected', reason: 'invalid_browser_return' };
    }
    const rawSource = await this.deps.messageStore.getById(input.sourceMessageId);
    if (!rawSource) return { status: 'rejected', reason: 'source_not_found' };
    const source = await resolveVisibleReplyParent(this.deps.messageStore, input.sourceMessageId, {
      threadId: rawSource.threadId,
      viewer: { type: 'cat', catId: TARGET_CAT_ID },
      publicReply: true,
    });
    if (!source || source.userId !== rawSource.userId) {
      return { status: 'rejected', reason: 'source_ineligible' };
    }
    const scope = {
      threadId: source.threadId,
      userId: source.userId,
      sourceMessageId: source.id,
      targetCatId: String(TARGET_CAT_ID),
    };
    const idempotencyKey = buildCloudReturnMessageIdempotencyKey(scope);
    const durableWinner = await this.deps.messageStore.getByIdempotencyKey(
      source.userId,
      source.threadId,
      idempotencyKey,
    );
    if (durableWinner) {
      await this.broadcast(durableWinner);
      return { status: 'duplicate', messageId: durableWinner.id };
    }
    const claimed = await this.deps.grantStore.claim(scope);
    if (!claimed.ok) {
      return claimed.reason === 'in_flight' || claimed.reason === 'consumed'
        ? { status: 'retry', reason: `grant_${claimed.reason}` }
        : { status: 'rejected', reason: 'grant_not_found' };
    }
    try {
      const append = await this.deps.messageStore.appendIdempotent({
        threadId: source.threadId,
        userId: source.userId,
        catId: TARGET_CAT_ID,
        content: input.content,
        mentions: [],
        origin: 'callback',
        timestamp: this.deps.now?.() ?? Date.now(),
        extra: { isExplicitPost: true },
        replyTo: source.id,
        idempotencyKey,
      });
      await this.commitAfterPersistence(claimed, append.message);
      await this.broadcast(append.message);
      return { status: append.idempotent ? 'duplicate' : 'persisted', messageId: append.message.id };
    } catch (error) {
      await this.deps.grantStore.release(claimed).catch(() => false);
      this.deps.logger.warn(
        { error, sourceMessageId: source.id },
        '[F247] browser assistant return append failed; durable Native Host inbox retained for retry',
      );
      return { status: 'retry', reason: 'append_failed' };
    }
  }
}
