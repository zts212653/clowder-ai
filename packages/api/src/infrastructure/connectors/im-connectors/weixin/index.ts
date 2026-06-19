/**
 * Weixin (WeChat Personal) IM Connector Plugin — F240
 *
 * Wraps WeixinAdapter into the IMConnectorPlugin interface.
 * Uses iLink Bot long polling for inbound messages.
 * Special lifecycle: QR login flow + session state persistence.
 */

import type { ConnectorDefinition } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyBaseLogger } from 'fastify';
import type {
  HandleActionContext,
  HandleActionResult,
  IMConnectorPlugin,
  MediaDownloadFn,
} from '../../im-connector-plugin.js';
import type { IOutboundAdapter } from '../../OutboundDeliveryHook.js';
import { WeixinAdapter, type WeixinSessionStateStore } from './WeixinAdapter.js';

const definition: ConnectorDefinition = {
  id: 'weixin',
  displayName: '微信',
  icon: { type: 'png', src: '/images/connectors/weixin.png' },
  themeColor: '#07C160',
  description: '微信个人号 iLink Bot',
};

const WEIXIN_SESSION_STATE_KEY = 'connectors:weixin:session-state';

function createSessionStateStore(redis: RedisClient, log: FastifyBaseLogger): WeixinSessionStateStore {
  return {
    async load() {
      const raw = await redis.get(WEIXIN_SESSION_STATE_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { getUpdatesBuf?: unknown; contextTokens?: unknown };
        const contextTokens =
          parsed.contextTokens && typeof parsed.contextTokens === 'object'
            ? Object.fromEntries(
                Object.entries(parsed.contextTokens).filter(
                  ([chatId, token]) => typeof chatId === 'string' && typeof token === 'string',
                ),
              )
            : {};
        return {
          getUpdatesBuf: typeof parsed.getUpdatesBuf === 'string' ? parsed.getUpdatesBuf : '',
          contextTokens,
        };
      } catch (err) {
        log.warn({ err }, '[Weixin] Invalid persisted session state ignored');
        return null;
      }
    },
    async save(state) {
      await redis.set(WEIXIN_SESSION_STATE_KEY, JSON.stringify(state));
    },
    async clear() {
      await redis.del(WEIXIN_SESSION_STATE_KEY);
    },
  };
}

interface WeixinPluginState {
  weixinAdapter: WeixinAdapter;
}
const adapterState = new WeakMap<IOutboundAdapter, WeixinPluginState>();

function getState(adapter: IOutboundAdapter): WeixinPluginState {
  const state = adapterState.get(adapter);
  if (!state) throw new Error('[weixin-plugin] Adapter not created by this plugin');
  return state;
}

const weixinPlugin: IMConnectorPlugin = {
  id: 'weixin',
  definition,

  requiredEnvKeys: ['WEIXIN_BOT_TOKEN'],
  optionalEnvKeys: [],

  isConfigured(env) {
    return Boolean(env.WEIXIN_BOT_TOKEN);
  },

  createAdapter(ctx) {
    const sessionStateStore = ctx.redis ? createSessionStateStore(ctx.redis, ctx.log) : undefined;
    const adapter = new WeixinAdapter(ctx.env.WEIXIN_BOT_TOKEN ?? '', ctx.log, sessionStateStore);
    adapterState.set(adapter, { weixinAdapter: adapter });
    return adapter;
  },

  async setup(adapter, ctx) {
    const { weixinAdapter } = getState(adapter);
    await weixinAdapter.restoreSessionState();

    weixinAdapter.setOnSessionExpired(() => {
      ctx.log.warn('[Weixin] Session expired — user must re-scan QR code');
    });

    ctx.log.info('[Weixin] Session state restored');
  },

  async startInbound(adapter, onMessage, ctx) {
    const { weixinAdapter } = getState(adapter);

    weixinAdapter.startPolling(async (msg) => {
      const attachments = msg.attachments?.map((a) => ({
        type: a.type,
        platformKey: a.mediaUrl,
        ...(a.fileName ? { fileName: a.fileName } : {}),
      }));
      await onMessage({
        chatId: msg.chatId,
        text: msg.text,
        messageId: msg.messageId,
        attachments,
      });
    });

    ctx.log.info('[Weixin] iLink Bot long polling started');
    return {
      stop: async () => weixinAdapter.stopPolling(),
    };
  },

  createMediaDownloader(_adapter, ctx): MediaDownloadFn {
    return async (platformKey: string): Promise<Buffer> => {
      const { downloadMediaFromCdn } = await import('./weixin-cdn.js');
      return downloadMediaFromCdn({
        platformKey,
        cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
        log: ctx.log,
      });
    };
  },

  async handleAction(_operationName: string, actionId: string, ctx: HandleActionContext): Promise<HandleActionResult> {
    const { log } = ctx;

    switch (actionId) {
      case 'qr-generate': {
        // Static method — no adapter needed
        const result = await WeixinAdapter.fetchQrCode();
        const QRCode = await import('qrcode');
        const qrDataUri = await QRCode.toDataURL(result.qrUrl, { width: 384, margin: 2 });
        return {
          render: 'img',
          data: { url: qrDataUri, qrPayload: result.qrPayload },
        };
      }

      case 'qr-status': {
        const qrPayload = (ctx.operationState?.lastResult?.data as { qrPayload?: string })?.qrPayload;
        if (!qrPayload) {
          return {
            render: 'status',
            data: { status: 'error', message: 'No QR payload — generate first' },
            advance: false,
          };
        }
        // Static method — no adapter needed for poll
        const status = await WeixinAdapter.pollQrCodeStatus(qrPayload);
        if (status.status === 'confirmed' && status.botToken) {
          // setBotToken needs adapter — guard (Weixin always has adapter from bootstrap)
          if (ctx.adapter) {
            const { weixinAdapter } = getState(ctx.adapter);
            weixinAdapter.setBotToken(status.botToken);
          }
          log.info('[Weixin handleAction] QR confirmed — bot_token acquired');
          return {
            render: 'status',
            data: { status: 'confirmed' },
            label: '已连接',
            targetValues: { WEIXIN_BOT_TOKEN: status.botToken },
          };
        }
        // Carry qrPayload through polling iterations — without it, the next poll
        // reads persisted lastResult and finds qrPayload wiped (was the QR flash bug).
        return { render: 'polling', data: { status: status.status, qrPayload }, advance: false };
      }

      case 'disconnect': {
        if (ctx.adapter) {
          const { weixinAdapter } = getState(ctx.adapter);
          await weixinAdapter.disconnect();
        }
        log.info('[Weixin handleAction] Disconnected by user');
        return {
          render: 'status',
          data: { status: 'disconnected' },
          label: '已断开',
          targetValues: { WEIXIN_BOT_TOKEN: '' },
          activate: false,
        };
      }

      default:
        throw new Error(`Unknown weixin action: ${actionId}`);
    }
  },
};

export default weixinPlugin;
