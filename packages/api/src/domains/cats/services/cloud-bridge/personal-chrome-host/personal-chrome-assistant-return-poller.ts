import type {
  CloudAssistantReturnIngestInput,
  CloudAssistantReturnIngestOutcome,
} from '../cloud-assistant-return-ingest.js';
import type { PersonalChromeAssistantReturnCursor } from './assistant-return-cursor.js';
import type { IPersonalChromeAssistantReturnAdapter } from './personal-chrome-host-transport.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;

interface AssistantReturnIngestPort {
  ingest(input: CloudAssistantReturnIngestInput): Promise<CloudAssistantReturnIngestOutcome>;
}

interface AssistantReturnPollerLogger {
  debug?(context: object, message: string): void;
  warn(context: object, message: string): void;
}

export class PersonalChromeAssistantReturnPoller {
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private resumeAfter: PersonalChromeAssistantReturnCursor | undefined;

  constructor(
    private readonly deps: {
      readonly adapter: IPersonalChromeAssistantReturnAdapter;
      readonly ingestService: AssistantReturnIngestPort;
      readonly logger: AssistantReturnPollerLogger;
      readonly grantPersistence: 'durable' | 'ephemeral';
      readonly pollIntervalMs?: number;
    },
  ) {
    const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isInteger(interval) || interval < 50) {
      throw new Error('personal Chrome assistant return poll interval must be an integer of at least 50ms');
    }
  }

  start(): void {
    if (this.timer) return;
    void this.drainOnce();
    this.timer = setInterval(() => void this.drainOnce(), this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async drainOnce(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const pending = await this.deps.adapter.list_assistant_returns(this.resumeAfter);
      const item = pending[0];
      if (!item) {
        this.resumeAfter = undefined;
        return;
      }
      const outcome = await this.deps.ingestService.ingest({
        sourceMessageId: item.sourceMessageId,
        content: item.content,
      });
      if (outcome.status === 'retry') {
        return;
      }
      if (
        outcome.status === 'rejected' &&
        outcome.reason === 'grant_not_found' &&
        this.deps.grantPersistence === 'ephemeral'
      ) {
        this.resumeAfter = {
          conversationId: item.conversationId,
          sourceMessageId: item.sourceMessageId,
          assistantMessageId: item.assistantMessageId,
        };
        return;
      }
      if (outcome.status === 'rejected') {
        this.deps.logger.warn(
          {
            conversationId: item.conversationId,
            sourceMessageId: item.sourceMessageId,
            assistantMessageId: item.assistantMessageId,
            reason: outcome.reason,
          },
          '[F247] rejected a browser-observed assistant final outside the server-authorized source boundary',
        );
      }
      await this.deps.adapter.ack_assistant_return(item.conversationId, item.sourceMessageId, item.assistantMessageId);
      this.resumeAfter = undefined;
    } catch (error) {
      this.deps.logger.debug?.(
        { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) },
        '[F247] personal Chrome assistant return poll deferred',
      );
    } finally {
      this.draining = false;
    }
  }
}
