import { createHash } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { LimbAuthConfig } from './limb-yaml-loader.js';

const REDIS_KEY_PREFIX = 'plugin-limb:token:';
const REFRESH_MARGIN_SEC = 300;
const REDIS_HIT_FALLBACK_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

interface TokenResponse {
  readonly [key: string]: unknown;
}

/**
 * Generic plugin token manager — driven by YAML auth config.
 * Handles client_credentials flow with Redis + in-memory caching.
 */
export class PluginTokenManager {
  private memToken: string | undefined;
  private memExpiresAt = 0;
  private memCacheKey: string | undefined;
  private skipRedisOnceCacheKey: string | undefined;

  constructor(
    private readonly auth: LimbAuthConfig,
    private readonly baseUrl: string,
    private readonly pluginConfig: Record<string, string>,
    private readonly redis: RedisClient | undefined,
  ) {}

  /** Resolve ${VAR} template against plugin config */
  resolveTemplate(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => this.pluginConfig[key] ?? '');
  }

  async getAccessToken(): Promise<string> {
    const cacheKey = this.buildCacheKey();

    if (this.memCacheKey !== cacheKey) {
      this.memToken = undefined;
      this.memExpiresAt = 0;
      if (this.skipRedisOnceCacheKey !== cacheKey) {
        this.skipRedisOnceCacheKey = undefined;
      }
    }

    if (this.memToken && Date.now() < this.memExpiresAt) {
      return this.memToken;
    }

    const skipRedis = this.skipRedisOnceCacheKey === cacheKey;
    if (skipRedis) this.skipRedisOnceCacheKey = undefined;

    if (this.redis && !skipRedis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          this.rememberToken(cacheKey, cached, REDIS_HIT_FALLBACK_TTL_MS);
          return cached;
        }
      } catch {
        /* Redis is optional cache */
      }
    }

    return this.refresh(cacheKey);
  }

  async invalidateAccessToken(): Promise<void> {
    const cacheKey = this.buildCacheKey();
    this.memToken = undefined;
    this.memExpiresAt = 0;
    this.memCacheKey = undefined;

    if (this.redis) {
      try {
        await this.redis.del(cacheKey);
      } catch {
        this.skipRedisOnceCacheKey = cacheKey;
      }
    }
  }

  isTokenExpiredError(errcode: number): boolean {
    return this.auth.tokenExpiredCodes.includes(errcode);
  }

  private buildCacheKey(): string {
    // Include tokenEndpoint + baseUrl in the fingerprint so two plugins with
    // the same credentials but different token endpoints don't share a cached
    // token (Codex review R2 P2).
    const tokenUrl = this.auth.tokenEndpoint.startsWith('http')
      ? this.auth.tokenEndpoint
      : `${this.baseUrl}${this.auth.tokenEndpoint}`;
    const resolvedParams = Object.entries(this.auth.tokenParams)
      .map(([k, v]) => `${k}=${this.resolveTemplate(v)}`)
      .join('&');
    const fingerprint = createHash('sha256').update(`${tokenUrl}\n${resolvedParams}`).digest('hex').slice(0, 16);
    return `${REDIS_KEY_PREFIX}${this.auth.type}:${fingerprint}`;
  }

  private async refresh(cacheKey: string): Promise<string> {
    const params = new URLSearchParams();
    for (const [key, val] of Object.entries(this.auth.tokenParams)) {
      params.set(key, this.resolveTemplate(val));
    }

    const tokenUrl = this.auth.tokenEndpoint.startsWith('http')
      ? this.auth.tokenEndpoint
      : `${this.baseUrl}${this.auth.tokenEndpoint}`;

    const res = await fetch(`${tokenUrl}?${params.toString()}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = (await res.json()) as TokenResponse;

    const token = this.extractNestedValue(data, this.auth.tokenResponsePath) as string | undefined;
    if (!token) {
      const errcode = data['errcode'] ?? 'unknown';
      const errmsg = data['errmsg'] ?? '';
      throw new Error(`Token error: ${errcode} ${errmsg}`);
    }

    const ttlSec = ((data['expires_in'] as number) ?? this.auth.ttlSeconds) - REFRESH_MARGIN_SEC;
    if (this.redis) {
      try {
        await this.redis.setex(cacheKey, ttlSec, token);
      } catch {
        /* Redis is optional cache */
      }
    }
    this.rememberToken(cacheKey, token, ttlSec * 1000);
    return token;
  }

  private extractNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((cur, key) => {
      if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key];
      return undefined;
    }, obj);
  }

  private rememberToken(cacheKey: string, token: string, ttlMs: number): void {
    this.memToken = token;
    this.memExpiresAt = Date.now() + ttlMs;
    this.memCacheKey = cacheKey;
  }
}
