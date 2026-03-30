import QRCode from 'qrcode';

const FEISHU_ACCOUNTS_BASE_URL = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS_BASE_URL = 'https://accounts.larksuite.com';

interface FeishuRegistrationResponse {
  supported_auth_methods?: unknown;
  verification_uri_complete?: unknown;
  device_code?: unknown;
  interval?: unknown;
  expire_in?: unknown;
  error?: unknown;
  error_description?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  user_info?: unknown;
}

export interface FeishuQrCreateResult {
  qrUrl: string;
  qrPayload: string;
  intervalMs: number;
  expireMs: number;
}

export interface FeishuQrPollResult {
  status: 'waiting' | 'confirmed' | 'expired' | 'denied' | 'error';
  appId?: string;
  appSecret?: string;
  error?: string;
}

export interface FeishuQrBindClient {
  create(): Promise<FeishuQrCreateResult>;
  poll(qrPayload: string): Promise<FeishuQrPollResult>;
}

function toPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
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
  if (!res.ok && typeof data.error !== 'string') {
    throw new Error(`registration api ${res.status}`);
  }
  return data;
}

export class DefaultFeishuQrBindClient implements FeishuQrBindClient {
  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch) {}

  async create(): Promise<FeishuQrCreateResult> {
    const initData = await postFeishuRegistration(
      this.fetchFn,
      FEISHU_ACCOUNTS_BASE_URL,
      new URLSearchParams({ action: 'init' }),
    );
    const supportedMethods = Array.isArray(initData.supported_auth_methods) ? initData.supported_auth_methods : [];
    if (!supportedMethods.includes('client_secret')) {
      throw new Error('Feishu registration endpoint does not support client_secret auth method');
    }

    const beginData = await postFeishuRegistration(
      this.fetchFn,
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
      throw new Error('Feishu registration response is missing QR payload');
    }

    const qrUrl = new URL(verificationUri);
    qrUrl.searchParams.set('from', 'onboard');

    return {
      qrUrl: await QRCode.toDataURL(qrUrl.toString(), { width: 384, margin: 2 }),
      qrPayload: deviceCode,
      intervalMs: toPositiveNumber(beginData.interval, 5) * 1000,
      expireMs: toPositiveNumber(beginData.expire_in, 600) * 1000,
    };
  }

  async poll(qrPayload: string): Promise<FeishuQrPollResult> {
    const form = new URLSearchParams({ action: 'poll', device_code: qrPayload });
    let pollData = await postFeishuRegistration(this.fetchFn, FEISHU_ACCOUNTS_BASE_URL, form);

    const tenantBrand =
      typeof pollData.user_info === 'object' && pollData.user_info && 'tenant_brand' in pollData.user_info
        ? String((pollData.user_info as Record<string, unknown>).tenant_brand ?? '')
        : '';
    const hasCredentials = typeof pollData.client_id === 'string' && typeof pollData.client_secret === 'string';
    if (!hasCredentials && tenantBrand === 'lark') {
      try {
        pollData = await postFeishuRegistration(this.fetchFn, LARK_ACCOUNTS_BASE_URL, form);
      } catch {
        // Ignore fallback failure; original pollData still drives final state.
      }
    }

    if (typeof pollData.client_id === 'string' && typeof pollData.client_secret === 'string') {
      return {
        status: 'confirmed',
        appId: pollData.client_id,
        appSecret: pollData.client_secret,
      };
    }

    if (pollData.error === 'authorization_pending' || pollData.error === 'slow_down') {
      return { status: 'waiting' };
    }
    if (pollData.error === 'access_denied') {
      return { status: 'denied' };
    }
    if (pollData.error === 'expired_token') {
      return { status: 'expired' };
    }
    if (typeof pollData.error === 'string') {
      return {
        status: 'error',
        error: typeof pollData.error_description === 'string' ? pollData.error_description : pollData.error,
      };
    }
    return { status: 'waiting' };
  }
}
