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

interface EndedBeforeStart {
  readonly finalText: string;
  cleanupAuthorized: boolean;
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
  /** K2: Tracks inline-final sessions separately so cleanupPlaceholders can clear stale entries. */
  private readonly pendingInlineCleanup = new Map<string, StreamingSession[]>();
  private readonly pendingChunks = new Map<string, string>();
  private readonly endedBeforeStart = new Map<string, EndedBeforeStart>();
  private readonly lateStartedCleanup = new Map<string, StreamingSession[]>();
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

  private rememberEndedBeforeStart(key: string, finalText: string): void {
    this.clearEndedBeforeStart(key);
    this.endedBeforeStart.set(key, { finalText, cleanupAuthorized: false });
  }

  private clearEndedBeforeStart(key: string): EndedBeforeStart | undefined {
    const entry = this.endedBeforeStart.get(key);
    if (entry) {
      this.endedBeforeStart.delete(key);
    }
    return entry;
  }

  private async cleanupLateStartedSession(session: StreamingSession, finalText: string): Promise<void> {
    const adapter = this.opts.adapters.get(session.connectorId);
    if (!adapter) return;
    if (!session.platformMessageId) return;
    try {
      if (adapter.finalizeStreamCard) {
        await adapter.finalizeStreamCard(session.externalChatId, session.platformMessageId, session.catDisplayName);
        return;
      }
      if (adapter.deleteMessage) {
        await adapter.deleteMessage(session.platformMessageId, session.externalChatId);
        return;
      }
      if (adapter.editMessage) {
        await adapter.editMessage(session.externalChatId, session.platformMessageId, finalText);
      }
    } catch (err) {
      this.opts.log.warn(
        { err, connectorId: session.connectorId },
        '[StreamingOutbound] late placeholder cleanup failed',
      );
    }
  }

  private async applyChunkToSessions(
    sessions: StreamingSession[],
    accumulatedText: string,
    force = false,
  ): Promise<void> {
    const now = Date.now();

    for (const session of sessions) {
      const elapsed = now - session.lastUpdateAt;
      const delta = accumulatedText.length - session.lastContentLength;
      if (!force && elapsed < this.updateIntervalMs) continue;
      if (!force && delta < this.minDeltaChars) continue;

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

  async onStreamStart(
    threadId: string,
    catId?: CatId,
    invocationId?: string,
    senderHint?: { id: string; name?: string },
  ): Promise<void> {
    const key = this.scopeKey(threadId, invocationId);
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

    if (sessions.length === 0) {
      this.clearEndedBeforeStart(key);
      return;
    }

    const ended = this.endedBeforeStart.get(key);
    if (ended) {
      this.pendingChunks.delete(key);
      if (ended.cleanupAuthorized) {
        this.clearEndedBeforeStart(key);
        await Promise.all(sessions.map((session) => this.cleanupLateStartedSession(session, ended.finalText)));
      } else {
        this.lateStartedCleanup.set(key, sessions);
      }
      return;
    }
    this.sessions.set(key, sessions);
    const pendingChunk = this.pendingChunks.get(key);
    if (pendingChunk !== undefined) {
      this.pendingChunks.delete(key);
      await this.applyChunkToSessions(sessions, pendingChunk, true);
    }
  }

  async onStreamChunk(threadId: string, accumulatedText: string, invocationId?: string): Promise<void> {
    const key = this.scopeKey(threadId, invocationId);
    const sessions = this.sessions.get(key);
    if (!sessions) {
      if (!this.endedBeforeStart.has(key)) this.pendingChunks.set(key, accumulatedText);
      return;
    }
    await this.applyChunkToSessions(sessions, accumulatedText);
  }

  async onStreamEnd(threadId: string, finalText: string, invocationId?: string): Promise<void> {
    const key = this.scopeKey(threadId, invocationId);
    const sessions = this.sessions.get(key);
    if (!sessions) {
      this.pendingChunks.delete(key);
      this.rememberEndedBeforeStart(key, finalText);
      return;
    }
    this.sessions.delete(key);
    this.clearEndedBeforeStart(key);
    this.pendingChunks.delete(key);

    const deferred: StreamingSession[] = [];
    const inlineDeferred: StreamingSession[] = [];
    for (const session of sessions) {
      const adapter = this.opts.adapters.get(session.connectorId);
      if (!session.platformMessageId) continue;
      if (adapter?.registerInlinePlaceholder) {
        // K2: adapter handles inline final — deliver() will edit placeholder instead of sending new message.
        // Also track in pendingInlineCleanup so stale entries are cleared if delivery is skipped.
        adapter.registerInlinePlaceholder(session.externalChatId, session.platformMessageId);
        inlineDeferred.push(session);
      } else if (adapter?.deleteMessage || adapter?.finalizeStreamCard) {
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
    if (inlineDeferred.length > 0) {
      this.pendingInlineCleanup.set(key, inlineDeferred);
    }
  }

  /**
   * Clean up streaming placeholders after outbound delivery succeeds (or is skipped).
   * F157: Prefer finalizeStreamCard (edit to "✅ 已回复") over deleteMessage
   * to avoid Feishu's "recalled a message" notification.
   * K2: Also clears stale inline-final registrations via clearInlinePlaceholder.
   */
  async cleanupPlaceholders(threadId: string, invocationId?: string): Promise<void> {
    const key = this.scopeKey(threadId, invocationId);
    const lateSessions = this.lateStartedCleanup.get(key);
    if (lateSessions) {
      this.lateStartedCleanup.delete(key);
      const ended = this.clearEndedBeforeStart(key);
      await Promise.all(lateSessions.map((session) => this.cleanupLateStartedSession(session, ended?.finalText ?? '')));
    } else {
      const ended = this.endedBeforeStart.get(key);
      if (ended) ended.cleanupAuthorized = true;
    }

    const sessions = this.pendingCleanup.get(key);
    if (sessions) {
      this.pendingCleanup.delete(key);
      for (const session of sessions) {
        const adapter = this.opts.adapters.get(session.connectorId);
        if (!session.platformMessageId) continue;
        try {
          if (adapter?.finalizeStreamCard) {
            // F157: Edit to completion state instead of deleting (no recall notification)
            await adapter.finalizeStreamCard(session.externalChatId, session.platformMessageId, session.catDisplayName);
          } else if (adapter?.deleteMessage) {
            await adapter.deleteMessage(session.platformMessageId, session.externalChatId);
          }
        } catch (err) {
          this.opts.log.warn({ err }, '[StreamingOutbound] cleanupPlaceholders failed');
        }
      }
    }

    // K2: Clear stale inline-final registrations (no-op on success; cleans up on delivery skip).
    const inlineSessions = this.pendingInlineCleanup.get(key);
    if (inlineSessions) {
      this.pendingInlineCleanup.delete(key);
      for (const session of inlineSessions) {
        const adapter = this.opts.adapters.get(session.connectorId);
        if (!session.platformMessageId || !adapter?.clearInlinePlaceholder) continue;
        try {
          await adapter.clearInlinePlaceholder(session.externalChatId, session.platformMessageId);
        } catch (err) {
          this.opts.log.warn({ err }, '[StreamingOutbound] clearInlinePlaceholder failed');
        }
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
