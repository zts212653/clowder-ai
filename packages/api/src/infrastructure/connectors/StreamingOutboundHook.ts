import { type CatId, catRegistry } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { IConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';
import { pickReceiptLine } from './feishu-receipt-lines.js';
import type { IStreamableOutboundAdapter } from './OutboundDeliveryHook.js';

const DEFAULT_UPDATE_INTERVAL_MS = 2000;
const DEFAULT_MIN_DELTA_CHARS = 200;

interface StreamingSession {
  readonly connectorId: string;
  readonly externalChatId: string;
  /** Display name of the cat that owns this streaming session (for finalizeStreamCard). */
  readonly catDisplayName: string;
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
  private readonly pendingCleanup = new Map<string, StreamingSession[]>();
  private readonly updateIntervalMs: number;
  private readonly minDeltaChars: number;

  constructor(private readonly opts: StreamingOutboundHookOptions) {
    this.updateIntervalMs = opts.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
    this.minDeltaChars = opts.minDeltaChars ?? DEFAULT_MIN_DELTA_CHARS;
  }

  /** Scope key for isolation: `threadId:invocationId` when available, else `threadId`. */
  private scopeKey(threadId: string, invocationId?: string): string {
    return invocationId ? `${threadId}:${invocationId}` : threadId;
  }

  async onStreamStart(
    threadId: string,
    catId?: CatId,
    invocationId?: string,
    senderHint?: { id: string; name?: string },
  ): Promise<void> {
    const bindings = await this.opts.bindingStore.getByThread(threadId);
    const sessions: StreamingSession[] = [];

    for (const binding of bindings) {
      const adapter = this.opts.adapters.get(binding.connectorId);
      if (!adapter?.sendPlaceholder) continue;
      try {
        const catEntry = catId ? catRegistry.tryGet(catId) : undefined;
        const displayName = catEntry?.config.displayName ?? '';
        // F157: Cat-personality receipt for Feishu only; generic for others (AC-A8)
        // P2: Group chat @mention — add sender name to prefix when available
        const senderSuffix = binding.connectorId === 'feishu' && senderHint?.name ? `→${senderHint.name}` : '';
        const prefix = displayName || senderSuffix ? `【${displayName || '猫猫'}🐱${senderSuffix}】` : '';
        const placeholderText =
          binding.connectorId === 'feishu' ? `${prefix}${pickReceiptLine(catId)}` : `${prefix}🤔 思考中...`;
        const msgId = await adapter.sendPlaceholder(binding.externalChatId, placeholderText);
        if (msgId) {
          sessions.push({
            connectorId: binding.connectorId,
            externalChatId: binding.externalChatId,
            catDisplayName: displayName,
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
      const key = this.scopeKey(threadId, invocationId);
      this.sessions.set(key, sessions);
    }
  }

  async onStreamChunk(threadId: string, accumulatedText: string, invocationId?: string): Promise<void> {
    const key = this.scopeKey(threadId, invocationId);
    const sessions = this.sessions.get(key);
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

  async onStreamEnd(threadId: string, finalText: string, invocationId?: string): Promise<void> {
    const key = this.scopeKey(threadId, invocationId);
    const sessions = this.sessions.get(key);
    if (!sessions) return;
    this.sessions.delete(key);

    const deferred: StreamingSession[] = [];
    for (const session of sessions) {
      const adapter = this.opts.adapters.get(session.connectorId);
      if (!session.platformMessageId) continue;
      if (adapter?.deleteMessage || adapter?.finalizeStreamCard) {
        // Defer cleanup — keep placeholder as fallback until outbound delivery succeeds
        deferred.push(session);
      } else if (adapter?.editMessage) {
        try {
          await adapter.editMessage(session.externalChatId, session.platformMessageId, finalText);
        } catch (err) {
          this.opts.log.warn({ err }, '[StreamingOutbound] onStreamEnd editMessage failed');
        }
      }
    }
    if (deferred.length > 0) {
      this.pendingCleanup.set(key, deferred);
    }
  }

  /**
   * Clean up streaming placeholders after outbound delivery succeeds.
   * F157: Prefer finalizeStreamCard (edit to "✅ 已回复") over deleteMessage
   * to avoid Feishu's "recalled a message" notification.
   */
  async cleanupPlaceholders(threadId: string, invocationId?: string): Promise<void> {
    const key = this.scopeKey(threadId, invocationId);
    const sessions = this.pendingCleanup.get(key);
    if (!sessions) return;
    this.pendingCleanup.delete(key);

    for (const session of sessions) {
      const adapter = this.opts.adapters.get(session.connectorId);
      if (!session.platformMessageId) continue;
      try {
        if (adapter?.finalizeStreamCard) {
          // F157: Edit to completion state instead of deleting (no recall notification)
          await adapter.finalizeStreamCard(session.externalChatId, session.platformMessageId, session.catDisplayName);
        } else if (adapter?.deleteMessage) {
          await adapter.deleteMessage(session.platformMessageId);
        }
      } catch (err) {
        this.opts.log.warn({ err }, '[StreamingOutbound] cleanupPlaceholders failed');
      }
    }
  }

  /** F151: Notify adapters that an invocation's delivery batch is complete. */
  async notifyDeliveryBatchDone(threadId: string, chainDone: boolean): Promise<void> {
    const bindings = await this.opts.bindingStore.getByThread(threadId);
    for (const binding of bindings) {
      const adapter = this.opts.adapters.get(binding.connectorId);
      if (!adapter?.onDeliveryBatchDone) continue;
      try {
        await adapter.onDeliveryBatchDone(binding.externalChatId, chainDone);
      } catch (err) {
        this.opts.log.warn({ err, connectorId: binding.connectorId }, '[StreamingOutbound] onDeliveryBatchDone failed');
      }
    }
  }
}
