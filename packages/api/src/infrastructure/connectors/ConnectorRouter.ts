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
import { findMonorepoRoot } from '../../utils/monorepo-root.js';
import type { ConnectorCommandLayer } from './ConnectorCommandLayer.js';
import { ConnectorMessageFormatter } from './ConnectorMessageFormatter.js';
import type { IConnectorPermissionStore } from './ConnectorPermissionStore.js';
import type { IConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';
import type { InboundMessageDedup } from './InboundMessageDedup.js';
import { parseMentions } from './mention-parser.js';
import type { IOutboundAdapter } from './OutboundDeliveryHook.js';

/** Emit a connector_message socket event using the canonical protocol.
 *  All emit sites MUST use this to avoid protocol drift (旧/新 payload 不一致). */
function emitConnectorMessage(
  socketManager: { broadcastToRoom(room: string, event: string, data: unknown): void } | null | undefined,
  threadId: string,
  msg: { id: string; content: string; source: ConnectorSource; timestamp: number },
): void {
  socketManager?.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
    threadId,
    message: {
      id: msg.id,
      type: 'connector' as const,
      content: msg.content,
      source: msg.source,
      timestamp: msg.timestamp,
    },
  });
}

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
    create(userId: string, title?: string, projectPath?: string): { id: string } | Promise<{ id: string }>;
    updateConnectorHubState(
      threadId: string,
      state: { v: 1; connectorId: string; externalChatId: string; createdAt: number; lastCommandAt?: number } | null,
    ): void | Promise<void>;
    get?(threadId: string):
      | {
          projectPath?: string;
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
          projectPath?: string;
          connectorHubState?: {
            v: 1;
            connectorId: string;
            externalChatId: string;
            createdAt: number;
            lastCommandAt?: number;
          };
        } | null>;
    updateProjectPath?(threadId: string, projectPath: string): void | Promise<void>;
    getParticipantsWithActivity?(
      threadId: string,
    ):
      | Array<{ catId: string; lastMessageAt: number; messageCount: number }>
      | Promise<Array<{ catId: string; lastMessageAt: number; messageCount: number }>>;
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
    ): 'dispatched' | 'enqueued' | 'merged' | 'full';
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
  readonly permissionStore?: IConnectorPermissionStore | undefined;
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

    // F157: Fire-and-forget emoji reaction as instant ack (< 500ms)
    const ackAdapter = this.opts.adapters?.get(connectorId);
    if (ackAdapter?.addReaction && externalMessageId) {
      ackAdapter.addReaction(externalMessageId, 'HEART').catch((err) => {
        log.warn({ err, connectorId, externalMessageId }, '[ConnectorRouter] addReaction failed (non-fatal)');
      });
    }

    const trimmedText = text.trim();

    // 1a. F134 Phase D: Group whitelist check
    if (chatType === 'group' && this.opts.permissionStore) {
      const commandName = trimmedText.split(/\s+/, 1)[0]?.toLowerCase();
      const isAdminAllowGroupCommand =
        this.opts.commandLayer &&
        sender &&
        commandName === '/allow-group' &&
        (await this.opts.permissionStore.isAdmin(connectorId, sender.id));

      if (isAdminAllowGroupCommand) {
        log.info(
          { connectorId, externalChatId, senderId: sender.id },
          '[ConnectorRouter] Admin /allow-group bypasses whitelist precheck',
        );
      } else {
        const allowed = await this.opts.permissionStore.isGroupAllowed(connectorId, externalChatId);
        if (!allowed) {
          const adapter = this.opts.adapters?.get(connectorId);
          if (adapter) {
            await adapter.sendReply(externalChatId, '🔒 此群未授权使用 bot。请联系管理员使用 /allow-group 授权。');
            if (adapter.onDeliveryBatchDone) {
              await adapter.onDeliveryBatchDone(externalChatId, true);
            }
          }
          log.info({ connectorId, externalChatId }, '[ConnectorRouter] Group not in whitelist, skipped');
          return { kind: 'skipped', reason: 'group_not_allowed' };
        }
      }
    }

    // 1b. Command interception — handle /commands before agent routing
    if (this.opts.commandLayer && trimmedText.startsWith('/')) {
      // F134 Phase D: admin-only commands in group chats
      if (chatType === 'group' && sender && this.opts.permissionStore) {
        const isAdmin = await this.opts.permissionStore.isAdmin(connectorId, sender.id);
        const cmdAdminOnly = await this.opts.permissionStore.isCommandAdminOnly(connectorId);
        if (cmdAdminOnly && !isAdmin) {
          const adapter = this.opts.adapters?.get(connectorId);
          if (adapter) {
            await adapter.sendReply(externalChatId, '🔒 此命令仅管理员可用。');
            if (adapter.onDeliveryBatchDone) {
              await adapter.onDeliveryBatchDone(externalChatId, true);
            }
          }
          log.info({ connectorId, senderId: sender.id }, '[ConnectorRouter] Non-admin command in group, blocked');
          return { kind: 'skipped', reason: 'command_admin_only' };
        }
      }
      const cmdResult = await this.opts.commandLayer.handle(
        connectorId,
        externalChatId,
        this.opts.defaultUserId,
        text,
        sender?.id,
      );
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
        const cmdDef = getConnectorDefinition(connectorId);
        const chatLabel =
          chatType === 'group'
            ? `${cmdDef?.displayName ?? connectorId}群聊 · ${chatName || externalChatId.slice(-8)}`
            : undefined;
        const hubThreadId = await this.resolveHubThread(connectorId, externalChatId, chatLabel);
        const stored = await this.storeCommandExchange(connectorId, hubThreadId, text, cmdResult.response);
        log.info(
          { connectorId, command: cmdResult.kind, hubThreadId },
          '[ConnectorRouter] Command handled → Hub thread',
        );

        // /thread: forward message content to the target thread.
        // When forwarding, do NOT close the A2A task — the delivery
        // pipeline's notifyDeliveryBatchDone signal will close it after
        // the forwarded invocation completes (F151 P1-2 fix).
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
          const fwdTimestamp = Date.now();
          const fwdStored = await messageStore.append({
            threadId: fwdThreadId,
            userId: this.opts.defaultUserId,
            catId: null,
            content: fwdText,
            source: fwdSource,
            mentions: [targetCatId],
            timestamp: fwdTimestamp,
          });
          emitConnectorMessage(socketManager, fwdThreadId, {
            id: fwdStored.id,
            content: fwdText,
            source: fwdSource,
            timestamp: fwdTimestamp,
          });
          const triggerOutcome = invokeTrigger.trigger(
            fwdThreadId,
            targetCatId,
            this.opts.defaultUserId,
            fwdText,
            fwdStored.id,
          );
          log.info(
            { connectorId, threadId: fwdThreadId, triggerOutcome },
            '[ConnectorRouter] /thread message forwarded',
          );

          // F151 P1: If the target queue was full, no invocation will run and no
          // notifyDeliveryBatchDone signal will come — close the task here to
          // prevent it from staying open until TASK_TIMEOUT_MS.
          if (triggerOutcome === 'full' && adapter?.onDeliveryBatchDone) {
            await adapter.onDeliveryBatchDone(externalChatId, true);
          }

          return { kind: 'routed', threadId: fwdThreadId, messageId: fwdStored.id };
        }

        // F154: /ask one-shot routing — forward to current thread with explicit targetCatId.
        // Unlike /thread, this stays in the same binding's thread (KD-4: normal routing pipeline).
        if (cmdResult.forwardContent && cmdResult.targetCatId && !cmdResult.newActiveThreadId) {
          const askBinding = await bindingStore.getByExternal(connectorId, externalChatId);
          const askThreadId = askBinding?.threadId;
          if (askThreadId) {
            const askText = cmdResult.forwardContent;
            const def2 = getConnectorDefinition(connectorId);
            const askSource: ConnectorSource = {
              connector: connectorId,
              label: def2?.displayName ?? connectorId,
              icon: def2?.icon ?? 'message',
              ...(sender ? { sender } : {}),
            };
            const askCatId = cmdResult.targetCatId as CatId;
            const askTimestamp = Date.now();
            const askStored = await messageStore.append({
              threadId: askThreadId,
              userId: this.opts.defaultUserId,
              catId: null,
              content: askText,
              source: askSource,
              mentions: [askCatId],
              timestamp: askTimestamp,
            });
            emitConnectorMessage(socketManager, askThreadId, {
              id: askStored.id,
              content: askText,
              source: askSource,
              timestamp: askTimestamp,
            });
            const triggerOutcome = invokeTrigger.trigger(
              askThreadId,
              askCatId,
              this.opts.defaultUserId,
              askText,
              askStored.id,
            );
            log.info(
              { connectorId, threadId: askThreadId, catId: askCatId, triggerOutcome },
              '[ConnectorRouter] /ask message forwarded to current thread',
            );
            if (triggerOutcome === 'full' && adapter?.onDeliveryBatchDone) {
              await adapter.onDeliveryBatchDone(externalChatId, true);
            }
            return { kind: 'routed', threadId: askThreadId, messageId: askStored.id };
          }
        }

        // F151: Close the A2A task after command response (non-forward path).
        // Placed after /thread check so forwarded invocations can still
        // deliver through the open task.
        if (adapter?.onDeliveryBatchDone) {
          await adapter.onDeliveryBatchDone(externalChatId, true);
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
      const platformLabel = def?.displayName ?? connectorId;
      const title =
        chatType === 'group' ? `${platformLabel}群聊 · ${chatName || externalChatId.slice(-8)}` : `${platformLabel} DM`;
      const thread = await threadStore.create(this.opts.defaultUserId, title, findMonorepoRoot());
      binding = await bindingStore.bind(connectorId, externalChatId, thread.id, this.opts.defaultUserId);
      log.info(
        { connectorId, externalChatId, threadId: thread.id },
        '[ConnectorRouter] New thread created for external chat',
      );
    } else if (threadStore.get && threadStore.updateProjectPath) {
      // ISSUE-16 lazy heal: backfill projectPath for threads created before the fix
      const existing = await threadStore.get(binding.threadId);
      if (existing && (!existing.projectPath || existing.projectPath === 'default')) {
        await threadStore.updateProjectPath(binding.threadId, findMonorepoRoot());
      }
    }

    // 3. Post connector message
    const def = getConnectorDefinition(connectorId);
    const source: ConnectorSource = {
      connector: connectorId,
      label:
        chatType === 'group'
          ? `${def?.displayName ?? connectorId}群聊 · ${chatName || externalChatId.slice(-8)}`
          : (def?.displayName ?? connectorId),
      icon: def?.icon ?? 'message',
      ...(sender ? { sender } : {}),
    };

    // Parse @-mentions to determine target cat
    const mentionPatterns = this.getMentionPatterns();
    const mentionResult = parseMentions(resolvedText, mentionPatterns, this.opts.defaultCatId);
    let targetCatId = mentionResult.targetCatId;
    if (!mentionResult.matched && this.opts.threadStore.getParticipantsWithActivity) {
      const participants = await this.opts.threadStore.getParticipantsWithActivity(binding.threadId);
      const lastActive = participants
        .filter((p) => p.messageCount > 0)
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
      if (lastActive) {
        targetCatId = lastActive.catId as CatId;
      }
    }

    const storedTimestamp = Date.now();
    const stored = await messageStore.append({
      threadId: binding.threadId,
      userId: this.opts.defaultUserId,
      catId: null,
      content: resolvedText,
      source,
      mentions: [targetCatId],
      timestamp: storedTimestamp,
      ...(contentBlocks ? { contentBlocks } : {}),
    });

    // 4. Broadcast to WebSocket
    emitConnectorMessage(socketManager, binding.threadId, {
      id: stored.id,
      content: resolvedText,
      source,
      timestamp: storedTimestamp,
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
    const hubThread = await threadStore.create(this.opts.defaultUserId, hubTitle, findMonorepoRoot());
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
    emitConnectorMessage(socketManager, threadId, {
      id: cmdMsg.id,
      content: commandText,
      source: { connector: connectorId, label: def?.displayName ?? connectorId, icon: def?.icon ?? 'message' },
      timestamp: now,
    });
    emitConnectorMessage(socketManager, threadId, {
      id: resMsg.id,
      content: responseText,
      source: { connector: 'system-command', label: 'Clowder AI', icon: 'settings' },
      timestamp: now + 1,
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
