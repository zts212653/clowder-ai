import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { applyConnectorSecretUpdates } from '../config/connector-secret-updater.js';
import { DEFAULT_THREAD_ID, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { WeixinAdapter } from '../infrastructure/connectors/adapters/WeixinAdapter.js';
import type { IConnectorPermissionStore } from '../infrastructure/connectors/ConnectorPermissionStore.js';
import { DefaultFeishuQrBindClient, type FeishuQrBindClient } from '../infrastructure/connectors/FeishuQrBindClient.js';
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
  /** F134 Phase D: Permission store for group whitelist + admin management */
  permissionStore?: IConnectorPermissionStore | null;
  envFilePath?: string;
  feishuQrBindClient?: FeishuQrBindClient;
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
  /** When set, this field is only required if the condition env var has the given value */
  requiredWhen?: { envName: string; value: string };
  /** When true, this field is never required for the platform to be "configured" */
  optional?: boolean;
  /** Default value used when the env var is not set — aligns status page with runtime normalization */
  defaultValue?: string;
}

interface PlatformStepDef {
  text: string;
  /** When set, this step only displays when the selected connection mode matches */
  mode?: string;
}

interface PlatformDef {
  id: string;
  name: string;
  nameEn: string;
  fields: ConnectorFieldDef[];
  docsUrl: string;
  /** Steps displayed in the guided wizard — may be mode-filtered */
  steps: PlatformStepDef[];
}

