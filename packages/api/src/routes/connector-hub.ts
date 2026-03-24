import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_THREAD_ID, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { WeixinAdapter } from '../infrastructure/connectors/adapters/WeixinAdapter.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface ConnectorHubRoutesOptions {
  threadStore: IThreadStore;
  /**
   * Lazy reference to the WeChat adapter instance.
   * Set after connector gateway starts (which happens post-listen).
   * Null when gateway not started or WeChat not available.
   */
  weixinAdapter?: WeixinAdapter | null;
  /** Called after successful QR login to start the WeChat polling loop */
  startWeixinPolling?: () => void;
}

function requireTrustedHubIdentity(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveHeaderUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  return userId;
}

// ── Connector platform config definitions ──

interface ConnectorFieldDef {
  envName: string;
  label: string;
  sensitive: boolean;
}

interface PlatformDef {
  id: string;
  name: string;
  nameEn: string;
  fields: ConnectorFieldDef[];
  docsUrl: string;
  /** Steps displayed in the guided wizard */
  steps: string[];
}

export const CONNECTOR_PLATFORMS: PlatformDef[] = [
  {
    id: 'feishu',
    name: '飞书',
    nameEn: 'Feishu / Lark',
    fields: [
      { envName: 'FEISHU_APP_ID', label: 'App ID', sensitive: false },
      { envName: 'FEISHU_APP_SECRET', label: 'App Secret', sensitive: true },
      { envName: 'FEISHU_VERIFICATION_TOKEN', label: 'Verification Token', sensitive: true },
    ],
    docsUrl:
      'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process',
    steps: [
      '在飞书开放平台创建企业自建应用，获取 App ID 和 App Secret',
      '在「事件订阅」中配置请求地址并获取 Verification Token',
      '填写以下配置并保存，重启 API 服务后生效',
    ],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    nameEn: 'Telegram',
    fields: [{ envName: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', sensitive: true }],
    docsUrl: 'https://core.telegram.org/bots/tutorial',
    steps: [
      '在 Telegram 中找到 @BotFather，发送 /newbot 创建机器人',
      '复制生成的 Bot Token',
      '填写以下配置并保存，重启 API 服务后生效',
    ],
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    nameEn: 'DingTalk',
    fields: [
      { envName: 'DINGTALK_APP_KEY', label: 'App Key', sensitive: false },
      { envName: 'DINGTALK_APP_SECRET', label: 'App Secret', sensitive: true },
    ],
    docsUrl: 'https://open.dingtalk.com/document/orgapp/create-an-enterprise-internal-application',
    steps: [
      '在钉钉开放平台创建企业内部应用，获取 App Key 和 App Secret',
      '在「机器人与消息推送」中开启机器人能力',
      '填写以下配置并保存，重启 API 服务后生效',
    ],
  },
  {
    id: 'weixin',
    name: '微信',
    nameEn: 'WeChat Personal',
    fields: [],
    docsUrl: 'https://chatbot.weixin.qq.com/',
    steps: ['点击「生成二维码」按钮', '使用微信扫描二维码并确认授权', '授权成功后自动连接，无需重启服务'],
  },
];

/** Mask a sensitive value: show only that it is set, no suffix. Aligns with env-registry *** policy. */
function maskSensitiveValue(_value: string): string {
  return '••••••••';
}

export interface PlatformFieldStatus {
  envName: string;
  label: string;
  sensitive: boolean;
  /** null = not set, masked string = set (sensitive fields show last 4 chars) */
  currentValue: string | null;
}

export interface PlatformStatus {
  id: string;
  name: string;
  nameEn: string;
  configured: boolean;
  fields: PlatformFieldStatus[];
  docsUrl: string;
  steps: string[];
}

export function buildConnectorStatus(env: Record<string, string | undefined> = process.env): PlatformStatus[] {
  return CONNECTOR_PLATFORMS.map((platform) => {
    const fields: PlatformFieldStatus[] = platform.fields.map((f) => {
      const raw = env[f.envName];
      const isSet = raw != null && raw !== '' && !raw.startsWith('(未设置');
      return {
        envName: f.envName,
        label: f.label,
        sensitive: f.sensitive,
        currentValue: isSet ? (f.sensitive ? maskSensitiveValue(raw) : raw) : null,
      };
    });
    // WeChat uses QR login (no env fields) — default to false; route handler overrides with live adapter state
    const configured = platform.fields.length > 0 ? fields.every((f) => f.currentValue !== null) : false;
    return {
      id: platform.id,
      name: platform.name,
      nameEn: platform.nameEn,
      configured,
      fields,
      docsUrl: platform.docsUrl,
      steps: platform.steps,
    };
  });
}

export const connectorHubRoutes: FastifyPluginAsync<ConnectorHubRoutesOptions> = async (app, opts) => {
  const { threadStore } = opts;

  app.get('/api/connector/hub-threads', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) {
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const allThreads = await threadStore.list(userId);
    const hubThreads = allThreads
      .filter((t) => t.connectorHubState && t.id !== DEFAULT_THREAD_ID)
      .sort((a, b) => (b.connectorHubState?.createdAt ?? 0) - (a.connectorHubState?.createdAt ?? 0));
    return {
      threads: hubThreads.map((t) => ({
        id: t.id,
        title: t.title,
        connectorId: t.connectorHubState?.connectorId,
        externalChatId: t.connectorHubState?.externalChatId,
        createdAt: t.connectorHubState?.createdAt,
        lastCommandAt: t.connectorHubState?.lastCommandAt,
      })),
    };
  });

  app.get('/api/connector/status', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) {
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const status = buildConnectorStatus();
    // F137: WeChat "configured" is based on adapter having a live bot_token, not env vars
    const weixinStatus = status.find((p) => p.id === 'weixin');
    if (weixinStatus) {
      const adapter = opts.weixinAdapter;
      weixinStatus.configured = adapter != null && adapter.hasBotToken() && adapter.isPolling();
    }
    return { platforms: status };
  });

  // ── F137: WeChat QR code login routes ──

  app.post('/api/connector/weixin/qrcode', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };

    try {
      const { WeixinAdapter: WA } = await import('../infrastructure/connectors/adapters/WeixinAdapter.js');
      const result = await WA.fetchQrCode();
      return { qrUrl: result.qrUrl, qrPayload: result.qrPayload };
    } catch (err) {
      app.log.error({ err }, '[WeChat QR] Failed to fetch QR code');
      reply.status(502);
      return { error: 'Failed to fetch QR code from WeChat' };
    }
  });

  app.get('/api/connector/weixin/qrcode-status', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };

    const { qrPayload } = request.query as { qrPayload?: string };
    if (!qrPayload) {
      reply.status(400);
      return { error: 'qrPayload query parameter required' };
    }

    try {
      const { WeixinAdapter: WA } = await import('../infrastructure/connectors/adapters/WeixinAdapter.js');
      const status = await WA.pollQrCodeStatus(qrPayload);

      if (status.status === 'confirmed') {
        const adapter = opts.weixinAdapter;
        if (!adapter) {
          app.log.error('[WeChat QR] QR confirmed but adapter not available — token would be lost');
          reply.status(503);
          return { error: 'WeChat adapter not ready — please retry shortly' };
        }
        adapter.setBotToken(status.botToken);
        opts.startWeixinPolling?.();
        app.log.info('[WeChat QR] Auto-activated — bot_token set server-side, polling started');
        return { status: 'confirmed' };
      }

      return status;
    } catch (err) {
      app.log.error({ err }, '[WeChat QR] Failed to poll QR status');
      reply.status(502);
      return { error: 'Failed to poll QR code status' };
    }
  });

  app.post('/api/connector/weixin/activate', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };

    const adapter = opts.weixinAdapter;
    if (!adapter) {
      reply.status(503);
      return { error: 'WeChat adapter not available (connector gateway not started)' };
    }

    if (!adapter.hasBotToken()) {
      reply.status(409);
      return { error: 'No bot_token available — complete QR code login first' };
    }

    opts.startWeixinPolling?.();
    app.log.info('[WeChat QR] Manual activate — polling started');

    return { ok: true, polling: adapter.isPolling() };
  });
};
