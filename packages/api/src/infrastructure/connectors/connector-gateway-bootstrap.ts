/**
 * Connector Gateway Bootstrap
 * Wires all connector gateway components together.
 *
 * Follows github-review-bootstrap.ts pattern:
 * - Takes options with dependencies
 * - Checks env config before starting
 * - Returns lifecycle handle { stop }
 *
 * F088 Multi-Platform Chat Gateway
 */

import { resolve } from 'node:path';
import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorWebhookHandler, WebhookHandleResult } from '../../routes/connector-webhooks.js';
import { deliverConnectorMessage } from '../email/deliver-connector-message.js';
import { DingTalkAdapter } from './adapters/DingTalkAdapter.js';
import { FeishuAdapter } from './adapters/FeishuAdapter.js';
import { FeishuTokenManager } from './adapters/FeishuTokenManager.js';
import { TelegramAdapter } from './adapters/TelegramAdapter.js';
import { WeixinAdapter } from './adapters/WeixinAdapter.js';
import { ConnectorCommandLayer } from './ConnectorCommandLayer.js';
import {
  type IConnectorPermissionStore,
  MemoryConnectorPermissionStore,
  RedisConnectorPermissionStore,
} from './ConnectorPermissionStore.js';
import { ConnectorRouter } from './ConnectorRouter.js';
import { MemoryConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';
import { GitHubRepoWebhookHandler } from './github-repo-event/GitHubRepoWebhookHandler.js';
import { ReconciliationDedup } from './github-repo-event/ReconciliationDedup.js';
import { RedisDeliveryDedup } from './github-repo-event/RedisDeliveryDedup.js';
import { InboundMessageDedup } from './InboundMessageDedup.js';
import { ConnectorMediaService } from './media/ConnectorMediaService.js';
import { MediaCleanupJob } from './media/MediaCleanupJob.js';
import {
  type IOutboundAdapter,
  type IStreamableOutboundAdapter,
  OutboundDeliveryHook,
} from './OutboundDeliveryHook.js';
import { RedisConnectorThreadBindingStore } from './RedisConnectorThreadBindingStore.js';
import { StreamingOutboundHook } from './StreamingOutboundHook.js';

export interface ConnectorGatewayConfig {
  telegramBotToken?: string | undefined;
  feishuAppId?: string | undefined;
  feishuAppSecret?: string | undefined;
  feishuVerificationToken?: string | undefined;
  feishuBotOpenId?: string | undefined;
  feishuAdminOpenIds?: string | undefined;
  /** F134-E: 'webhook' (default) or 'websocket' (long-connection via WSClient) */
  feishuConnectionMode?: 'webhook' | 'websocket' | undefined;
  dingtalkAppKey?: string | undefined;
  dingtalkAppSecret?: string | undefined;
  weixinBotToken?: string | undefined;
  /** Override co-creator userId for connector threads. Read from DEFAULT_OWNER_USER_ID env. */
  coCreatorUserId?: string | undefined;
  whisperUrl?: string | undefined;
  connectorMediaDir?: string | undefined;
}

export interface ConnectorGatewayDeps {
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
    getById?(id: string): Promise<{ source?: ConnectorSource } | null>;
  };
  readonly threadStore: {
    create(userId: string, title?: string): { id: string } | Promise<{ id: string }>;
    get(id: string):
      | {
          id: string;
          title?: string | null;
          createdAt?: number;
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
          id: string;
          title?: string | null;
          createdAt?: number;
          connectorHubState?: {
            v: 1;
            connectorId: string;
            externalChatId: string;
            createdAt: number;
            lastCommandAt?: number;
          };
        } | null>;
    list(
      userId: string,
    ):
      | Array<{ id: string; title?: string | null; lastActiveAt?: number; backlogItemId?: string }>
      | Promise<Array<{ id: string; title?: string | null; lastActiveAt?: number; backlogItemId?: string }>>;
    updateConnectorHubState(
      threadId: string,
      state: { v: 1; connectorId: string; externalChatId: string; createdAt: number; lastCommandAt?: number } | null,
    ): void | Promise<void>;
  };
  /** Phase D: optional backlog store for feat-number matching in /use */
  readonly backlogStore?: {
    get(
      itemId: string,
      userId?: string,
    ): { tags: readonly string[] } | null | Promise<{ tags: readonly string[] } | null>;
  };
  readonly invokeTrigger: {
    trigger(
      threadId: string,
      catId: CatId,
      userId: string,
      message: string,
      messageId: string,
      ...args: unknown[]
    ): void;
  };
  readonly socketManager?:
    | {
        broadcastToRoom(room: string, event: string, data: unknown): void;
      }
    | undefined;
  readonly defaultUserId: string;
  readonly defaultCatId: CatId;
  readonly redis?: RedisClient | undefined;
  readonly log: FastifyBaseLogger;
  readonly frontendBaseUrl?: string | undefined;
  /** @internal Test-only: override WSClient factory to avoid real SDK connections */
  readonly _wsClientFactory?:
    | ((opts: { appId: string; appSecret: string }) => {
        start(opts: unknown): Promise<void>;
        close(opts?: unknown): void;
      })
    | undefined;
}

