import { createHash, randomUUID } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';

const GRANT_PREFIX = 'cloud-bridge:return-grant:';
const CLAIM_SUFFIX = ':claim';
const CLAIM_TTL_MS = 120_000;
const GRANT_RETENTION_MS = 86_400_000;

export interface CloudReturnGrantClaims {
  readonly threadId: string;
  readonly userId: string;
  readonly sourceMessageId: string;
  readonly dispatchInvocationId: string;
  readonly targetCatId: string;
}

export type CloudReturnGrantScope = Omit<CloudReturnGrantClaims, 'dispatchInvocationId'>;

interface StoredCloudReturnGrant extends CloudReturnGrantClaims {
  readonly v: 1;
  readonly status: 'pending' | 'consumed';
  readonly issuedAt: number;
  readonly consumedAt?: number;
}

export interface CloudReturnGrantClaim extends CloudReturnGrantClaims {
  readonly leaseId: string;
  readonly grantKey: string;
  readonly claimKey: string;
}

export type CloudReturnGrantIssueResult =
  | { readonly ok: true; readonly status: 'issued' | 'existing' }
  | { readonly ok: false; readonly reason: 'scope_collision' };

export type CloudReturnGrantClaimResult =
  | ({ readonly ok: true } & CloudReturnGrantClaim)
  | { readonly ok: false; readonly reason: 'not_found' | 'in_flight' | 'consumed' };

export interface CloudReturnGrantStore {
  issue(claims: CloudReturnGrantClaims): Promise<CloudReturnGrantIssueResult>;
  claim(scope: CloudReturnGrantScope): Promise<CloudReturnGrantClaimResult>;
  commit(claim: CloudReturnGrantClaim): Promise<boolean>;
  release(claim: CloudReturnGrantClaim): Promise<boolean>;
}

function requireRef(value: string, field: string, maximum: number): string {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (!value || value.length > maximum || hasControlCharacter) {
    throw new Error(`${field} must be a bounded non-empty ref without control characters`);
  }
  return value;
}

function normalizeClaims(claims: CloudReturnGrantClaims): CloudReturnGrantClaims {
  return {
    threadId: requireRef(claims.threadId, 'threadId', 512),
    userId: requireRef(claims.userId, 'userId', 256),
    sourceMessageId: requireRef(claims.sourceMessageId, 'sourceMessageId', 512),
    dispatchInvocationId: requireRef(claims.dispatchInvocationId, 'dispatchInvocationId', 512),
    targetCatId: requireRef(claims.targetCatId, 'targetCatId', 128),
  };
}

function normalizeScope(scope: CloudReturnGrantScope): CloudReturnGrantScope {
  return {
    threadId: requireRef(scope.threadId, 'threadId', 512),
    userId: requireRef(scope.userId, 'userId', 256),
    sourceMessageId: requireRef(scope.sourceMessageId, 'sourceMessageId', 512),
    targetCatId: requireRef(scope.targetCatId, 'targetCatId', 128),
  };
}

function scopeMaterial(scope: CloudReturnGrantScope): string {
  return JSON.stringify(normalizeScope(scope));
}

function grantKey(scope: CloudReturnGrantScope): string {
  return `${GRANT_PREFIX}${createHash('sha256').update(scopeMaterial(scope)).digest('hex')}`;
}

function parseStored(raw: string | null): StoredCloudReturnGrant | null {
  if (!raw) return null;
  try {
    const candidate = JSON.parse(raw) as Partial<StoredCloudReturnGrant>;
    if (
      candidate.v !== 1 ||
      (candidate.status !== 'pending' && candidate.status !== 'consumed') ||
      typeof candidate.issuedAt !== 'number' ||
      typeof candidate.threadId !== 'string' ||
      typeof candidate.userId !== 'string' ||
      typeof candidate.sourceMessageId !== 'string' ||
      typeof candidate.dispatchInvocationId !== 'string' ||
      typeof candidate.targetCatId !== 'string'
    ) {
      return null;
    }
    return candidate as StoredCloudReturnGrant;
  } catch {
    return null;
  }
}

function sameScope(record: StoredCloudReturnGrant, scope: CloudReturnGrantScope): boolean {
  return (
    record.threadId === scope.threadId &&
    record.userId === scope.userId &&
    record.sourceMessageId === scope.sourceMessageId &&
    record.targetCatId === scope.targetCatId
  );
}

function toClaim(record: StoredCloudReturnGrant, key: string, leaseId: string): CloudReturnGrantClaimResult {
  return {
    ok: true,
    threadId: record.threadId,
    userId: record.userId,
    sourceMessageId: record.sourceMessageId,
    dispatchInvocationId: record.dispatchInvocationId,
    targetCatId: record.targetCatId,
    leaseId,
    grantKey: key,
    claimKey: `${key}${CLAIM_SUFFIX}`,
  };
}

const COMMIT_LUA = `
local lease = redis.call('GET', KEYS[2])
if lease ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.status ~= 'pending' then return 0 end
record.status = 'consumed'
record.consumedAt = tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', tonumber(ARGV[3]))
redis.call('DEL', KEYS[2])
return 1
`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

