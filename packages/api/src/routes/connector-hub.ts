import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_THREAD_ID, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { WeixinAdapter } from '../infrastructure/connectors/adapters/WeixinAdapter.js';
import type { IConnectorPermissionStore } from '../infrastructure/connectors/ConnectorPermissionStore.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
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
  /** Optional override for writing connector env updates in tests */
  envFilePath?: string;
  /** Optional fetch override for Feishu registration API in tests */
  feishuRegistrationFetch?: typeof fetch;
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

const FEISHU_ACCOUNTS_BASE_URL = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS_BASE_URL = 'https://accounts.larksuite.com';

type FeishuRegistrationResponse = Record<string, unknown>;

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

function formatEnvFileValue(value: string): string {
  const escapedControlChars = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  if (/^[A-Za-z0-9_./:@-]+$/.test(escapedControlChars)) return escapedControlChars;
  return `"${escapedControlChars
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')}"`;
}

function applyEnvUpdatesToFile(contents: string, updates: Map<string, string | null>): string {
  const lines = contents === '' ? [] : contents.split(/\r?\n/);
  const seen = new Set<string>();
  const nextLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      nextLines.push(line);
      continue;
    }
    const name = match[1]!;
    if (!updates.has(name)) {
      nextLines.push(line);
      continue;
    }
    seen.add(name);
    const value = updates.get(name);
    if (value == null || value === '') continue;
    nextLines.push(`${name}=${formatEnvFileValue(value)}`);
  }

  for (const [name, value] of updates) {
    if (seen.has(name) || value == null || value === '') continue;
    nextLines.push(`${name}=${formatEnvFileValue(value)}`);
  }

  const normalized = nextLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return normalized.length > 0 ? `${normalized}\n` : '';
}

function persistEnvUpdates(envFilePath: string, updates: Map<string, string | null>): void {
  const current = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '';
  const next = applyEnvUpdatesToFile(current, updates);
  writeFileSync(envFilePath, next, 'utf8');
  for (const [name, value] of updates) {
    if (value == null || value === '') delete process.env[name];
    else process.env[name] = value;
  }
}

async function postFeishuRegistration(
  fetchFn: typeof fetch,
  baseUrl: string,
  form: URLSearchParams,
): Promise<FeishuRegistrationResponse> {
  const res = await fetchFn(`${baseUrl}/oauth/v1/app/registration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as FeishuRegistrationResponse;
  if (!res.ok && !('error' in data)) {
    throw new Error(`registration api ${res.status}`);
  }
  return data;
}

function toPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
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
  const envFilePath = opts.envFilePath ?? resolve(resolveActiveProjectRoot(), '.env');
  const feishuRegistrationFetch = opts.feishuRegistrationFetch ?? globalThis.fetch;

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

  // ── Feishu QR code create/bind routes ──

  app.post('/api/connector/feishu/qrcode', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };

    try {
      const initData = await postFeishuRegistration(
        feishuRegistrationFetch,
        FEISHU_ACCOUNTS_BASE_URL,
        new URLSearchParams({ action: 'init' }),
      );
      const supportedMethods = Array.isArray(initData.supported_auth_methods) ? initData.supported_auth_methods : [];
      if (!supportedMethods.includes('client_secret')) {
        reply.status(502);
        return { error: 'Feishu registration endpoint does not support client_secret auth method' };
      }

      const beginData = await postFeishuRegistration(
        feishuRegistrationFetch,
        FEISHU_ACCOUNTS_BASE_URL,
        new URLSearchParams({
          action: 'begin',
          archetype: 'PersonalAgent',
          auth_method: 'client_secret',
          request_user_info: 'open_id',
        }),
      );

      const verificationUri = beginData.verification_uri_complete;
      const deviceCode = beginData.device_code;
      if (typeof verificationUri !== 'string' || typeof deviceCode !== 'string') {
        reply.status(502);
        return { error: 'Feishu registration response is missing QR payload' };
      }

      const qrUrl = new URL(verificationUri);
      qrUrl.searchParams.set('from', 'onboard');

      const QRCode = await import('qrcode');
      const qrDataUri = await QRCode.toDataURL(qrUrl.toString(), { width: 384, margin: 2 });

      return {
        qrUrl: qrDataUri,
        qrPayload: deviceCode,
        interval: toPositiveNumber(beginData.interval, 5),
        expiresIn: toPositiveNumber(beginData.expire_in, 600),
      };
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
      const pollForm = new URLSearchParams({ action: 'poll', device_code: qrPayload });
      let pollData = await postFeishuRegistration(feishuRegistrationFetch, FEISHU_ACCOUNTS_BASE_URL, pollForm);

      const tenantBrand = ((pollData.user_info as Record<string, unknown> | undefined)?.tenant_brand ?? '') as string;
      const hasCredentials = typeof pollData.client_id === 'string' && typeof pollData.client_secret === 'string';
      if (!hasCredentials && tenantBrand === 'lark') {
        try {
          pollData = await postFeishuRegistration(feishuRegistrationFetch, LARK_ACCOUNTS_BASE_URL, pollForm);
        } catch (err) {
          app.log.warn({ err }, '[Feishu QR] Lark poll fallback failed');
        }
      }

      const clientId = pollData.client_id;
      const clientSecret = pollData.client_secret;
      if (typeof clientId === 'string' && typeof clientSecret === 'string') {
        const updates = new Map<string, string | null>([
          ['FEISHU_APP_ID', clientId],
          ['FEISHU_APP_SECRET', clientSecret],
        ]);
        const currentMode = process.env.FEISHU_CONNECTION_MODE === 'websocket' ? 'websocket' : 'webhook';
        const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
        if (currentMode === 'webhook' && (!verificationToken || verificationToken.trim() === '')) {
          // QR onboarding does not return webhook verification token; default to websocket so setup is immediately valid.
          updates.set('FEISHU_CONNECTION_MODE', 'websocket');
        }
        persistEnvUpdates(envFilePath, updates);
        app.log.info('[Feishu QR] Bot credentials captured and persisted to env file');
        return { status: 'confirmed' };
      }

      const errorCode = pollData.error;
      if (errorCode === 'authorization_pending' || errorCode === 'slow_down') {
        return { status: 'waiting' };
      }
      if (errorCode === 'access_denied') {
        return { status: 'denied' };
      }
      if (errorCode === 'expired_token') {
        return { status: 'expired' };
      }
      if (typeof errorCode === 'string') {
        return {
          status: 'error',
          error: typeof pollData.error_description === 'string' ? pollData.error_description : errorCode,
        };
      }
      return { status: 'waiting' };
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
