import { createHash } from 'node:crypto';
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

interface TokenCredentials {
  readonly appId: string;
  readonly appSecret: string;
  readonly cacheKey: string;
}

function buildAccessTokenCacheKey(appId: string, appSecret: string): string {
  const secretFingerprint = createHash('sha256').update(appSecret).digest('hex').slice(0, 16);
  return `${REDIS_KEY_PREFIX}${appId}:${secretFingerprint}`;
}

export class WeixinMpTokenManager {
  private memToken: string | undefined;
  private memExpiresAt = 0;
  private memCacheKey: string | undefined;
  private skipRedisOnceCacheKey: string | undefined;

  constructor(
    private readonly redis: RedisClient | undefined,
    private readonly pluginConfig: Record<string, string>,
  ) {}

  async getAccessToken(): Promise<string> {
    const credentials = this.getConfiguredCredentials();

    if (this.memCacheKey !== credentials.cacheKey) {
      this.memToken = undefined;
      this.memExpiresAt = 0;
      if (this.skipRedisOnceCacheKey !== credentials.cacheKey) {
        this.skipRedisOnceCacheKey = undefined;
      }
    }

    if (this.memToken && Date.now() < this.memExpiresAt) {
      return this.memToken;
    }

    const skipRedis = this.skipRedisOnceCacheKey === credentials.cacheKey;
    if (skipRedis) {
      this.skipRedisOnceCacheKey = undefined;
    }

    if (this.redis && !skipRedis) {
      try {
        const cached = await this.redis.get(credentials.cacheKey);
        if (cached) {
          this.rememberToken(credentials.cacheKey, cached, REDIS_HIT_FALLBACK_TTL_MS);
          return cached;
        }
      } catch {
        /* Redis is an optional cache; fall back to in-memory/fresh token. */
      }
    }
    return this.refresh(credentials);
  }

  async invalidateAccessToken(): Promise<void> {
    const appId = this.pluginConfig.WEIXIN_MP_APP_ID;
    const appSecret = this.pluginConfig.WEIXIN_MP_APP_SECRET;
    this.memToken = undefined;
    this.memExpiresAt = 0;
    this.memCacheKey = undefined;

    if (!appId || !appSecret || !this.redis) return;
    const cacheKey = buildAccessTokenCacheKey(appId, appSecret);
    try {
      await this.redis.del(cacheKey);
    } catch {
      this.skipRedisOnceCacheKey = cacheKey;
      /* Redis is an optional cache; memory has already been invalidated. */
    }
  }

  private getConfiguredCredentials(): TokenCredentials {
    const appId = this.pluginConfig.WEIXIN_MP_APP_ID;
    const appSecret = this.pluginConfig.WEIXIN_MP_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error('WEIXIN_MP_APP_ID and WEIXIN_MP_APP_SECRET must be configured');
    }
    return { appId, appSecret, cacheKey: buildAccessTokenCacheKey(appId, appSecret) };
  }

  private async refresh(credentials: TokenCredentials): Promise<string> {
    const { appId, appSecret, cacheKey } = credentials;
    const url = `${WX_TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const data = (await res.json()) as TokenResponse;

    if (data.errcode || !data.access_token) {
      throw new Error(`WeChat token error: ${data.errcode ?? 'unknown'} ${data.errmsg ?? ''}`);
    }

    const ttlSec = (data.expires_in ?? 7200) - REFRESH_MARGIN_SEC;
    if (this.redis) {
      try {
        await this.redis.setex(cacheKey, ttlSec, data.access_token);
      } catch {
        /* Redis is an optional cache; keep the process-local token. */
      }
    }
    this.rememberToken(cacheKey, data.access_token, ttlSec * 1000);
    return data.access_token;
  }

  private rememberToken(cacheKey: string, token: string, ttlMs: number): void {
    this.memToken = token;
    this.memExpiresAt = Date.now() + ttlMs;
    this.memCacheKey = cacheKey;
  }
}