const REFRESH_EXISTING_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local decoded, record = pcall(cjson.decode, raw)
if not decoded then return -1 end
if record.v ~= 1 then return -1 end
if record.status ~= 'pending' and record.status ~= 'consumed' then return -1 end
if type(record.issuedAt) ~= 'number' or type(record.dispatchInvocationId) ~= 'string' then return -1 end
if record.threadId ~= ARGV[1] then return -1 end
if record.userId ~= ARGV[2] then return -1 end
if record.sourceMessageId ~= ARGV[3] then return -1 end
if record.targetCatId ~= ARGV[4] then return -1 end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
return 1
`;

export class RedisCloudReturnGrantStore implements CloudReturnGrantStore {
  constructor(private readonly redis: RedisClient) {}

  async issue(input: CloudReturnGrantClaims): Promise<CloudReturnGrantIssueResult> {
    const claims = normalizeClaims(input);
    const key = grantKey(claims);
    const record: StoredCloudReturnGrant = { v: 1, ...claims, status: 'pending', issuedAt: Date.now() };
    const result = await this.redis.set(key, JSON.stringify(record), 'PX', GRANT_RETENTION_MS, 'NX');
    if (result === 'OK') return { ok: true, status: 'issued' };
    const refreshed = await this.redis.eval(
      REFRESH_EXISTING_LUA,
      1,
      key,
      claims.threadId,
      claims.userId,
      claims.sourceMessageId,
      claims.targetCatId,
      GRANT_RETENTION_MS,
    );
    if (refreshed !== 1) return { ok: false, reason: 'scope_collision' };
    return { ok: true, status: 'existing' };
  }

  async claim(input: CloudReturnGrantScope): Promise<CloudReturnGrantClaimResult> {
    const scope = normalizeScope(input);
    const key = grantKey(scope);
    const record = parseStored(await this.redis.get(key));
    if (!record || !sameScope(record, scope)) return { ok: false, reason: 'not_found' };
    if (record.status === 'consumed') return { ok: false, reason: 'consumed' };
    const leaseId = randomUUID();
    const claimed = await this.redis.set(`${key}${CLAIM_SUFFIX}`, leaseId, 'PX', CLAIM_TTL_MS, 'NX');
    if (claimed !== 'OK') return { ok: false, reason: 'in_flight' };
    const afterClaim = parseStored(await this.redis.get(key));
    if (!afterClaim || afterClaim.status !== 'pending' || !sameScope(afterClaim, scope)) {
      await this.redis.eval(RELEASE_LUA, 1, `${key}${CLAIM_SUFFIX}`, leaseId);
      return { ok: false, reason: afterClaim?.status === 'consumed' ? 'consumed' : 'not_found' };
    }
    return toClaim(afterClaim, key, leaseId);
  }

  async commit(claim: CloudReturnGrantClaim): Promise<boolean> {
    return (
      (await this.redis.eval(
        COMMIT_LUA,
        2,
        claim.grantKey,
        claim.claimKey,
        claim.leaseId,
        Date.now(),
        GRANT_RETENTION_MS,
      )) === 1
    );
  }

  async release(claim: CloudReturnGrantClaim): Promise<boolean> {
    return (await this.redis.eval(RELEASE_LUA, 1, claim.claimKey, claim.leaseId)) === 1;
  }
}

export class MemoryCloudReturnGrantStore implements CloudReturnGrantStore {
  private readonly grants = new Map<string, StoredCloudReturnGrant>();
  private readonly leases = new Map<string, { leaseId: string; expiresAt: number }>();
  private readonly grantExpiresAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private pruneExpired(key: string): void {
    const expiresAt = this.grantExpiresAt.get(key);
    if (expiresAt === undefined || expiresAt > this.now()) return;
    this.grants.delete(key);
    this.leases.delete(key);
    this.grantExpiresAt.delete(key);
  }

  async issue(input: CloudReturnGrantClaims): Promise<CloudReturnGrantIssueResult> {
    const claims = normalizeClaims(input);
    const key = grantKey(claims);
    this.pruneExpired(key);
    const existing = this.grants.get(key);
    if (existing) {
      if (!sameScope(existing, claims)) return { ok: false, reason: 'scope_collision' };
      this.grantExpiresAt.set(key, this.now() + GRANT_RETENTION_MS);
      return { ok: true, status: 'existing' };
    }
    this.grants.set(key, { v: 1, ...claims, status: 'pending', issuedAt: this.now() });
    this.grantExpiresAt.set(key, this.now() + GRANT_RETENTION_MS);
    return { ok: true, status: 'issued' };
  }

  async claim(input: CloudReturnGrantScope): Promise<CloudReturnGrantClaimResult> {
    const scope = normalizeScope(input);
    const key = grantKey(scope);
    this.pruneExpired(key);
    const record = this.grants.get(key);
    if (!record || !sameScope(record, scope)) return { ok: false, reason: 'not_found' };
    if (record.status === 'consumed') return { ok: false, reason: 'consumed' };
    const currentLease = this.leases.get(key);
    if (currentLease && currentLease.expiresAt > this.now()) return { ok: false, reason: 'in_flight' };
    const leaseId = randomUUID();
    this.leases.set(key, { leaseId, expiresAt: this.now() + CLAIM_TTL_MS });
    return toClaim(record, key, leaseId);
  }

  async commit(claim: CloudReturnGrantClaim): Promise<boolean> {
    this.pruneExpired(claim.grantKey);
    const lease = this.leases.get(claim.grantKey);
    const record = this.grants.get(claim.grantKey);
    if (!lease || lease.leaseId !== claim.leaseId || !record || record.status !== 'pending') return false;
    this.grants.set(claim.grantKey, { ...record, status: 'consumed', consumedAt: this.now() });
    this.grantExpiresAt.set(claim.grantKey, this.now() + GRANT_RETENTION_MS);
    this.leases.delete(claim.grantKey);
    return true;
  }

  async release(claim: CloudReturnGrantClaim): Promise<boolean> {
    this.pruneExpired(claim.grantKey);
    const lease = this.leases.get(claim.grantKey);
    if (!lease || lease.leaseId !== claim.leaseId) return false;
    this.leases.delete(claim.grantKey);
    return true;
  }
}

export const CloudReturnGrantKeyPrefix = GRANT_PREFIX;
export const CloudReturnGrantRetentionMs = GRANT_RETENTION_MS;