export interface ConnectorGatewayHandle {
  readonly outboundHook: OutboundDeliveryHook;
  readonly streamingHook: StreamingOutboundHook;
  readonly webhookHandlers: Map<string, ConnectorWebhookHandler>;
  readonly weixinAdapter: InstanceType<typeof WeixinAdapter> | null;
  readonly permissionStore: IConnectorPermissionStore;
  readonly startWeixinPolling: () => void;
  stop(): Promise<void>;
}

export function loadConnectorGatewayConfig(): ConnectorGatewayConfig {
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    feishuAppId: process.env.FEISHU_APP_ID,
    feishuAppSecret: process.env.FEISHU_APP_SECRET,
    feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    feishuBotOpenId: process.env.FEISHU_BOT_OPEN_ID,
    feishuAdminOpenIds: process.env.FEISHU_ADMIN_OPEN_IDS,
    feishuConnectionMode: process.env.FEISHU_CONNECTION_MODE === 'websocket' ? 'websocket' : 'webhook',
    dingtalkAppKey: process.env.DINGTALK_APP_KEY,
    dingtalkAppSecret: process.env.DINGTALK_APP_SECRET,
    weixinBotToken: process.env.WEIXIN_BOT_TOKEN,
    coCreatorUserId: process.env.DEFAULT_OWNER_USER_ID,
    whisperUrl: process.env.WHISPER_URL,
    connectorMediaDir: process.env.CONNECTOR_MEDIA_DIR,
  };
}

