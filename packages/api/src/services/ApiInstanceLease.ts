import { randomUUID } from 'node:crypto';
import { hostname as getHostname } from 'node:os';
import type { RedisClient } from '@cat-cafe/shared/utils';

export const API_INSTANCE_LEASE_KEY = 'runtime:api-instance-lease:v1';

const RENEW_LEASE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
`;

const RELEASE_LEASE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
`;

const STEAL_LEASE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return 1
`;

export interface ApiInstanceLeaseHolder {
  version: 1;
  token: string;
  instanceId: string;
  pid: number;
  hostname: string;
  apiPort: number;
  cwd: string;
  startedAt: number;
  acquiredAt: number;
}

export type ApiInstanceLeaseInvalidationReason = 'renew_failed' | 'lease_lost';

export interface ApiInstanceLeaseInvalidation {
  reason: ApiInstanceLeaseInvalidationReason;
  holder: ApiInstanceLeaseHolder;
  error?: unknown;
}

export interface ApiInstanceLeaseOptions {
  apiPort: number;
  cwd?: string;
  key?: string;
  ttlMs?: number;
  heartbeatMs?: number;
  instanceId?: string;
  pid?: number;
  hostname?: string;
  startedAt?: number;
  isPidAlive?: (pid: number) => boolean;
  onLeaseInvalidated?: (event: ApiInstanceLeaseInvalidation) => void;
}

export interface AcquireLeaseResult {
  acquired: boolean;
  holder?: ApiInstanceLeaseHolder;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
    return code !== 'ESRCH';
  }
}

export class ApiInstanceLease {
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly instanceId: string;
  private readonly token: string;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly apiPort: number;
  private readonly cwd: string;
  private readonly startedAt: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly onLeaseInvalidated?: (event: ApiInstanceLeaseInvalidation) => void;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentRaw: string | null = null;
  private currentHolder: ApiInstanceLeaseHolder | null = null;
  private leaseInvalidated = false;
  private releasing = false;

  constructor(
    private readonly redis: Pick<RedisClient, 'set' | 'get' | 'eval'>,
    options: ApiInstanceLeaseOptions,
  ) {
    this.key = options.key ?? API_INSTANCE_LEASE_KEY;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.instanceId = options.instanceId ?? `api-${randomUUID()}`;
    this.token = randomUUID();
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? getHostname();
    this.apiPort = options.apiPort;
    this.cwd = options.cwd ?? process.cwd();
    this.startedAt = options.startedAt ?? Date.now();
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.onLeaseInvalidated = options.onLeaseInvalidated;
  }

  async acquire(): Promise<AcquireLeaseResult> {
    const holder = this.buildHolder();
    const raw = JSON.stringify(holder);
    const acquired = await this.trySet(raw);
    if (acquired) {
      this.setCurrentLease(raw, holder);
      return { acquired: true, holder };
    }

    const existingRaw = await this.redis.get(this.key);
    if (!existingRaw) {
      const retried = await this.trySet(raw);
      if (retried) {
        this.setCurrentLease(raw, holder);
        return { acquired: true, holder };
      }
      return { acquired: false };
    }

    const existingHolder = this.parseHolder(existingRaw);
    if (existingHolder && this.canSteal(existingHolder)) {
      const stolen = Number(await this.redis.eval(STEAL_LEASE_LUA, 1, this.key, existingRaw, raw, String(this.ttlMs)));
      if (stolen === 1) {
        this.setCurrentLease(raw, holder);
        return { acquired: true, holder };
      }
    }

    return {
      acquired: false,
      holder: existingHolder ?? undefined,
    };
  }

  async release(): Promise<void> {
    this.releasing = true;
    this.stopHeartbeat();
    if (!this.currentRaw) {
      this.currentHolder = null;
      this.leaseInvalidated = false;
      this.releasing = false;
      return;
    }
    try {
      await this.redis.eval(RELEASE_LEASE_LUA, 1, this.key, this.currentRaw);
    } finally {
      this.currentRaw = null;
      this.currentHolder = null;
      this.leaseInvalidated = false;
      this.releasing = false;
    }
  }

  private buildHolder(): ApiInstanceLeaseHolder {
    return {
      version: 1,
      token: this.token,
      instanceId: this.instanceId,
      pid: this.pid,
      hostname: this.hostname,
      apiPort: this.apiPort,
      cwd: this.cwd,
      startedAt: this.startedAt,
      acquiredAt: Date.now(),
    };
  }

  private async trySet(raw: string): Promise<boolean> {
    const result = await this.redis.set(this.key, raw, 'PX', this.ttlMs, 'NX');
    return result === 'OK';
  }

  private setCurrentLease(raw: string, holder: ApiInstanceLeaseHolder): void {
    this.currentRaw = raw;
    this.currentHolder = holder;
    this.leaseInvalidated = false;
    this.releasing = false;
    this.startHeartbeat();
  }

  private canSteal(holder: ApiInstanceLeaseHolder): boolean {
    return holder.hostname === this.hostname && !this.isPidAlive(holder.pid);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatMs <= 0 || !this.currentRaw) return;

    this.heartbeatTimer = setInterval(() => {
      void this.renewOnce();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async renewOnce(): Promise<void> {
    if (!this.currentRaw) return;
    try {
      const renewed = Number(await this.redis.eval(RENEW_LEASE_LUA, 1, this.key, this.currentRaw, String(this.ttlMs)));
      if (renewed !== 1) {
        await this.invalidateLease('lease_lost');
      }
    } catch (error) {
      await this.invalidateLease('renew_failed', error);
    }
  }

  private async invalidateLease(reason: ApiInstanceLeaseInvalidationReason, error?: unknown): Promise<void> {
    if (this.releasing) {
      this.stopHeartbeat();
      this.currentRaw = null;
      this.currentHolder = null;
      return;
    }
    if (this.leaseInvalidated || !this.currentHolder) return;

    const holder = this.currentHolder;
    this.leaseInvalidated = true;
    this.stopHeartbeat();
    this.currentRaw = null;
    this.currentHolder = null;
    this.onLeaseInvalidated?.({ reason, holder, error });
  }

  private parseHolder(raw: string): ApiInstanceLeaseHolder | null {
    try {
      const parsed = JSON.parse(raw) as Partial<ApiInstanceLeaseHolder>;
      if (
        parsed.version !== 1 ||
        typeof parsed.token !== 'string' ||
        typeof parsed.instanceId !== 'string' ||
        typeof parsed.pid !== 'number' ||
        typeof parsed.hostname !== 'string' ||
        typeof parsed.apiPort !== 'number' ||
        typeof parsed.cwd !== 'string' ||
        typeof parsed.startedAt !== 'number' ||
        typeof parsed.acquiredAt !== 'number'
      ) {
        return null;
      }
      return parsed as ApiInstanceLeaseHolder;
    } catch {
      return null;
    }
  }
}
