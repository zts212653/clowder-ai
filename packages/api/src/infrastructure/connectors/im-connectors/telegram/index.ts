/**
 * Telegram IM Connector Plugin — F240
 *
 * Wraps TelegramAdapter into the IMConnectorPlugin interface.
 * Uses long polling for inbound messages.
 */

import type { ConnectorDefinition } from '@cat-cafe/shared';
import type { IMConnectorPlugin } from '../../im-connector-plugin.js';
import type { IOutboundAdapter } from '../../OutboundDeliveryHook.js';
import { normalizeTelegramBotToken } from '../../telegram-token.js';
import { TelegramAdapter } from './TelegramAdapter.js';

const definition: ConnectorDefinition = {
  id: 'telegram',
  displayName: 'Telegram',
  icon: { type: 'png', src: '/images/connectors/telegram.png' },
  themeColor: '#0088CC',
  description: 'Telegram Bot',
};

interface TelegramPluginState {
  telegramAdapter: TelegramAdapter;
}
const adapterState = new WeakMap<IOutboundAdapter, TelegramPluginState>();

function getState(adapter: IOutboundAdapter): TelegramPluginState {
  const state = adapterState.get(adapter);
  if (!state) throw new Error('[telegram-plugin] Adapter not created by this plugin');
  return state;
}

const telegramPlugin: IMConnectorPlugin = {
  id: 'telegram',
  definition,

  requiredEnvKeys: ['TELEGRAM_BOT_TOKEN'],
  optionalEnvKeys: [],

  isConfigured(env) {
    return normalizeTelegramBotToken(env.TELEGRAM_BOT_TOKEN) !== null;
  },

  createAdapter(ctx) {
    const token = normalizeTelegramBotToken(ctx.env.TELEGRAM_BOT_TOKEN)!;
    const adapter = new TelegramAdapter(token, ctx.log);
    adapterState.set(adapter, { telegramAdapter: adapter });
    return adapter;
  },

  async startInbound(adapter, onMessage, ctx) {
    const { telegramAdapter } = getState(adapter);

    telegramAdapter.startPolling(async (msg) => {
      const attachments = msg.attachments?.map((a) => ({
        type: a.type,
        platformKey: a.telegramFileId,
        ...(a.fileName ? { fileName: a.fileName } : {}),
        ...(a.duration != null ? { duration: a.duration } : {}),
      }));

      await onMessage({
        chatId: msg.chatId,
        text: msg.text,
        messageId: msg.messageId,
        attachments,
      });
    });

    ctx.log.info('[Telegram] Long polling started');
    return {
      stop: async () => telegramAdapter.stopPolling(),
    };
  },
};

export default telegramPlugin;