export async function startConnectorGateway(
  config: ConnectorGatewayConfig,
  deps: ConnectorGatewayDeps,
): Promise<ConnectorGatewayHandle | null> {
  const { log } = deps;

  const hasTelegram = Boolean(config.telegramBotToken);
  const feishuWsMode = config.feishuConnectionMode === 'websocket';
  const hasFeishu = Boolean(
    config.feishuAppId && config.feishuAppSecret && (feishuWsMode || config.feishuVerificationToken),
  );
  const hasDingTalk = Boolean(config.dingtalkAppKey && config.dingtalkAppSecret);
  const hasWeixin = Boolean(config.weixinBotToken);

  if (!hasTelegram && !hasFeishu && !hasDingTalk && !hasWeixin) {
    log.info('[ConnectorGateway] No pre-configured connectors — gateway created for WeChat QR login support');
  }

  const bindingStore = deps.redis
    ? new RedisConnectorThreadBindingStore(deps.redis)
    : new MemoryConnectorThreadBindingStore();
  const dedup = new InboundMessageDedup();
  log.info({ store: deps.redis ? 'redis' : 'memory' }, '[ConnectorGateway] Binding store initialized');
  const adapters = new Map<string, IOutboundAdapter>();
  const webhookHandlers = new Map<string, ConnectorWebhookHandler>();
  const stopFns: Array<() => Promise<void>> = [];

  // Use coCreatorUserId from config (DEFAULT_OWNER_USER_ID env) if set,
  // otherwise fall back to deps.defaultUserId.
  // This ensures connector threads are created with the real owner's userId,
  // making them visible in the frontend thread list. (F088 ISSUE-1 fix)
  const effectiveUserId = config.coCreatorUserId || deps.defaultUserId;

  // F134 Phase D: Permission store + admin config
  const adminOpenIds = config.feishuAdminOpenIds
    ? config.feishuAdminOpenIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const permissionStore: IConnectorPermissionStore = deps.redis
    ? new RedisConnectorPermissionStore(deps.redis)
    : new MemoryConnectorPermissionStore();
  if (adminOpenIds.length > 0) {
    const alreadyConfigured = await permissionStore.hasAdminConfig('feishu');
    if (!alreadyConfigured) {
      await permissionStore.setAdminOpenIds('feishu', adminOpenIds);
      log.info(
        { adminCount: adminOpenIds.length },
        '[ConnectorGateway] Feishu admin open_ids seeded from env (first boot)',
      );
    } else {
      log.info('[ConnectorGateway] Feishu admin config already persisted, env seed skipped');
    }
  }

  const commandLayer = new ConnectorCommandLayer({
    bindingStore,
    threadStore: deps.threadStore,
    ...(deps.backlogStore ? { backlogStore: deps.backlogStore } : {}),
    frontendBaseUrl: deps.frontendBaseUrl ?? 'http://localhost:3003',
    permissionStore,
  });

  // Phase 5+6: Media service + STT provider (optional)
  const mediaDir = config.connectorMediaDir ?? './data/connector-media';
  const mediaService = new ConnectorMediaService({
    mediaDir,
  });

  let sttProvider:
    | { transcribe(request: { audioPath: string; language?: string }): Promise<{ text: string }> }
    | undefined;
  if (config.whisperUrl) {
    const { WhisperSttProvider } = await import('./media/WhisperSttProvider.js');
    sttProvider = new WhisperSttProvider({ baseUrl: config.whisperUrl });
  }

  const connectorRouter = new ConnectorRouter({
    bindingStore,
    dedup,
    messageStore: deps.messageStore,
    threadStore: deps.threadStore,
    invokeTrigger: deps.invokeTrigger,
    socketManager: deps.socketManager,
    defaultUserId: effectiveUserId,
    defaultCatId: deps.defaultCatId,
    log,
    commandLayer,
    permissionStore,
    adapters,
    mediaService,
    sttProvider,
  });

  // ── Telegram (long polling) ──
  if (hasTelegram) {
    const telegram = new TelegramAdapter(config.telegramBotToken!, log);
    adapters.set('telegram', telegram);

    telegram.startPolling(async (msg) => {
      const attachments = msg.attachments?.map((a) => ({
        type: a.type,
        platformKey: a.telegramFileId,
        ...(a.fileName ? { fileName: a.fileName } : {}),
        ...(a.duration != null ? { duration: a.duration } : {}),
      }));
      await connectorRouter.route('telegram', msg.chatId, msg.text, msg.messageId, attachments);
    });

    stopFns.push(async () => telegram.stopPolling());
    log.info('[ConnectorGateway] Telegram adapter started (long polling)');
  }

  // ── Feishu (webhook or websocket) ──
  if (hasFeishu) {
    const feishu = new FeishuAdapter(config.feishuAppId!, config.feishuAppSecret!, log, {
      verificationToken: config.feishuVerificationToken,
    });
    const feishuTokenManager = new FeishuTokenManager({
      appId: config.feishuAppId!,
      appSecret: config.feishuAppSecret!,
    });
    feishu._injectTokenManager(feishuTokenManager);
    adapters.set('feishu', feishu);

    // F134: Resolve bot open_id for @bot detection in group chats
    const envBotOpenId = config.feishuBotOpenId;
    if (envBotOpenId) {
      feishu.setBotOpenId(envBotOpenId);
      log.info({ botOpenId: envBotOpenId }, '[Feishu] Bot open_id set from config');
    } else {
      feishuTokenManager
        .getTenantAccessToken()
        .then(async (token) => {
          try {
            const res = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
              const data = (await res.json()) as { bot?: { open_id?: string } };
              const openId = data?.bot?.open_id;
              if (openId) {
                feishu.setBotOpenId(openId);
                log.info({ botOpenId: openId }, '[Feishu] Bot open_id resolved via API');
              }
            }
          } catch (err) {
            log.warn({ err }, '[Feishu] Failed to resolve bot open_id — group chat @bot detection disabled');
          }
        })
        .catch(() => {});
    }

    mediaService.setFeishuDownloadFn(async (fileKey: string, type: string, messageId?: string) => {
      const token = await feishuTokenManager.getTenantAccessToken();
      if (!messageId) throw new Error('Feishu download requires messageId');
      const resourceType = type === 'image' ? 'image' : 'file';
      const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${resourceType}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`Feishu resource download failed: ${res.status} ${res.statusText}`);
      }
      return Buffer.from(await res.arrayBuffer());
    });

    // Shared routing logic for both webhook and websocket inbound messages
    async function routeFeishuParsedEvent(parsed: NonNullable<ReturnType<FeishuAdapter['parseEvent']>>) {
      const attachments = parsed.attachments?.map((a) => ({
        type: a.type,
        platformKey: a.feishuKey,
        messageId: parsed.messageId,
        ...(a.fileName ? { fileName: a.fileName } : {}),
        ...(a.duration != null ? { duration: a.duration } : {}),
      }));

      let senderName = parsed.senderName;
      let chatName = parsed.chatName;
      if (parsed.chatType === 'group') {
        if (!senderName) {
          senderName = await feishu.resolveSenderName(parsed.senderId).catch(() => undefined);
        }
        if (!chatName) {
          chatName = await feishu.resolveChatName(parsed.chatId).catch(() => undefined);
        }
      }
      const sender =
        parsed.chatType === 'group' && parsed.senderId !== 'unknown'
          ? { id: parsed.senderId, ...(senderName ? { name: senderName } : {}) }
          : undefined;

      return connectorRouter.route(
        'feishu',
        parsed.chatId,
        parsed.text,
        parsed.messageId,
        attachments,
        sender,
        parsed.chatType,
        chatName,
      );
    }

    if (feishuWsMode) {
      // ── Feishu WebSocket (long-connection) mode ──
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: Record<string, unknown>) => {
          log.info(
            {
              msgType: (data.message as Record<string, unknown> | undefined)?.message_type,
              chatType: (data.message as Record<string, unknown> | undefined)?.chat_type,
            },
            '[Feishu] WS event received',
          );
          // Wrap into the envelope format parseEvent expects: { header, event }
          const envelope = {
            header: { event_type: 'im.message.receive_v1' },
            event: data,
          };
          const parsed = feishu.parseEvent(envelope);
          if (!parsed) return;
          await routeFeishuParsedEvent(parsed);
        },
      });

      const wsClient = deps._wsClientFactory
        ? deps._wsClientFactory({ appId: config.feishuAppId!, appSecret: config.feishuAppSecret! })
        : new lark.WSClient({
            appId: config.feishuAppId!,
            appSecret: config.feishuAppSecret!,
            loggerLevel: lark.LoggerLevel.info,
          });

      try {
        await wsClient.start({ eventDispatcher });
        log.info('[ConnectorGateway] Feishu adapter started (WebSocket long-connection mode)');
      } catch (err) {
        log.warn({ err }, '[Feishu] WSClient initial connection failed — will auto-reconnect');
      }

      stopFns.push(async () => {
        try {
          wsClient.close({ force: true });
        } catch {
          // WSClient may already be torn down
        }
      });
    } else {
      // ── Feishu Webhook mode (default) ──
      webhookHandlers.set('feishu', {
        connectorId: 'feishu',
        async handleWebhook(body, _headers): Promise<WebhookHandleResult> {
          const eventHeader = (body as Record<string, unknown>)?.header as Record<string, unknown> | undefined;
          const msgType = ((body as Record<string, unknown>)?.event as Record<string, unknown> | undefined)?.message as
            | Record<string, unknown>
            | undefined;
          log.info(
            {
              eventType: eventHeader?.event_type,
              msgType: msgType?.message_type,
              chatType: msgType?.chat_type,
            },
            '[Feishu] Webhook received',
          );

          const challenge = feishu.isVerificationChallenge(body);
          if (challenge) {
            return { kind: 'challenge', response: { challenge: challenge.challenge } };
          }

          if (!feishu.verifyEventToken(body)) {
            log.warn('[Feishu] Webhook rejected: invalid verification token');
            return { kind: 'error', status: 403, message: 'Invalid verification token' };
          }

          const cardAction = feishu.parseCardAction(body);
          if (cardAction) {
            const actionText = JSON.stringify(cardAction.actionValue);
            const result = await connectorRouter.route(
              'feishu',
              cardAction.chatId,
              actionText,
              `card-action-${Date.now()}`,
            );
            return result.kind === 'skipped'
              ? { kind: 'skipped', reason: result.reason }
              : { kind: 'processed', messageId: result.kind === 'routed' ? result.messageId : 'card-action' };
          }

          const parsed = feishu.parseEvent(body);
          if (!parsed) {
            log.warn(
              { eventType: eventHeader?.event_type, msgType: msgType?.message_type },
              '[Feishu] Event skipped: parseEvent returned null (unsupported_event)',
            );
            return { kind: 'skipped', reason: 'unsupported_event' };
          }

          const result = await routeFeishuParsedEvent(parsed);

          if (result.kind === 'skipped') {
            return { kind: 'skipped', reason: result.reason };
          }

          if (result.kind === 'command') {
            return { kind: 'processed', messageId: 'command' };
          }

          return { kind: 'processed', messageId: result.messageId };
        },
      });

      log.info('[ConnectorGateway] Feishu adapter registered (webhook mode)');
    }
  }

  // ── F141: GitHub Repo Inbox webhook handler ──
  const ghWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const ghRepoAllowlist = process.env.GITHUB_REPO_ALLOWLIST;
  const ghInboxCatId = process.env.GITHUB_REPO_INBOX_CAT_ID;

  if (ghWebhookSecret && ghRepoAllowlist && ghInboxCatId && deps.redis) {
    const ghDedup = new RedisDeliveryDedup(deps.redis as import('./github-repo-event/RedisDeliveryDedup.js').RedisLike);
    const ghReconciliationDedup = new ReconciliationDedup(
      deps.redis as import('./github-repo-event/ReconciliationDedup.js').ReconciliationRedisLike,
    );
    const ghHandler = new GitHubRepoWebhookHandler(
      {
        webhookSecret: ghWebhookSecret,
        repoAllowlist: ghRepoAllowlist.split(',').map((r) => r.trim()),
        inboxCatId: ghInboxCatId,
        defaultUserId: effectiveUserId, // P1-2: use effective owner for thread visibility (F088 pattern)
      },
      {
        bindingStore,
        threadStore: deps.threadStore,
        deliverFn: deliverConnectorMessage,
        invokeTrigger: deps.invokeTrigger,
        dedup: ghDedup,
        reconciliationDedup: ghReconciliationDedup, // Phase B bridge (KD-15)
        redis: deps.redis as import('./github-repo-event/RedisDeliveryDedup.js').RedisLike, // KD-20: inbox thread creation lock
        deliveryDeps: {
          messageStore:
            deps.messageStore as import('../../domains/cats/services/stores/ports/MessageStore.js').IMessageStore,
          socketManager: deps.socketManager,
        },
      },
    );
    webhookHandlers.set('github-repo-event', ghHandler);
    log.info('[F141] GitHub Repo Inbox webhook handler registered');
  } else if (ghWebhookSecret || ghRepoAllowlist || ghInboxCatId) {
    log.warn('[F141] GitHub Repo Inbox partially configured — set all 3 env vars + Redis to enable');
  }

  // ── DingTalk (Stream mode) ──
  if (hasDingTalk) {
    const dingtalk = new DingTalkAdapter(log, {
      appKey: config.dingtalkAppKey!,
      appSecret: config.dingtalkAppSecret!,
      redis: deps.redis,
    });
    adapters.set('dingtalk', dingtalk);

    await dingtalk.hydrateGroupChatIds();

    mediaService.setDingtalkDownloadFn(async (downloadCode: string) => {
      const downloadUrl = await dingtalk.downloadMedia(downloadCode);
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`DingTalk media fetch failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });

    await dingtalk.startStream(async (msg) => {
      const attachments = msg.attachments?.map((a) => ({
        type: a.type,
        platformKey: a.downloadCode ?? '',
        ...(a.fileName ? { fileName: a.fileName } : {}),
        ...(a.duration != null ? { duration: a.duration } : {}),
      }));

      // F132 A.2: Register group chatId so outbound dispatch survives cold restarts
      if (msg.chatType === 'group') {
        dingtalk.registerGroupChatId(msg.chatId);
      }

      // F132 A.2: Enrich sender and chat info (mirroring F134 Feishu pattern)
      const senderName = msg.senderNick ?? dingtalk.resolveSenderName(msg.senderId);
      const chatName = msg.conversationTitle ?? dingtalk.resolveConversationTitle(msg.chatId);

      const sender =
        msg.chatType === 'group' && msg.senderId !== 'unknown'
          ? { id: msg.senderId, ...(senderName ? { name: senderName } : {}) }
          : undefined;

      await connectorRouter.route(
        'dingtalk',
        msg.chatId,
        msg.text,
        msg.messageId,
        attachments,
        sender,
        msg.chatType,
        chatName,
      );
    });

    stopFns.push(async () => dingtalk.stopStream());

    log.info('[ConnectorGateway] DingTalk adapter started (Stream mode)');
  }

  // ── WeChat Personal (iLink Bot long polling) ──
  // Always create the adapter instance (for QR login routes); only start polling if we have a token.
  const weixin = new WeixinAdapter(config.weixinBotToken ?? '', log);
  adapters.set('weixin', weixin);

  const startWeixinPolling = () => {
    weixin.startPolling(async (msg) => {
      const attachments = msg.attachments?.map((a) => ({
        type: a.type,
        platformKey: a.mediaUrl,
        ...(a.fileName ? { fileName: a.fileName } : {}),
      }));
      await connectorRouter.route('weixin', msg.chatId, msg.text, msg.messageId, attachments);
    });
  };

  if (hasWeixin) {
    startWeixinPolling();
    log.info('[ConnectorGateway] WeChat adapter started (iLink Bot long polling)');
  } else {
    log.info('[ConnectorGateway] WeChat adapter registered (awaiting QR login)');
  }

  weixin.setOnSessionExpired(() => {
    log.warn('[ConnectorGateway] WeChat session expired — user must re-scan QR code');
  });

  // Register weixin CDN download function for inbound media
  mediaService.setWeixinDownloadFn(async (platformKey: string) => {
    const { downloadMediaFromCdn } = await import('./adapters/weixin-cdn.js');
    return downloadMediaFromCdn({
      platformKey,
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      log,
    });
  });

  stopFns.push(async () => weixin.stopPolling());

  // R3-P1: Resolve route URLs to local file paths for real media delivery
  const uploadDir = resolve(process.env.UPLOAD_DIR ?? './uploads');
  const ttsCacheDir = resolve(process.env.TTS_CACHE_DIR ?? './data/tts-cache');
  const resolvedMediaDir = resolve(mediaDir);
  const mediaPathResolver = (url: string): string | undefined => {
    // Phase J P1: guard against path traversal (e.g. /uploads/../../etc/passwd)
    const safeResolve = (base: string, suffix: string): string | undefined => {
      const resolved = resolve(base, suffix);
      return resolved.startsWith(base + '/') || resolved === base ? resolved : undefined;
    };
    if (url.startsWith('/uploads/')) return safeResolve(uploadDir, url.slice('/uploads/'.length));
    if (url.startsWith('/api/tts/audio/')) return safeResolve(ttsCacheDir, url.slice('/api/tts/audio/'.length));
    if (url.startsWith('/api/connector-media/'))
      return safeResolve(resolvedMediaDir, url.slice('/api/connector-media/'.length));
    return undefined;
  };

  const messageLookup = deps.messageStore.getById
    ? async (messageId: string) => deps.messageStore.getById!(messageId)
    : undefined;

  const outboundHook = new OutboundDeliveryHook({
    bindingStore,
    adapters,
    log,
    mediaPathResolver,
    messageLookup,
  });

  // Build streamable adapters map (only adapters with sendPlaceholder + editMessage)
  const streamableAdapters = new Map<string, IStreamableOutboundAdapter>();
  for (const [id, adapter] of adapters) {
    if ('sendPlaceholder' in adapter && 'editMessage' in adapter) {
      streamableAdapters.set(id, adapter as IStreamableOutboundAdapter);
    }
  }

  const streamingHook = new StreamingOutboundHook({
    bindingStore,
    adapters: streamableAdapters,
    log,
  });

  // Phase 5b: Media file cleanup (24h TTL, sweep every hour)
  const cleanupJob = new MediaCleanupJob({
    mediaDir: resolvedMediaDir,
    ttlMs: 24 * 60 * 60 * 1000,
    intervalMs: 60 * 60 * 1000,
    log,
  });
  cleanupJob.start();
  log.info('[ConnectorGateway] Media cleanup job started (24h TTL, 1h sweep)');

  return {
    outboundHook,
    streamingHook,
    webhookHandlers,
    weixinAdapter: weixin,
    permissionStore,
    startWeixinPolling,
    async stop() {
      cleanupJob.stop();
      await Promise.allSettled(stopFns.map((fn) => fn()));
      log.info('[ConnectorGateway] Stopped');
    },
  };
}
