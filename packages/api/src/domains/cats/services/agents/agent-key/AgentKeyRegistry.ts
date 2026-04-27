import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AgentKeyRecord, AgentKeyVerifyResult, CatId } from '@cat-cafe/shared';
import type { IAgentKeyBackend } from './IAgentKeyBackend.js';
import { MemoryAgentKeyBackend } from './MemoryAgentKeyBackend.js';

const DEFAULT_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

export class AgentKeyRegistry {
  private readonly backend: IAgentKeyBackend;
  private readonly ttlMs: number;
  private readonly graceMs: number;

  constructor(options?: { ttlMs?: number; graceMs?: number; backend?: IAgentKeyBackend }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.graceMs = options?.graceMs ?? DEFAULT_GRACE_MS;
    this.backend = options?.backend ?? new MemoryAgentKeyBackend();
  }

  async issue(
    catId: CatId,
    userId: string,
    options?: { rotatedFrom?: string },
  ): Promise<{ agentKeyId: string; secret: string }> {
    const agentKeyId = `ak_${randomUUID().replace(/-/g, '')}`;
    const secret = randomBytes(32).toString('hex');
    const salt = randomBytes(16).toString('hex');
    const secretHash = createHash('sha256')
      .update(secret + salt)
      .digest('hex');
    const now = Date.now();

    await this.backend.create({
      agentKeyId,
      catId,
      userId,
      secretHash,
      salt,
      scope: 'user-bound',
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      ...(options?.rotatedFrom ? { rotatedFrom: options.rotatedFrom } : {}),
    });

    return { agentKeyId, secret };
  }

  async verify(secret: string): Promise<AgentKeyVerifyResult> {
    return this.backend.verify(secret);
  }

  async revoke(agentKeyId: string, reason: string): Promise<boolean> {
    return this.backend.revoke(agentKeyId, reason);
  }

  async rotate(agentKeyId: string): Promise<{ agentKeyId: string; secret: string }> {
    const old = await this.backend.get(agentKeyId);
    if (!old) throw new Error(`Agent key not found: ${agentKeyId}`);
    if (old.revokedAt) throw new Error(`Cannot rotate revoked key: ${agentKeyId}`);
    const now = Date.now();
    if (now > old.expiresAt) throw new Error(`Cannot rotate expired key: ${agentKeyId}`);
    if (old.graceUntil) {
      if (now > old.graceUntil) throw new Error(`Cannot rotate expired key: ${agentKeyId}`);
      throw new Error(`Cannot rotate key already in grace: ${agentKeyId}`);
    }

    const graceUntil = Date.now() + this.graceMs;
    await this.backend.updateGrace(agentKeyId, graceUntil);

    return this.issue(old.catId, old.userId, { rotatedFrom: agentKeyId });
  }

  async list(filter: { catId?: string; userId?: string; includeRevoked?: boolean }): Promise<AgentKeyRecord[]> {
    return this.backend.list(filter);
  }

  async get(agentKeyId: string): Promise<AgentKeyRecord | null> {
    return this.backend.get(agentKeyId);
  }

  private readonly clientMessageIds = new Map<string, number>();
  private static readonly DEDUP_TTL_MS = 60 * 60 * 1000;

  async claimClientMessageId(agentKeyId: string, clientMessageId: string): Promise<boolean> {
    const key = `${agentKeyId}:${clientMessageId}`;
    if (this.clientMessageIds.has(key)) return false;
    this.clientMessageIds.set(key, Date.now());
    if (this.clientMessageIds.size > 10_000) {
      const cutoff = Date.now() - AgentKeyRegistry.DEDUP_TTL_MS;
      for (const [k, ts] of this.clientMessageIds) {
        if (ts < cutoff) this.clientMessageIds.delete(k);
      }
    }
    return true;
  }
}
