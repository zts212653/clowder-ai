import type { RedisClient } from '@cat-cafe/shared/utils';

const REDIS_KEY_PREFIX = 'weixin-mp:access-token:';
const WX_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const REFRESH_MARGIN_SEC = 300;
const REDIS_HIT_FALLBACK_TTL_MS = 60_000;

interface TokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
}

export class WeixinMpTokenManager {
  private memToken: string | undefined;
  private memExpiresAt = 0;
  private memAppId: string | undefined;
  private skipRedisOnceAppId: string | undefined;

  constructor(
    private readonly redis: RedisClient | undefined,
    private readonly pluginConfig: Record<string, string>,
  ) {}

  async getAccessToken(): Promise<string> {
    const appId = this.pluginConfig.WEIXIN_MP_APP_ID;
    if (!appId) throw new Error('WEIXIN_MP_APP_ID must be configured');

    if (this.memAppId !== appId) {
      this.memToken = undefined;
      this.memExpiresAt = 0;
      if (this.skipRedisOnceAppId !== appId) {
        this.skipRedisOnceAppId = undefined;
      }
    }

    if (this.memToken && Date.now() < this.memExpiresAt) {
      return this.memToken;
    }

    const skipRedis = this.skipRedisOnceAppId === appId;
    if (skipRedis) {
      this.skipRedisOnceAppId = undefined;
    }

    if (this.redis && !skipRedis) {
      try {
        const cached = await this.redis.get(`${REDIS_KEY_PREFIX}${appId}`);
        if (cached) {
          this.rememberToken(appId, cached, REDIS_HIT_FALLBACK_TTL_MS);
          return cached;
        }
      } catch {
        /* Redis is an optional cache; fall back to in-memory/fresh token. */
      }
    }
    return this.refresh();
  }

  async invalidateAccessToken(): Promise<void> {
    const appId = this.pluginConfig.WEIXIN_MP_APP_ID;
    this.memToken = undefined;
    this.memExpiresAt = 0;
    this.memAppId = undefined;

    if (!appId || !this.redis) return;
    try {
      await this.redis.del(`${REDIS_KEY_PREFIX}${appId}`);
    } catch {
      this.skipRedisOnceAppId = appId;
      /* Redis is an optional cache; memory has already been invalidated. */
    }
  }

  private async refresh(): Promise<string> {
    const appId = this.pluginConfig.WEIXIN_MP_APP_ID;
    const appSecret = this.pluginConfig.WEIXIN_MP_APP_SECRET;
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
      try {
        await this.redis.setex(`${REDIS_KEY_PREFIX}${appId}`, ttlSec, data.access_token);
      } catch {
        /* Redis is an optional cache; keep the process-local token. */
      }
    }
    this.rememberToken(appId, data.access_token, ttlSec * 1000);
    return data.access_token;
  }

  private rememberToken(appId: string, token: string, ttlMs: number): void {
    this.memToken = token;
    this.memExpiresAt = Date.now() + ttlMs;
    this.memAppId = appId;
  }
}