export const CONNECTOR_PLATFORMS: PlatformDef[] = [
  {
    id: 'feishu',
    name: '飞书',
    nameEn: 'Feishu / Lark',
    fields: [
      { envName: 'FEISHU_APP_ID', label: 'App ID', sensitive: false },
      { envName: 'FEISHU_APP_SECRET', label: 'App Secret', sensitive: true },
      {
        envName: 'FEISHU_CONNECTION_MODE',
        label: '连接模式 (webhook/websocket)',
        sensitive: false,
        optional: true,
        defaultValue: 'webhook',
      },
      {
        envName: 'FEISHU_VERIFICATION_TOKEN',
        label: 'Verification Token',
        sensitive: true,
        requiredWhen: { envName: 'FEISHU_CONNECTION_MODE', value: 'webhook' },
      },
    ],
    docsUrl:
      'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process',
    steps: [
      { text: '在飞书开放平台创建企业自建应用，获取 App ID 和 App Secret' },
      { text: '选择连接模式：Webhook（需公网 URL）或 WebSocket（无需公网，推荐内网环境）' },
      { text: '在「事件订阅」中配置请求地址并获取 Verification Token', mode: 'webhook' },
      { text: '在「事件订阅」中选择「使用长连接接收事件」，无需 Verification Token', mode: 'websocket' },
      { text: '填写以下配置并保存，重启 API 服务后生效' },
    ],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    nameEn: 'Telegram',
    fields: [{ envName: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', sensitive: true }],
    docsUrl: 'https://core.telegram.org/bots/tutorial',
    steps: [
      { text: '在 Telegram 中找到 @BotFather，发送 /newbot 创建机器人' },
      { text: '复制生成的 Bot Token' },
      { text: '填写以下配置并保存，重启 API 服务后生效' },
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
      { text: '在钉钉开放平台创建企业内部应用，获取 App Key 和 App Secret' },
      { text: '在「机器人与消息推送」中开启机器人能力' },
      { text: '填写以下配置并保存，重启 API 服务后生效' },
    ],
  },
  {
    id: 'wecom-bot',
    name: '企业微信',
    nameEn: 'WeCom Bot',
    fields: [
      { envName: 'WECOM_BOT_ID', label: 'Bot ID', sensitive: false },
      { envName: 'WECOM_BOT_SECRET', label: 'Bot Secret', sensitive: true },
    ],
    docsUrl: 'https://developer.work.weixin.qq.com/document/path/105120',
    steps: [
      { text: '在企业微信管理后台创建智能机器人，获取 Bot ID 和 Bot Secret' },
      { text: '启用「长连接」模式（WebSocket），无需公网 URL' },
      { text: '填写以下配置并保存，重启 API 服务后生效' },
    ],
  },
  {
    id: 'wecom-agent',
    name: '企微自建应用',
    nameEn: 'WeCom Agent',
    fields: [
      { envName: 'WECOM_CORP_ID', label: 'Corp ID (企业 ID)', sensitive: false },
      { envName: 'WECOM_AGENT_ID', label: 'Agent ID (应用 ID)', sensitive: false },
      { envName: 'WECOM_AGENT_SECRET', label: 'Agent Secret', sensitive: true },
      { envName: 'WECOM_TOKEN', label: '回调 Token', sensitive: true },
      { envName: 'WECOM_ENCODING_AES_KEY', label: 'EncodingAESKey (43 字符)', sensitive: true },
    ],
    docsUrl: 'https://developer.work.weixin.qq.com/document/path/90238',
    steps: [
      { text: '在企业微信管理后台创建自建应用，获取 AgentId 和 Secret' },
      { text: '在「API 接收消息」中设置回调 URL、Token 和 EncodingAESKey' },
      { text: '回调 URL 需通过公网访问（可使用 Cloudflare Tunnel）' },
      { text: '填写以下配置并保存，重启 API 服务后生效' },
    ],
  },
  {
    id: 'xiaoyi',
    name: '小艺',
    nameEn: 'XiaoYi (Huawei)',
    fields: [
      { envName: 'XIAOYI_AK', label: 'Access Key', sensitive: false },
      { envName: 'XIAOYI_SK', label: 'Secret Key', sensitive: true },
      { envName: 'XIAOYI_AGENT_ID', label: 'Agent ID', sensitive: false },
    ],
    docsUrl: 'https://developer.huawei.com/consumer/cn/service/josp/agc/index.html',
    steps: [
      { text: '在小艺开放平台创建 OpenClaw 模式智能体，获取 AK/SK 和 Agent ID' },
      { text: '填写以下配置并保存，重启 API 服务后自动通过 WebSocket 连接华为 HAG' },
      { text: '在小艺 APP 中发送消息验证对话链路是否正常' },
    ],
  },
  {
    id: 'weixin',
    name: '微信',
    nameEn: 'WeChat Personal',
    fields: [],
    docsUrl: 'https://chatbot.weixin.qq.com/',
    steps: [
      { text: '点击「生成二维码」按钮' },
      { text: '使用微信扫描二维码并确认授权' },
      { text: '授权成功后自动连接，无需重启服务' },
    ],
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

export interface PlatformStepStatus {
  text: string;
  mode?: string;
}

export interface PlatformStatus {
  id: string;
  name: string;
  nameEn: string;
  configured: boolean;
  fields: PlatformFieldStatus[];
  docsUrl: string;
  steps: PlatformStepStatus[];
}

export function buildConnectorStatus(env: Record<string, string | undefined> = process.env): PlatformStatus[] {
  return CONNECTOR_PLATFORMS.map((platform) => {
    const fields: PlatformFieldStatus[] = platform.fields.map((f) => {
      const raw = env[f.envName];
      const isSet = raw != null && raw !== '' && !raw.startsWith('(未设置');
      const effectiveValue = isSet ? raw : (f.defaultValue ?? null);
      return {
        envName: f.envName,
        label: f.label,
        sensitive: f.sensitive,
        currentValue: effectiveValue ? (f.sensitive ? maskSensitiveValue(effectiveValue) : effectiveValue) : null,
      };
    });

    let configured: boolean;
    if (platform.fields.length === 0) {
      configured = false;
    } else {
      configured = platform.fields.every((f) => {
        if (f.optional) return true;
        if (f.requiredWhen) {
          // Normalize to match runtime: only 'websocket' passes through, everything else → 'webhook'
          const rawCondition = env[f.requiredWhen.envName];
          const conditionValue = rawCondition === 'websocket' ? 'websocket' : 'webhook';
          if (conditionValue !== f.requiredWhen.value) return true;
        }
        const raw = env[f.envName];
        return raw != null && raw !== '' && !raw.startsWith('(未设置');
      });
    }

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
  const feishuQrBindClient = opts.feishuQrBindClient ?? new DefaultFeishuQrBindClient();

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

  app.post('/api/connector/feishu/qrcode', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };

    try {
      const result = await feishuQrBindClient.create();
      return result;
    } catch (err) {
      app.log.error({ err }, '[Feishu QR] Failed to fetch QR code');
      reply.status(502);
      return { error: 'Failed to fetch QR code from Feishu registration service' };
    }
  });

  app.get('/api/connector/feishu/qrcode-status', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };

    const { qrPayload } = request.query as { qrPayload?: string };
    if (!qrPayload) {
      reply.status(400);
      return { error: 'qrPayload query parameter required' };
    }

    try {
      const status = await feishuQrBindClient.poll(qrPayload);
      if (status.status !== 'confirmed') {
        return status;
      }

      const updates = [
        { name: 'FEISHU_APP_ID', value: status.appId ?? null },
        { name: 'FEISHU_APP_SECRET', value: status.appSecret ?? null },
      ];
      const currentMode = process.env.FEISHU_CONNECTION_MODE === 'websocket' ? 'websocket' : 'webhook';
      const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
      if (currentMode === 'webhook' && (!verificationToken || verificationToken.trim() === '')) {
        updates.push({ name: 'FEISHU_CONNECTION_MODE', value: 'websocket' });
      }
      await applyConnectorSecretUpdates(updates, { envFilePath: opts.envFilePath });
      return { status: 'confirmed' };
    } catch (err) {
      app.log.error({ err }, '[Feishu QR] Failed to poll QR status');
      reply.status(502);
      return { error: 'Failed to poll Feishu QR status' };
    }
  });

  // ── F137: WeChat QR code login routes ──

  app.post('/api/connector/weixin/qrcode', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };

    try {
      const { WeixinAdapter: WA } = await import('../infrastructure/connectors/adapters/WeixinAdapter.js');
      const result = await WA.fetchQrCode();
      // iLink returns a webpage URL (https://liteapp.weixin.qq.com/q/...), not an image.
      // Generate a real QR code data URI from the URL so <img> can render it.
      const QRCode = await import('qrcode');
      const qrDataUri = await QRCode.toDataURL(result.qrUrl, { width: 384, margin: 2 });
      return { qrUrl: qrDataUri, qrPayload: result.qrPayload };
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

  // F137 Phase D: Disconnect WeChat — stop polling + clear token + clear state
  app.post('/api/connector/weixin/disconnect', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };

    const adapter = opts.weixinAdapter;
    if (!adapter) {
      reply.status(503);
      return { error: 'WeChat adapter not available (connector gateway not started)' };
    }

    await adapter.disconnect();
    app.log.info({ userId }, '[WeChat] Disconnected by user');

    return { ok: true };
  });

  // ── F134 Phase D: Connector Permission API ──

  app.get('/api/connector/permissions/:connectorId', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };
    const { connectorId } = request.params as { connectorId: string };
    const store = opts.permissionStore;
    if (!store) {
      return { whitelistEnabled: false, commandAdminOnly: false, adminOpenIds: [], allowedGroups: [] };
    }
    return store.getConfig(connectorId);
  });

  app.put('/api/connector/permissions/:connectorId', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };
    const { connectorId } = request.params as { connectorId: string };
    const store = opts.permissionStore;
    if (!store) {
      reply.status(503);
      return { error: 'Permission store not available' };
    }
    const body = request.body as {
      whitelistEnabled?: boolean;
      commandAdminOnly?: boolean;
      adminOpenIds?: string[];
      allowedGroups?: Array<{ externalChatId: string; label?: string }>;
    };
    if (body.whitelistEnabled !== undefined) {
      await store.setWhitelistEnabled(connectorId, body.whitelistEnabled);
    }
    if (body.commandAdminOnly !== undefined) {
      await store.setCommandAdminOnly(connectorId, body.commandAdminOnly);
    }
    if (body.adminOpenIds !== undefined) {
      await store.setAdminOpenIds(connectorId, body.adminOpenIds);
    }
    if (body.allowedGroups !== undefined) {
      const current = await store.listAllowedGroups(connectorId);
      for (const g of current) await store.denyGroup(connectorId, g.externalChatId);
      for (const g of body.allowedGroups) await store.allowGroup(connectorId, g.externalChatId, g.label);
    }
    return store.getConfig(connectorId);
  });
};
