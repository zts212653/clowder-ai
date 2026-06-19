/**
 * Feishu IM Connector Plugin — F240 reference implementation
 *
 * Wraps the existing FeishuAdapter + FeishuTokenManager into the
 * IMConnectorPlugin interface. This is the most complex connector
 * (OAuth token refresh, WebSocket/webhook dual mode, media with
 * ffmpeg transcoding, interactive cards) — if the interface can
 * express Feishu cleanly, it can express anything.
 */

import type { ConnectorDefinition } from '@cat-cafe/shared';
import * as lark from '@larksuiteoapi/node-sdk';
import type { WebhookHandleResult } from '../../../../routes/connector-webhooks.js';
import type {
  HandleActionContext,
  HandleActionResult,
  IMConnectorPlugin,
  InboundMessageCallback,
  MediaDownloadFn,
} from '../../im-connector-plugin.js';
import type { IOutboundAdapter } from '../../OutboundDeliveryHook.js';
import { FeishuAdapter } from './FeishuAdapter.js';
import { FeishuTokenManager } from './FeishuTokenManager.js';
import { handleFeishuAction } from './feishu-action-handler.js';

const FEISHU_OPEN_API_BASE = 'https://open.feishu.cn/open-apis';

const definition: ConnectorDefinition = {
  id: 'feishu',
  displayName: '飞书',
  icon: { type: 'png', src: '/images/connectors/feishu.png' },
  themeColor: '#3370FF',
  description: '飞书机器人',
};

/**
 * State shared between createAdapter / setup / startInbound / createWebhookHandler.
 * We use a WeakMap keyed by adapter instance to avoid global mutable state.
 */
interface FeishuPluginState {
  tokenManager: FeishuTokenManager;
  feishuAdapter: FeishuAdapter;
}
const adapterState = new WeakMap<IOutboundAdapter, FeishuPluginState>();

function getState(adapter: IOutboundAdapter): FeishuPluginState {
  const state = adapterState.get(adapter);
  if (!state) throw new Error('[feishu-plugin] Adapter not created by this plugin');
  return state;
}

/** Helper: route a parsed Feishu event through the inbound callback. */
async function routeParsedEvent(
  feishu: FeishuAdapter,
  parsed: NonNullable<ReturnType<FeishuAdapter['parseEvent']>>,
  onMessage: InboundMessageCallback,
): Promise<void> {
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

  await onMessage({
    chatId: parsed.chatId,
    text: parsed.text,
    messageId: parsed.messageId,
    attachments: parsed.attachments?.map((a) => ({
      type: a.type,
      platformKey: a.feishuKey,
      messageId: parsed.messageId,
      ...(a.fileName ? { fileName: a.fileName } : {}),
      ...(a.duration != null ? { duration: a.duration } : {}),
    })),
    sender,
    chatType: parsed.chatType,
    chatName,
  });
}

