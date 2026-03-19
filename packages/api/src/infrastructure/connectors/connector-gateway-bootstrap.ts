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

import { join, resolve } from 'node:path';
import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorWebhookHandler, WebhookHandleResult } from '../../routes/connector-webhooks.js';
import { FeishuAdapter } from './adapters/FeishuAdapter.js';
import { FeishuTokenManager } from './adapters/FeishuTokenManager.js';
import { TelegramAdapter } from './adapters/TelegramAdapter.js';
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
  /** Override owner userId for connector threads. Read from DEFAULT_OWNER_USER_ID env. */
  ownerUserId?: string | undefined;
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
  };
  readonly threadStore: {
    create(userId: string, title?: string): { id: string } | Promise<{ id: string }>;
    get(
      id: string,
    ):
      | { id: string; title?: string | null; createdAt?: number }
      | null
      | Promise<{ id: string; title?: string | null; createdAt?: number } | null>;
    list(
      userId: string,
    ):
      | Array<{ id: string; title?: string | null; lastActiveAt?: number; backlogItemId?: string }>
      | Promise<Array<{ id: string; title?: string | null; lastActiveAt?: number; backlogItemId?: string }>>;
    updateConnectorHubState(
      threadId: string,
      state: { v: 1; connectorId: string; externalChatId: string; createdAt: number } | null,
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
    trigger(threadId: string, catId: CatId, userId: string, message: string, messageId: string): void;
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
  stop(): Promise<void>;
}

export function loadConnectorGatewayConfig(): ConnectorGatewayConfig {
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    feishuAppId: process.env.FEISHU_APP_ID,
    feishuAppSecret: process.env.FEISHU_APP_SECRET,
    feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    ownerUserId: process.env.DEFAULT_OWNER_USER_ID,
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

  if (!hasTelegram && !hasFeishu) {
    log.info(
      '[ConnectorGateway] No connectors configured (set TELEGRAM_BOT_TOKEN or FEISHU_APP_ID + FEISHU_APP_SECRET + FEISHU_VERIFICATION_TOKEN)',
    );
    return null;
  }

  const bindingStore = deps.redis
    ? new RedisConnectorThreadBindingStore(deps.redis)
    : new MemoryConnectorThreadBindingStore();
  const dedup = new InboundMessageDedup();
  log.info({ store: deps.redis ? 'redis' : 'memory' }, '[ConnectorGateway] Binding store initialized');
  const adapters = new Map<string, IOutboundAdapter>();
  const webhookHandlers = new Map<string, ConnectorWebhookHandler>();
  const stopFns: Array<() => Promise<void>> = [];

  // Use ownerUserId from config (DEFAULT_OWNER_USER_ID env) if set,
  // otherwise fall back to deps.defaultUserId.
  // This ensures connector threads are created with the real owner's userId,
  // making them visible in the frontend thread list. (F088 ISSUE-1 fix)
  const effectiveUserId = config.ownerUserId || deps.defaultUserId;

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
    // Platform download functions will be wired after adapters are created
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

    // Register webhook handler for the route
    webhookHandlers.set('feishu', {
      connectorId: 'feishu',
      async handleWebhook(body, _headers): Promise<WebhookHandleResult> {
        // Handle verification challenge (no token check — challenge is pre-auth)
        const challenge = feishu.isVerificationChallenge(body);
        if (challenge) {
          return { kind: 'challenge', response: { challenge: challenge.challenge } };
        }

        // Verify event token (AC-4: webhook authentication)
        if (!feishu.verifyEventToken(body)) {
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
          return { kind: 'skipped', reason: 'unsupported_event' };
        }

        const attachments = parsed.attachments?.map((a) => ({
          type: a.type,
          platformKey: a.feishuKey,
          ...(a.fileName ? { fileName: a.fileName } : {}),
          ...(a.duration != null ? { duration: a.duration } : {}),
        }));

        const result = await connectorRouter.route('feishu', parsed.chatId, parsed.text, parsed.messageId, attachments);

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

  // R3-P1: Resolve route URLs to local file paths for real media delivery
  const uploadDir = resolve(process.env.UPLOAD_DIR ?? './uploads');
  const ttsCacheDir = resolve(process.env.TTS_CACHE_DIR ?? './data/tts-cache');
  const resolvedMediaDir = resolve(mediaDir);
  const mediaPathResolver = (url: string): string | undefined => {
    if (url.startsWith('/uploads/')) return join(uploadDir, url.slice('/uploads/'.length));
    if (url.startsWith('/api/tts/audio/')) return join(ttsCacheDir, url.slice('/api/tts/audio/'.length));
    if (url.startsWith('/api/connector-media/'))
      return join(resolvedMediaDir, url.slice('/api/connector-media/'.length));
    return undefined;
  };

  const outboundHook = new OutboundDeliveryHook({
    bindingStore,
    adapters,
    log,
    mediaPathResolver,
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
    async stop() {
      cleanupJob.stop();
      await Promise.allSettled(stopFns.map((fn) => fn()));
      log.info('[ConnectorGateway] Stopped');
    },
  };
}
