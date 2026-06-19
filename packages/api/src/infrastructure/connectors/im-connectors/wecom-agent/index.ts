/**
 * WeCom Agent IM Connector Plugin — F240
 *
 * Wraps WeComAgentAdapter into the IMConnectorPlugin interface.
 * Uses HTTP callback (webhook) for inbound messages with XML encryption.
 */

import type { ConnectorDefinition } from '@cat-cafe/shared';
import type { WebhookHandleResult } from '../../../../routes/connector-webhooks.js';
import type { IMConnectorPlugin, MediaDownloadFn } from '../../im-connector-plugin.js';
import type { IOutboundAdapter } from '../../OutboundDeliveryHook.js';
import { WeComAgentAdapter } from './WeComAgentAdapter.js';

const definition: ConnectorDefinition = {
  id: 'wecom-agent',
  displayName: '企微自建应用',
  icon: { type: 'png', src: '/images/connectors/wecom-agent.png' },
  themeColor: '#7C3AED',
  description: '企业微信自建应用 (HTTP 回调)',
};

interface WeComAgentPluginState {
  wecomAgentAdapter: WeComAgentAdapter;
}
const adapterState = new WeakMap<IOutboundAdapter, WeComAgentPluginState>();

function getState(adapter: IOutboundAdapter): WeComAgentPluginState {
  const state = adapterState.get(adapter);
  if (!state) throw new Error('[wecom-agent-plugin] Adapter not created by this plugin');
  return state;
}

const wecomAgentPlugin: IMConnectorPlugin = {
  id: 'wecom-agent',
  definition,

  requiredEnvKeys: ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_AGENT_SECRET', 'WECOM_TOKEN', 'WECOM_ENCODING_AES_KEY'],
  optionalEnvKeys: [],

  isConfigured(env) {
    return Boolean(
      env.WECOM_CORP_ID &&
        env.WECOM_AGENT_ID &&
        env.WECOM_AGENT_SECRET &&
        env.WECOM_TOKEN &&
        env.WECOM_ENCODING_AES_KEY,
    );
  },

  createAdapter(ctx) {
    const adapter = new WeComAgentAdapter(ctx.log, {
      corpId: ctx.env.WECOM_CORP_ID!,
      agentId: ctx.env.WECOM_AGENT_ID!,
      agentSecret: ctx.env.WECOM_AGENT_SECRET!,
      token: ctx.env.WECOM_TOKEN!,
      encodingAesKey: ctx.env.WECOM_ENCODING_AES_KEY!,
    });
    adapterState.set(adapter, { wecomAgentAdapter: adapter });
    return adapter;
  },

  createWebhookHandler(adapter, onMessage, ctx) {
    const { wecomAgentAdapter } = getState(adapter);
    return {
      connectorId: 'wecom-agent',
      async handleWebhook(body, _headers, _rawBody, query): Promise<WebhookHandleResult> {
        const q = (query ?? {}) as Record<string, string>;
        const msgSig = q.msg_signature ?? '';
        const timestamp = q.timestamp ?? '';
        const nonce = q.nonce ?? '';
        const echostr = q.echostr;

        // GET echostr challenge (URL verification)
        if (echostr) {
          const plainEcho = wecomAgentAdapter.verifyCallback({
            msg_signature: msgSig,
            timestamp,
            nonce,
            echostr,
          });
          if (plainEcho !== null) {
            return { kind: 'challenge', response: plainEcho };
          }
          return { kind: 'error', status: 403, message: 'echostr verification failed' };
        }

        // POST encrypted message
        const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
        const decryptedXml = wecomAgentAdapter.decryptInbound(rawBody, {
          msg_signature: msgSig,
          timestamp,
          nonce,
        });
        if (!decryptedXml) {
          return { kind: 'error', status: 403, message: 'Signature verification or decryption failed' };
        }

        const parsed = wecomAgentAdapter.parseEvent(decryptedXml);
        if (!parsed) {
          return { kind: 'skipped', reason: 'unsupported_event' };
        }

        const attachments = parsed.attachments?.map((a) => ({
          type: (a.type === 'video' ? 'file' : a.type === 'audio' ? 'audio' : a.type) as 'image' | 'file' | 'audio',
          platformKey: a.mediaId,
          ...(a.fileName ? { fileName: a.fileName } : {}),
        }));

        await onMessage({
          chatId: parsed.chatId,
          text: parsed.text,
          messageId: parsed.messageId,
          attachments,
        });

        return { kind: 'processed', messageId: parsed.messageId };
      },
    };
  },

  createMediaDownloader(adapter, _ctx): MediaDownloadFn {
    // Reuse live adapter — WeComAgentAdapter.downloadMedia() uses
    // access token that auto-refreshes, reusing avoids extra token requests.
    const { wecomAgentAdapter } = getState(adapter);

    return async (mediaId: string): Promise<Buffer> => {
      return wecomAgentAdapter.downloadMedia(mediaId);
    };
  },
};

export default wecomAgentPlugin;
