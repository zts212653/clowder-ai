/**
 * XiaoYi IM Connector Plugin — F240
 *
 * Wraps XiaoyiAdapter into the IMConnectorPlugin interface.
 * Uses OpenClaw WebSocket mode for inbound messages.
 */

import type { ConnectorDefinition } from '@cat-cafe/shared';
import type { IMConnectorPlugin } from '../../im-connector-plugin.js';
import type { IOutboundAdapter } from '../../OutboundDeliveryHook.js';

const definition: ConnectorDefinition = {
  id: 'xiaoyi',
  displayName: '小艺 APP',
  icon: { type: 'png', src: '/images/connectors/xiaoyi.png' },
  themeColor: '#CF0A2C',
  description: '华为小艺 OpenClaw 模式',
};

// XiaoyiAdapter is dynamically imported (heavy SDK dependency)
type XiaoyiAdapterType = import('./XiaoyiAdapter.js').XiaoyiAdapter;

interface XiaoyiPluginState {
  xiaoyiAdapter: XiaoyiAdapterType;
}
const adapterState = new WeakMap<IOutboundAdapter, XiaoyiPluginState>();

function getState(adapter: IOutboundAdapter): XiaoyiPluginState {
  const state = adapterState.get(adapter);
  if (!state) throw new Error('[xiaoyi-plugin] Adapter not created by this plugin');
  return state;
}

const xiaoyiPlugin: IMConnectorPlugin = {
  id: 'xiaoyi',
  definition,

  requiredEnvKeys: ['XIAOYI_AK', 'XIAOYI_SK', 'XIAOYI_AGENT_ID'],
  optionalEnvKeys: [],

  isConfigured(env) {
    return Boolean(env.XIAOYI_AK && env.XIAOYI_SK && env.XIAOYI_AGENT_ID);
  },

  async createAdapter(ctx) {
    const { XiaoyiAdapter } = await import('./XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(ctx.log, {
      agentId: ctx.env.XIAOYI_AGENT_ID!,
      ak: ctx.env.XIAOYI_AK!,
      sk: ctx.env.XIAOYI_SK!,
    });
    adapterState.set(adapter, { xiaoyiAdapter: adapter });
    return adapter;
  },

  async startInbound(adapter, onMessage, ctx) {
    const { xiaoyiAdapter } = getState(adapter);

    await xiaoyiAdapter.startStream(async (msg) => {
      await onMessage({
        chatId: msg.chatId,
        text: msg.text,
        messageId: msg.messageId,
        sender: { id: msg.senderId },
      });
    });

    ctx.log.info('[XiaoYi] OpenClaw WebSocket mode started');
    return {
      stop: async () => xiaoyiAdapter.stopStream(),
    };
  },
};

export default xiaoyiPlugin;
