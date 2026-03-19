import { type CatId, catRegistry } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { IConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';
import type { IStreamableOutboundAdapter } from './OutboundDeliveryHook.js';

const DEFAULT_UPDATE_INTERVAL_MS = 2000;
const DEFAULT_MIN_DELTA_CHARS = 200;

interface StreamingSession {
  readonly connectorId: string;
  readonly externalChatId: string;
  platformMessageId: string;
  lastUpdateAt: number;
  lastContentLength: number;
}

export interface StreamingOutboundHookOptions {
  readonly bindingStore: IConnectorThreadBindingStore;
  readonly adapters: Map<string, IStreamableOutboundAdapter>;
  readonly log: FastifyBaseLogger;
  readonly updateIntervalMs?: number;
  readonly minDeltaChars?: number;
}

export class StreamingOutboundHook {
  private readonly sessions = new Map<string, StreamingSession[]>();
  private readonly updateIntervalMs: number;
  private readonly minDeltaChars: number;

  constructor(private readonly opts: StreamingOutboundHookOptions) {
    this.updateIntervalMs = opts.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
    this.minDeltaChars = opts.minDeltaChars ?? DEFAULT_MIN_DELTA_CHARS;
  }

  async onStreamStart(threadId: string, catId?: CatId): Promise<void> {
    const bindings = await this.opts.bindingStore.getByThread(threadId);
    const sessions: StreamingSession[] = [];

    for (const binding of bindings) {
      const adapter = this.opts.adapters.get(binding.connectorId);
      if (!adapter?.sendPlaceholder) continue;
      try {
        const catEntry = catId ? catRegistry.tryGet(catId) : undefined;
        const prefix = catEntry ? `[${catEntry.config.displayName}🐱] ` : '';
        const msgId = await adapter.sendPlaceholder(binding.externalChatId, `${prefix}🤔 思考中...`);
        if (msgId) {
          sessions.push({
            connectorId: binding.connectorId,
            externalChatId: binding.externalChatId,
            platformMessageId: msgId,
            lastUpdateAt: Date.now(),
            lastContentLength: 0,
          });
        }
      } catch (err) {
        this.opts.log.warn({ err, connectorId: binding.connectorId }, '[StreamingOutbound] sendPlaceholder failed');
      }
    }

    if (sessions.length > 0) {
      this.sessions.set(threadId, sessions);
    }
  }

  async onStreamChunk(threadId: string, accumulatedText: string): Promise<void> {
    const sessions = this.sessions.get(threadId);
    if (!sessions) return;
    const now = Date.now();

    for (const session of sessions) {
      const elapsed = now - session.lastUpdateAt;
      const delta = accumulatedText.length - session.lastContentLength;
      if (elapsed < this.updateIntervalMs || delta < this.minDeltaChars) continue;

      const adapter = this.opts.adapters.get(session.connectorId);
      if (!adapter?.editMessage || !session.platformMessageId) continue;
      try {
        await adapter.editMessage(session.externalChatId, session.platformMessageId, `${accumulatedText} ▌`);
        session.lastUpdateAt = now;
        session.lastContentLength = accumulatedText.length;
      } catch (err) {
        this.opts.log.warn({ err }, '[StreamingOutbound] editMessage chunk failed');
      }
    }
  }

  async onStreamEnd(threadId: string, finalText: string): Promise<void> {
    const sessions = this.sessions.get(threadId);
    if (!sessions) return;
    this.sessions.delete(threadId);

    for (const session of sessions) {
      const adapter = this.opts.adapters.get(session.connectorId);
      if (!session.platformMessageId) continue;
      try {
        if (adapter?.deleteMessage) {
          await adapter.deleteMessage(session.platformMessageId);
        } else if (adapter?.editMessage) {
          await adapter.editMessage(session.externalChatId, session.platformMessageId, finalText);
        }
      } catch (err) {
        this.opts.log.warn({ err }, '[StreamingOutbound] onStreamEnd cleanup failed');
      }
    }
  }
}
