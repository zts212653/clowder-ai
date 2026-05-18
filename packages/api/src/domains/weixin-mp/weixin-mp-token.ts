import type { RedisClient } from '@cat-cafe/shared/utils';

const REDIS_KEY_PREFIX = 'weixin-mp:access-token:';
const WX_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const REFRESH_MARGIN_SEC = 300;

interface TokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
}

type EnvResolver = (name: string) => string | undefined;

export class WeixinMpTokenManager {
  private memToken: string | undefined;
  private memExpiresAt = 0;
  private memAppId: string | undefined;

  constructor(
    private readonly redis: RedisClient | undefined,
    private readonly resolveEnv: EnvResolver,
  ) {}

  async getAccessToken(): Promise<string> {
    const appId = this.resolveEnv('WEIXIN_MP_APP_ID');
    if (!appId) throw new Error('WEIXIN_MP_APP_ID must be configured');

    if (this.memAppId !== appId) {
      this.memToken = undefined;
      this.memExpiresAt = 0;
    }

    if (this.redis) {
      const cached = await this.redis.get(`${REDIS_KEY_PREFIX}${appId}`);
      if (cached) return cached;
    }
    if (this.memToken && Date.now() < this.memExpiresAt) {
      return this.memToken;
    }
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    const appId = this.resolveEnv('WEIXIN_MP_APP_ID');
    const appSecret = this.resolveEnv('WEIXIN_MP_APP_SECRET');
    if (!appId || !appSecret) {
      throw new Error('WEIXIN_MP_APP_ID and WEIXIN_MP_APP_SECRET must be configured');
    }

    const url = `${WX_TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const data = (await res.json()) as TokenResponse;

    if (data.errcode || !data.access_token) {
      throw new Error(`WeChat token error: ${data.errcode ?? 'unknown'} ${data.errmsg ?? ''}`);
    }

    const ttlSec = (data.expires_in ?? 7200) - REFRESH_MARGIN_SEC;
    if (this.redis) {
      await this.redis.setex(`${REDIS_KEY_PREFIX}${appId}`, ttlSec, data.access_token);
    }
    this.memToken = data.access_token;
    this.memExpiresAt = Date.now() + ttlSec * 1000;
    this.memAppId = appId;
    return data.access_token;
  }
}
