/**
 * WeCom Bot IM Connector Plugin — F240
 *
 * Wraps WeComBotAdapter into the IMConnectorPlugin interface.
 * Uses WebSocket mode via @wecom/aibot-node-sdk for inbound messages.
 */

import type { ConnectorDefinition } from '@cat-cafe/shared';
import type {
  HandleActionContext,
  HandleActionResult,
  IMConnectorPlugin,
  MediaDownloadFn,
} from '../../im-connector-plugin.js';
import type { IOutboundAdapter } from '../../OutboundDeliveryHook.js';
import { WeComBotAdapter } from './WeComBotAdapter.js';

const definition: ConnectorDefinition = {
  id: 'wecom-bot',
  displayName: '企业微信',
  icon: { type: 'png', src: '/images/connectors/wecom-bot.png' },
  themeColor: '#4F46E5',
  description: '企业微信智能机器人 (WebSocket)',
};

interface WeComBotPluginState {
  wecomBotAdapter: WeComBotAdapter;
}
const adapterState = new WeakMap<IOutboundAdapter, WeComBotPluginState>();

function getState(adapter: IOutboundAdapter): WeComBotPluginState {
  const state = adapterState.get(adapter);
  if (!state) throw new Error('[wecom-bot-plugin] Adapter not created by this plugin');
  return state;
}

const wecomBotPlugin: IMConnectorPlugin = {
  id: 'wecom-bot',
  definition,

  requiredEnvKeys: ['WECOM_BOT_ID', 'WECOM_BOT_SECRET'],
  optionalEnvKeys: [],

  isConfigured(env) {
    return Boolean(env.WECOM_BOT_ID && env.WECOM_BOT_SECRET);
  },

  createAdapter(ctx) {
    const adapter = new WeComBotAdapter(ctx.log, {
      botId: ctx.env.WECOM_BOT_ID!,
      secret: ctx.env.WECOM_BOT_SECRET!,
      redis: ctx.redis,
    });
    adapterState.set(adapter, { wecomBotAdapter: adapter });
    return adapter;
  },

  async setup(adapter, ctx) {
    const { wecomBotAdapter } = getState(adapter);
    await wecomBotAdapter.hydrateGroupChatIds();
    ctx.log.info('[WeComBot] Group chat IDs hydrated');
  },

  async startInbound(adapter, onMessage, ctx) {
    const { wecomBotAdapter } = getState(adapter);

    await wecomBotAdapter.startStream(async (msg) => {
      const attachments = msg.attachments
        ?.filter((a) => a.url)
        .map((a) => ({
          type: (a.type === 'voice' ? 'audio' : a.type) as 'image' | 'file' | 'audio',
          platformKey: `${a.url}${a.aesKey ? `|aeskey=${a.aesKey}` : ''}`,
          ...(a.fileName ? { fileName: a.fileName } : {}),
        }));

      if (msg.chatType === 'group') {
        wecomBotAdapter.registerGroupChatId(msg.chatId);
      }

      await onMessage({
        chatId: msg.chatId,
        text: msg.text,
        messageId: msg.messageId,
        attachments,
        sender: msg.chatType === 'group' && msg.senderId !== 'unknown' ? { id: msg.senderId } : undefined,
        chatType: msg.chatType,
      });
    });

    ctx.log.info('[WeComBot] WebSocket stream started');
    return {
      stop: async () => wecomBotAdapter.stopStream(),
    };
  },

  async handleAction(_operationName: string, actionId: string, ctx: HandleActionContext): Promise<HandleActionResult> {
    const { log } = ctx;

    switch (actionId) {
      case 'validate': {
        const botId = ctx.env.WECOM_BOT_ID;
        const secret = ctx.env.WECOM_BOT_SECRET;
        if (!botId || !secret) {
          throw new Error('请先保存 Bot ID 和 Bot Secret');
        }
        const result = await WeComBotAdapter.validateCredentials(botId, secret);
        if (!result.valid) {
          throw new Error(result.error ?? '凭据验证失败');
        }
        log.info('[WeComBot handleAction] Credentials validated — activating');
        return {
          render: 'status',
          data: { status: 'connected' },
          label: '已连接',
          targetValues: { WECOM_BOT_ID: botId, WECOM_BOT_SECRET: secret },
          activate: true,
        };
      }

      case 'disconnect': {
        log.info('[WeComBot handleAction] Disconnected by user');
        return {
          render: 'status',
          data: { status: 'disconnected' },
          label: '已断开',
          targetValues: { WECOM_BOT_ID: '', WECOM_BOT_SECRET: '' },
          activate: false,
        };
      }

      default:
        throw new Error(`Unknown wecom-bot action: ${actionId}`);
    }
  },

  createMediaDownloader(adapter, _ctx): MediaDownloadFn {
    // Must use the live adapter — WeComBotAdapter.downloadMedia() depends on
    // the connected wsClient; a freshly constructed instance would throw.
    const { wecomBotAdapter } = getState(adapter);

    return async (platformKey: string): Promise<Buffer> => {
      // platformKey format: "url|aeskey=xxx" or just "url"
      const pipeIdx = platformKey.indexOf('|aeskey=');
      const url = pipeIdx >= 0 ? platformKey.slice(0, pipeIdx) : platformKey;
      const aesKey = pipeIdx >= 0 ? platformKey.slice(pipeIdx + '|aeskey='.length) : undefined;
      const { buffer } = await wecomBotAdapter.downloadMedia(url, aesKey);
      return buffer;
    };
  },
};

export default wecomBotPlugin;
