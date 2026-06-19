/**
 * DingTalk IM Connector Plugin — F240
 *
 * Wraps DingTalkAdapter into the IMConnectorPlugin interface.
 * Uses DingTalk Stream mode for inbound messages.
 */

import type { ConnectorDefinition } from '@cat-cafe/shared';
import type { IMConnectorPlugin, MediaDownloadFn } from '../../im-connector-plugin.js';
import type { IOutboundAdapter } from '../../OutboundDeliveryHook.js';
import { DingTalkAdapter } from './DingTalkAdapter.js';

const definition: ConnectorDefinition = {
  id: 'dingtalk',
  displayName: '钉钉',
  icon: { type: 'png', src: '/images/connectors/dingtalk.png' },
  themeColor: '#3296FA',
  description: '钉钉企业内部应用',
};

interface DingTalkPluginState {
  dingtalkAdapter: DingTalkAdapter;
}
const adapterState = new WeakMap<IOutboundAdapter, DingTalkPluginState>();

function getState(adapter: IOutboundAdapter): DingTalkPluginState {
  const state = adapterState.get(adapter);
  if (!state) throw new Error('[dingtalk-plugin] Adapter not created by this plugin');
  return state;
}

const dingtalkPlugin: IMConnectorPlugin = {
  id: 'dingtalk',
  definition,

  requiredEnvKeys: ['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET'],
  optionalEnvKeys: [],

  isConfigured(env) {
    return Boolean(env.DINGTALK_APP_KEY && env.DINGTALK_APP_SECRET);
  },

  createAdapter(ctx) {
    const adapter = new DingTalkAdapter(ctx.log, {
      appKey: ctx.env.DINGTALK_APP_KEY!,
      appSecret: ctx.env.DINGTALK_APP_SECRET!,
      redis: ctx.redis,
    });
    adapterState.set(adapter, { dingtalkAdapter: adapter });
    return adapter;
  },

  async setup(adapter, ctx) {
    const { dingtalkAdapter } = getState(adapter);
    await dingtalkAdapter.hydrateGroupChatIds();
    ctx.log.info('[DingTalk] Group chat IDs hydrated');
  },

  async startInbound(adapter, onMessage, ctx) {
    const { dingtalkAdapter } = getState(adapter);

    await dingtalkAdapter.startStream(async (msg) => {
      const attachments = msg.attachments?.map((a) => ({
        type: a.type,
        platformKey: a.downloadCode ?? '',
        ...(a.fileName ? { fileName: a.fileName } : {}),
        ...(a.duration != null ? { duration: a.duration } : {}),
      }));

      // Register group chatId so outbound dispatch survives cold restarts
      if (msg.chatType === 'group') {
        dingtalkAdapter.registerGroupChatId(msg.chatId);
      }

      // Enrich sender and chat info
      const senderName = msg.senderNick ?? dingtalkAdapter.resolveSenderName(msg.senderId);
      const chatName = msg.conversationTitle ?? dingtalkAdapter.resolveConversationTitle(msg.chatId);
      const sender =
        msg.chatType === 'group' && msg.senderId !== 'unknown'
          ? { id: msg.senderId, ...(senderName ? { name: senderName } : {}) }
          : undefined;

      await onMessage({
        chatId: msg.chatId,
        text: msg.text,
        messageId: msg.messageId,
        attachments,
        sender,
        chatType: msg.chatType,
        chatName,
      });
    });

    ctx.log.info('[DingTalk] Stream mode started');
    return {
      stop: async () => dingtalkAdapter.stopStream(),
    };
  },

  createMediaDownloader(adapter, ctx): MediaDownloadFn {
    // Use the live adapter for download — DingTalkAdapter.downloadMedia()
    // uses getAccessToken() which is stateless (API key auth), but reusing
    // the existing instance is cleaner and avoids duplicate token requests.
    const { dingtalkAdapter } = getState(adapter);

    return async (downloadCode: string): Promise<Buffer> => {
      const downloadUrl = await dingtalkAdapter.downloadMedia(downloadCode);
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`DingTalk media fetch failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    };
  },
};

export default dingtalkPlugin;