/** Helper: route a parsed Feishu card action. Returns true if routed, false if rejected (fail-closed). */
async function routeCardAction(
  feishu: FeishuAdapter,
  cardAction: NonNullable<ReturnType<FeishuAdapter['parseCardAction']>>,
  onMessage: InboundMessageCallback,
): Promise<boolean> {
  const actionValue = cardAction.actionValue as { cmd?: string; args?: string };
  const cmdFromBtn =
    typeof actionValue.cmd === 'string' && actionValue.cmd.startsWith('/')
      ? actionValue.args
        ? `${actionValue.cmd} ${actionValue.args}`
        : actionValue.cmd
      : null;
  const cmdFromSelect = !cmdFromBtn && cardAction.option?.startsWith('/') ? cardAction.option : null;
  const cmdText = cmdFromBtn ?? cmdFromSelect;
  const chatType = cardAction.chatType ?? (await feishu.resolveChatType(cardAction.chatId));
  if (!chatType) return false; // fail-closed: chatType unknown
  const text = cmdText ?? JSON.stringify(cardAction.actionValue);
  const sender = cmdText && cardAction.senderId ? { id: cardAction.senderId } : undefined;

  await onMessage({
    chatId: cardAction.chatId,
    text,
    messageId: `card-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sender,
    chatType,
  });
  return true;
}

const feishuPlugin: IMConnectorPlugin = {
  id: 'feishu',
  definition,

  requiredEnvKeys: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
  optionalEnvKeys: [
    'FEISHU_VERIFICATION_TOKEN',
    'FEISHU_CONNECTION_MODE',
    'FEISHU_BOT_OPEN_ID',
    'FEISHU_ADMIN_OPEN_IDS',
  ],

  isConfigured(env) {
    const wsMode = env.FEISHU_CONNECTION_MODE === 'websocket';
    return Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && (wsMode || env.FEISHU_VERIFICATION_TOKEN));
  },

  createAdapter(ctx) {
    const { env, log } = ctx;
    const adapter = new FeishuAdapter(env.FEISHU_APP_ID!, env.FEISHU_APP_SECRET!, log, {
      verificationToken: env.FEISHU_VERIFICATION_TOKEN,
    });
    // Support test injection via _testOverrides (bootstrap passes _feishuTokenManagerOverride)
    const tokenManager =
      (ctx._testOverrides?.feishuTokenManager as FeishuTokenManager | undefined) ??
      new FeishuTokenManager({
        appId: env.FEISHU_APP_ID!,
        appSecret: env.FEISHU_APP_SECRET!,
      });
    adapter._injectTokenManager(tokenManager);

    adapterState.set(adapter, { tokenManager, feishuAdapter: adapter });
    return adapter;
  },

  async setup(adapter, ctx) {
    const { feishuAdapter, tokenManager } = getState(adapter);
    const { env, log } = ctx;

    // Resolve bot open_id for @bot detection in group chats
    const envBotOpenId = env.FEISHU_BOT_OPEN_ID;
    if (envBotOpenId) {
      feishuAdapter.setBotOpenId(envBotOpenId);
      log.info({ botOpenId: envBotOpenId }, '[Feishu] Bot open_id set from config');
    } else {
      tokenManager
        .getTenantAccessToken()
        .then(async (token) => {
          try {
            const res = await fetch(`${FEISHU_OPEN_API_BASE}/bot/v3/info`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
              const data = (await res.json()) as { bot?: { open_id?: string } };
              const openId = data?.bot?.open_id;
              if (openId) {
                feishuAdapter.setBotOpenId(openId);
                log.info({ botOpenId: openId }, '[Feishu] Bot open_id resolved via API');
              }
            }
          } catch (err) {
            log.warn({ err }, '[Feishu] Failed to resolve bot open_id — group @bot detection disabled');
          }
        })
        .catch(() => {});
    }
  },

  createWebhookHandler(adapter, onMessage, ctx) {
    // In websocket mode, inbound comes via WSClient — no webhook needed
    if (ctx.env.FEISHU_CONNECTION_MODE === 'websocket') return undefined;

    const { feishuAdapter } = getState(adapter);
    const { log } = ctx;

    return {
      connectorId: 'feishu',
      async handleWebhook(body, _headers): Promise<WebhookHandleResult> {
        const eventHeader = (body as Record<string, unknown>)?.header as Record<string, unknown> | undefined;
        const msgMeta = ((body as Record<string, unknown>)?.event as Record<string, unknown> | undefined)?.message as
          | Record<string, unknown>
          | undefined;
        log.info(
          { eventType: eventHeader?.event_type, msgType: msgMeta?.message_type, chatType: msgMeta?.chat_type },
          '[Feishu] Webhook received',
        );

        // URL verification challenge
        const challenge = feishuAdapter.isVerificationChallenge(body);
        if (challenge) {
          return { kind: 'challenge', response: { challenge: challenge.challenge } };
        }

        // Token verification
        if (!feishuAdapter.verifyEventToken(body)) {
          log.warn('[Feishu] Webhook rejected: invalid verification token');
          return { kind: 'error', status: 403, message: 'Invalid verification token' };
        }

        // Card action
        const cardAction = feishuAdapter.parseCardAction(body);
        if (cardAction) {
          const routed = await routeCardAction(feishuAdapter, cardAction, onMessage);
          if (!routed) {
            log.warn({ chatId: cardAction.chatId }, '[Feishu] Card action rejected: chatType unknown (fail-closed)');
            return { kind: 'skipped', reason: 'chat_type_unknown' };
          }
          return { kind: 'processed', messageId: 'card-action' };
        }

        // Regular message
        const parsed = feishuAdapter.parseEvent(body);
        if (!parsed) {
          log.warn(
            { eventType: eventHeader?.event_type, msgType: msgMeta?.message_type },
            '[Feishu] Event skipped: unsupported_event',
          );
          return { kind: 'skipped', reason: 'unsupported_event' };
        }

        await routeParsedEvent(feishuAdapter, parsed, onMessage);
        return { kind: 'processed', messageId: parsed.messageId };
      },
    };
  },

  async startInbound(adapter, onMessage, ctx) {
    const { feishuAdapter } = getState(adapter);
    const { env, log } = ctx;

    // Only start WebSocket inbound if connection mode is 'websocket'
    if (env.FEISHU_CONNECTION_MODE !== 'websocket') {
      return { stop: async () => {} };
    }

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        log.info(
          {
            msgType: (data.message as Record<string, unknown> | undefined)?.message_type,
            chatType: (data.message as Record<string, unknown> | undefined)?.chat_type,
          },
          '[Feishu] WS event received',
        );
        const envelope = { header: { event_type: 'im.message.receive_v1' }, event: data };
        const parsed = feishuAdapter.parseEvent(envelope);
        if (!parsed) return;
        await routeParsedEvent(feishuAdapter, parsed, onMessage);
      },
      'card.action.trigger': async (data: Record<string, unknown>) => {
        log.info('[Feishu] WS card.action.trigger received');
        const envelope = { header: { event_type: 'card.action.trigger' }, event: data };
        const cardAction = feishuAdapter.parseCardAction(envelope);
        if (!cardAction) return;
        await routeCardAction(feishuAdapter, cardAction, onMessage);
      },
    });

    // Support test injection via _testOverrides (bootstrap passes _wsClientFactory)
    const wsClientFactory = ctx._testOverrides?.wsClientFactory as
      | ((opts: { appId: string; appSecret: string }) => {
          start(opts: unknown): Promise<void>;
          close(opts?: unknown): void;
        })
      | undefined;
    const wsClient = wsClientFactory
      ? wsClientFactory({ appId: env.FEISHU_APP_ID!, appSecret: env.FEISHU_APP_SECRET! })
      : new lark.WSClient({
          appId: env.FEISHU_APP_ID!,
          appSecret: env.FEISHU_APP_SECRET!,
          loggerLevel: lark.LoggerLevel.info,
        });

    try {
      await wsClient.start({ eventDispatcher });
      log.info('[Feishu] WebSocket long-connection started');
    } catch (err) {
      log.warn({ err }, '[Feishu] WSClient initial connection failed — will auto-reconnect');
    }

    return {
      stop: async () => {
        try {
          wsClient.close({ force: true });
        } catch {
          // WSClient may already be torn down
        }
      },
    };
  },

  createMediaDownloader(adapter, _ctx): MediaDownloadFn {
    // Reuse the tokenManager from createAdapter() — avoids duplicate instances
    // and respects test injection via _testOverrides.
    const { tokenManager } = getState(adapter);

    return async (fileKey: string, type: string, messageId?: string): Promise<Buffer> => {
      const token = await tokenManager.getTenantAccessToken();
      if (!messageId) throw new Error('Feishu download requires messageId');
      const resourceType = type === 'image' ? 'image' : 'file';
      const url = `${FEISHU_OPEN_API_BASE}/im/v1/messages/${messageId}/resources/${fileKey}?type=${resourceType}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        throw new Error(`Feishu resource download failed: ${res.status} ${res.statusText}`);
      }
      return Buffer.from(await res.arrayBuffer());
    };
  },

  async handleAction(_operationName: string, actionId: string, ctx: HandleActionContext): Promise<HandleActionResult> {
    return handleFeishuAction(actionId, ctx);
  },
};

export default feishuPlugin;
