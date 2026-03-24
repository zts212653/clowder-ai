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
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorWebhookHandler, WebhookHandleResult } from '../../routes/connector-webhooks.js';
import { DingTalkAdapter } from './adapters/DingTalkAdapter.js';
import { FeishuAdapter } from './adapters/FeishuAdapter.js';
import { FeishuTokenManager } from './adapters/FeishuTokenManager.js';
import { TelegramAdapter } from './adapters/TelegramAdapter.js';
import { WeixinAdapter } from './adapters/WeixinAdapter.js';
import { ConnectorCommandLayer } from './ConnectorCommandLayer.js';
import { ConnectorRouter } from './ConnectorRouter.js';
import { MemoryConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';
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
}

export interface ConnectorGatewayHandle {
  readonly outboundHook: OutboundDeliveryHook;
  readonly streamingHook: StreamingOutboundHook;
  readonly webhookHandlers: Map<string, ConnectorWebhookHandler>;
  readonly weixinAdapter: InstanceType<typeof WeixinAdapter> | null;
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
  const hasFeishu = Boolean(config.feishuAppId && config.feishuAppSecret && config.feishuVerificationToken);
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

  const commandLayer = new ConnectorCommandLayer({
    bindingStore,
    threadStore: deps.threadStore,
    ...(deps.backlogStore ? { backlogStore: deps.backlogStore } : {}),
    frontendBaseUrl: deps.frontendBaseUrl ?? 'http://localhost:3003',
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

  // ── Feishu (webhook) ──
  if (hasFeishu) {
    const feishu = new FeishuAdapter(config.feishuAppId!, config.feishuAppSecret!, log, {
      verificationToken: config.feishuVerificationToken,
    });
    // Inject token manager for native media upload (Feishu /im/v1/images + /im/v1/files)
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

    // Register webhook handler for the route
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

        // Handle verification challenge (no token check — challenge is pre-auth)
        const challenge = feishu.isVerificationChallenge(body);
        if (challenge) {
          return { kind: 'challenge', response: { challenge: challenge.challenge } };
        }

        // Verify event token (AC-4: webhook authentication)
        if (!feishu.verifyEventToken(body)) {
          log.warn('[Feishu] Webhook rejected: invalid verification token');
          return { kind: 'error', status: 403, message: 'Invalid verification token' };
        }

        // AC-14: Check for card action callback
        const cardAction = feishu.parseCardAction(body);
        if (cardAction) {
          // Route card action value as text through ConnectorRouter
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

        // Parse event
        const parsed = feishu.parseEvent(body);
        if (!parsed) {
          log.warn(
            { eventType: eventHeader?.event_type, msgType: msgType?.message_type },
            '[Feishu] Event skipped: parseEvent returned null (unsupported_event)',
          );
          return { kind: 'skipped', reason: 'unsupported_event' };
        }

        const attachments = parsed.attachments?.map((a) => ({
          type: a.type,
          platformKey: a.feishuKey,
          messageId: parsed.messageId,
          ...(a.fileName ? { fileName: a.fileName } : {}),
          ...(a.duration != null ? { duration: a.duration } : {}),
        }));

        // F134: Enrich sender and chat info for group chats
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
        // F134 P1 fix: Only attach sender for group chats — DM replies must NOT @sender (AC-C2)
        const sender =
          parsed.chatType === 'group' && parsed.senderId !== 'unknown'
            ? { id: parsed.senderId, ...(senderName ? { name: senderName } : {}) }
            : undefined;

        const result = await connectorRouter.route(
          'feishu',
          parsed.chatId,
          parsed.text,
          parsed.messageId,
          attachments,
          sender,
          parsed.chatType,
          chatName,
        );

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

  // ── DingTalk (Stream mode) ──
  if (hasDingTalk) {
    const dingtalk = new DingTalkAdapter(log, {
      appKey: config.dingtalkAppKey!,
      appSecret: config.dingtalkAppSecret!,
    });
    adapters.set('dingtalk', dingtalk);

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
      await connectorRouter.route('dingtalk', msg.chatId, msg.text, msg.messageId, attachments);
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
      await connectorRouter.route('weixin', msg.chatId, msg.text, msg.messageId);
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
    startWeixinPolling,
    async stop() {
      cleanupJob.stop();
      await Promise.allSettled(stopFns.map((fn) => fn()));
      log.info('[ConnectorGateway] Stopped');
    },
  };
}
