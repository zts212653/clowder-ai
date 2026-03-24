/**
 * Connector Router
 * Routes inbound messages from external platforms to Clowder AI threads.
 *
 * Flow:
 *   1. Dedup check (skip webhook retries)
 *   2. Lookup existing binding or create new thread + binding
 *   3. Post connector message to thread (with ConnectorSource)
 *   4. Broadcast to WebSocket
 *   5. Trigger cat invocation
 *
 * Follows ReviewRouter pattern but for chat platform messages.
 *
 * F088 Multi-Platform Chat Gateway
 */

import type { CatId, ConnectorSource, MessageContent } from '@cat-cafe/shared';
import { catRegistry, getConnectorDefinition } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorCommandLayer } from './ConnectorCommandLayer.js';
import { ConnectorMessageFormatter } from './ConnectorMessageFormatter.js';
import type { IConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';
import type { InboundMessageDedup } from './InboundMessageDedup.js';
import { parseMentions } from './mention-parser.js';
import type { IOutboundAdapter } from './OutboundDeliveryHook.js';

export type RouteResult =
  | { kind: 'routed'; threadId: string; messageId: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'command'; threadId?: string; messageId?: string };

export interface ConnectorRouterOptions {
  readonly bindingStore: IConnectorThreadBindingStore;
  readonly dedup: InboundMessageDedup;
  readonly messageStore: {
    append(input: {
      threadId: string;
      userId: string;
      catId: null;
      content: string;
      source: ConnectorSource;
      mentions: CatId[];
      timestamp: number;
    }): Promise<{ id: string }>;
  };
  readonly threadStore: {
    create(userId: string, title?: string): { id: string } | Promise<{ id: string }>;
    updateConnectorHubState(
      threadId: string,
      state: { v: 1; connectorId: string; externalChatId: string; createdAt: number; lastCommandAt?: number } | null,
    ): void | Promise<void>;
    get?(threadId: string):
      | {
          connectorHubState?: {
            v: 1;
            connectorId: string;
            externalChatId: string;
            createdAt: number;
            lastCommandAt?: number;
          };
        }
      | null
      | Promise<{
          connectorHubState?: {
            v: 1;
            connectorId: string;
            externalChatId: string;
            createdAt: number;
            lastCommandAt?: number;
          };
        } | null>;
  };
  readonly invokeTrigger: {
    trigger(
      threadId: string,
      catId: CatId,
      userId: string,
      message: string,
      messageId: string,
      contentBlocks?: readonly MessageContent[],
      policy?: unknown,
      sender?: { id: string; name?: string },
    ): void;
  };
  readonly socketManager?:
    | {
        broadcastToRoom(room: string, event: string, data: unknown): void;
      }
    | undefined;
  readonly defaultUserId: string;
  readonly defaultCatId: CatId;
  readonly log: FastifyBaseLogger;
  readonly commandLayer?: ConnectorCommandLayer | undefined;
  readonly adapters?: Map<string, IOutboundAdapter> | undefined;
  readonly mediaService?:
    | {
        download(
          connectorId: string,
          attachment: {
            type: 'image' | 'file' | 'audio';
            platformKey: string;
            fileName?: string;
            duration?: number;
          },
        ): Promise<{ localUrl: string; absPath: string; mimeType: string }>;
      }
    | undefined;
  readonly sttProvider?:
    | {
        transcribe(request: { audioPath: string; language?: string }): Promise<{ text: string }>;
      }
    | undefined;
}

export class ConnectorRouter {
  private readonly formatter = new ConnectorMessageFormatter();
  private readonly hubThreadResolvers = new Map<string, Promise<string | undefined>>();

  constructor(private readonly opts: ConnectorRouterOptions) {}

  /** Build @-mention patterns from catRegistry for parseMentions. */
  private getMentionPatterns(): Map<string, string[]> {
    const patterns = new Map<string, string[]>();
    for (const catId of catRegistry.getAllIds()) {
      const entry = catRegistry.tryGet(catId);
      if (entry?.config.mentionPatterns && entry.config.mentionPatterns.length > 0) {
        patterns.set(catId, [...entry.config.mentionPatterns]);
      }
    }
    return patterns;
  }

  async route(
    connectorId: string,
    externalChatId: string,
    text: string,
    externalMessageId: string,
    attachments?: Array<{
      type: 'image' | 'file' | 'audio';
      platformKey: string;
      fileName?: string;
      duration?: number;
      messageId?: string;
    }>,
    sender?: { id: string; name?: string },
    chatType?: 'p2p' | 'group',
    chatName?: string,
  ): Promise<RouteResult> {
    const { bindingStore, dedup, messageStore, threadStore, invokeTrigger, socketManager, log } = this.opts;

    // 1. Dedup check
    if (dedup.isDuplicate(connectorId, externalChatId, externalMessageId)) {
      log.info({ connectorId, externalMessageId }, '[ConnectorRouter] Duplicate message skipped');
      return { kind: 'skipped', reason: 'duplicate' };
    }

    // 1b. Command interception — handle /commands before agent routing
    if (this.opts.commandLayer && text.trim().startsWith('/')) {
      const cmdResult = await this.opts.commandLayer.handle(connectorId, externalChatId, this.opts.defaultUserId, text);
      if (cmdResult.kind !== 'not-command' && cmdResult.response) {
        const adapter = this.opts.adapters?.get(connectorId);
        if (adapter) {
          if (adapter.sendFormattedReply) {
            const envelope = this.formatter.formatCommand(cmdResult.response);
            await adapter.sendFormattedReply(externalChatId, envelope);
          } else {
            await adapter.sendReply(externalChatId, cmdResult.response);
          }
        }
        // ISSUE-8 (8A): Store command exchange in Hub thread, not conversation thread
        const chatLabel = chatType === 'group' ? `飞书群聊 · ${chatName || externalChatId.slice(-8)}` : undefined;
        const hubThreadId = await this.resolveHubThread(connectorId, externalChatId, chatLabel);
        const stored = await this.storeCommandExchange(connectorId, hubThreadId, text, cmdResult.response);
        log.info(
          { connectorId, command: cmdResult.kind, hubThreadId },
          '[ConnectorRouter] Command handled → Hub thread',
        );

        // /thread: forward message content to the target thread
        if (cmdResult.forwardContent && cmdResult.newActiveThreadId) {
          const fwdThreadId = cmdResult.newActiveThreadId;
          const fwdText = cmdResult.forwardContent;
          const def2 = getConnectorDefinition(connectorId);
          const fwdSource: ConnectorSource = {
            connector: connectorId,
            label: def2?.displayName ?? connectorId,
            icon: def2?.icon ?? 'message',
          };
          const mentionPatterns = this.getMentionPatterns();
          const { targetCatId } = parseMentions(fwdText, mentionPatterns, this.opts.defaultCatId);
          const fwdStored = await messageStore.append({
            threadId: fwdThreadId,
            userId: this.opts.defaultUserId,
            catId: null,
            content: fwdText,
            source: fwdSource,
            mentions: [targetCatId],
            timestamp: Date.now(),
          });
          socketManager?.broadcastToRoom(`thread:${fwdThreadId}`, 'connector_message', {
            threadId: fwdThreadId,
            messageId: fwdStored.id,
            connectorId,
            content: fwdText,
          });
          invokeTrigger.trigger(fwdThreadId, targetCatId, this.opts.defaultUserId, fwdText, fwdStored.id);
          log.info({ connectorId, threadId: fwdThreadId }, '[ConnectorRouter] /thread message forwarded');
          return { kind: 'routed', threadId: fwdThreadId, messageId: fwdStored.id };
        }

        const result: RouteResult = { kind: 'command' };
        if (hubThreadId) (result as { threadId?: string }).threadId = hubThreadId;
        if (stored?.responseId) (result as { messageId?: string }).messageId = stored.responseId;
        return result;
      }
    }

    // Phase 5+6: Process media attachments
    let resolvedText = text;
    let contentBlocks: MessageContent[] | undefined;
    if (attachments?.length && this.opts.mediaService) {
      const result = await this.processAttachments(connectorId, text, attachments);
      resolvedText = result.text;
      if (result.contentBlocks.length > 0) contentBlocks = result.contentBlocks;
    }

    // 2. Lookup or create binding
    let binding = await bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) {
      const def = getConnectorDefinition(connectorId);
      const title =
        chatType === 'group'
          ? `飞书群聊 · ${chatName || externalChatId.slice(-8)}`
          : `${def?.displayName ?? connectorId} DM`;
      const thread = await threadStore.create(this.opts.defaultUserId, title);
      binding = await bindingStore.bind(connectorId, externalChatId, thread.id, this.opts.defaultUserId);
      log.info(
        { connectorId, externalChatId, threadId: thread.id },
        '[ConnectorRouter] New thread created for external chat',
      );
    }

    // 3. Post connector message
    const def = getConnectorDefinition(connectorId);
    const source: ConnectorSource = {
      connector: connectorId,
      label:
        chatType === 'group' ? `飞书群聊 · ${chatName || externalChatId.slice(-8)}` : (def?.displayName ?? connectorId),
      icon: def?.icon ?? 'message',
      ...(sender ? { sender } : {}),
    };

    // Parse @-mentions to determine target cat
    const mentionPatterns = this.getMentionPatterns();
    const { targetCatId } = parseMentions(resolvedText, mentionPatterns, this.opts.defaultCatId);

    const stored = await messageStore.append({
      threadId: binding.threadId,
      userId: this.opts.defaultUserId,
      catId: null,
      content: resolvedText,
      source,
      mentions: [targetCatId],
      timestamp: Date.now(),
    });

    // 4. Broadcast to WebSocket
    socketManager?.broadcastToRoom(`thread:${binding.threadId}`, 'connector_message', {
      threadId: binding.threadId,
      messageId: stored.id,
      connectorId,
      content: resolvedText,
    });

    // 5. Trigger cat invocation (use parsed targetCatId)
    invokeTrigger.trigger(
      binding.threadId,
      targetCatId,
      this.opts.defaultUserId,
      resolvedText,
      stored.id,
      contentBlocks,
      undefined,
      sender,
    );

    log.info(
      {
        connectorId,
        externalChatId,
        threadId: binding.threadId,
        messageId: stored.id,
      },
      '[ConnectorRouter] Message routed',
    );

    return {
      kind: 'routed',
      threadId: binding.threadId,
      messageId: stored.id,
    };
  }

  private async processAttachments(
    connectorId: string,
    originalText: string,
    attachments: Array<{
      type: 'image' | 'file' | 'audio';
      platformKey: string;
      fileName?: string;
      duration?: number;
      messageId?: string;
    }>,
  ): Promise<{ text: string; contentBlocks: MessageContent[] }> {
    const parts: string[] = [];
    const contentBlocks: MessageContent[] = [];

    for (const att of attachments) {
      try {
        const downloaded = await this.opts.mediaService?.download(connectorId, att);
        if (!downloaded) {
          throw new Error(`Media service unavailable for ${connectorId}`);
        }

        if (att.type === 'audio' && this.opts.sttProvider) {
          try {
            const result = await this.opts.sttProvider.transcribe({ audioPath: downloaded.absPath });
            parts.push(`🎤 ${result.text}`);
          } catch (sttErr) {
            this.opts.log.warn({ err: sttErr, connectorId }, '[ConnectorRouter] STT failed, using placeholder');
            parts.push(originalText);
          }
        } else if (att.type === 'image') {
          parts.push(`${originalText} ${downloaded.localUrl}`);
          contentBlocks.push({ type: 'image', url: downloaded.absPath });
        } else {
          parts.push(`${originalText} ${downloaded.localUrl}`);
        }
      } catch (err) {
        this.opts.log.warn({ err, connectorId }, '[ConnectorRouter] Media download failed');
        parts.push(originalText);
      }
    }

    return { text: parts.length > 0 ? parts.join('\n') : originalText, contentBlocks };
  }

  private async resolveHubThread(
    connectorId: string,
    externalChatId: string,
    chatLabel?: string,
  ): Promise<string | undefined> {
    const key = `${connectorId}:${externalChatId}`;
    const inFlight = this.hubThreadResolvers.get(key);
    if (inFlight) return inFlight;

    const binding = await this.opts.bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) return undefined;
    if (binding.hubThreadId) return binding.hubThreadId;

    const inFlightAfterRead = this.hubThreadResolvers.get(key);
    if (inFlightAfterRead) return inFlightAfterRead;

    const creation = this.resolveHubThreadOnce(connectorId, externalChatId, chatLabel).finally(() => {
      if (this.hubThreadResolvers.get(key) === creation) {
        this.hubThreadResolvers.delete(key);
      }
    });
    this.hubThreadResolvers.set(key, creation);
    return creation;
  }

  private async resolveHubThreadOnce(
    connectorId: string,
    externalChatId: string,
    chatLabel?: string,
  ): Promise<string | undefined> {
    const { bindingStore, threadStore, log } = this.opts;
    const binding = await bindingStore.getByExternal(connectorId, externalChatId);
    if (!binding) return undefined;
    if (binding.hubThreadId) return binding.hubThreadId;

    const def = getConnectorDefinition(connectorId);
    const label = def?.displayName ?? connectorId;
    const hubTitle = chatLabel ? `${chatLabel} IM Hub` : `${label} IM Hub`;
    const hubThread = await threadStore.create(this.opts.defaultUserId, hubTitle);
    await threadStore.updateConnectorHubState(hubThread.id, {
      v: 1,
      connectorId,
      externalChatId,
      createdAt: Date.now(),
    });
    await bindingStore.setHubThread(connectorId, externalChatId, hubThread.id);
    log.info({ connectorId, externalChatId, hubThreadId: hubThread.id }, '[ConnectorRouter] Hub thread created');
    return hubThread.id;
  }

  private async storeCommandExchange(
    connectorId: string,
    threadId: string | undefined,
    commandText: string,
    responseText: string,
  ): Promise<{ commandId: string; responseId: string } | undefined> {
    if (!threadId) return undefined;
    const { messageStore, socketManager } = this.opts;
    const def = getConnectorDefinition(connectorId);
    const now = Date.now();

    // Store inbound command
    const cmdMsg = await messageStore.append({
      threadId,
      userId: this.opts.defaultUserId,
      catId: null,
      content: commandText,
      source: { connector: connectorId, label: def?.displayName ?? connectorId, icon: def?.icon ?? 'message' },
      mentions: [],
      timestamp: now,
    });

    // Store outbound system response
    const resMsg = await messageStore.append({
      threadId,
      userId: this.opts.defaultUserId,
      catId: null,
      content: responseText,
      source: { connector: 'system-command', label: 'Clowder AI', icon: 'settings' },
      mentions: [],
      timestamp: now + 1,
    });

    // Broadcast both
    socketManager?.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
      threadId,
      messageId: cmdMsg.id,
      connectorId,
      content: commandText,
    });
    socketManager?.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
      threadId,
      messageId: resMsg.id,
      connectorId: 'system-command',
      content: responseText,
    });

    // G+: Update lastCommandAt on the Hub thread for audit visibility
    const { threadStore } = this.opts;
    if (threadStore.get) {
      const thread = await threadStore.get(threadId);
      if (thread?.connectorHubState) {
        await threadStore.updateConnectorHubState(threadId, {
          ...thread.connectorHubState,
          lastCommandAt: now,
        });
      }
    }

    return { commandId: cmdMsg.id, responseId: resMsg.id };
  }
}
