import { createHash } from 'node:crypto';
import type { AgentKeyRecord, AgentKeyVerifyResult } from '@cat-cafe/shared';
import type { AgentKeyInput, IAgentKeyBackend } from './IAgentKeyBackend.js';

export class MemoryAgentKeyBackend implements IAgentKeyBackend {
  private records = new Map<string, AgentKeyRecord>();
  private readonly clientMessageIds = new Map<string, number>();
  private static readonly DEDUP_TTL_MS = 60 * 60 * 1000;

  async create(input: AgentKeyInput): Promise<void> {
    this.records.set(input.agentKeyId, { ...input });
  }

  async verify(secret: string): Promise<AgentKeyVerifyResult> {
    for (const record of this.records.values()) {
      const hash = createHash('sha256')
        .update(secret + record.salt)
        .digest('hex');
      if (hash === record.secretHash) return this.verifyRecord(record);
    }
    return { ok: false, reason: 'agent_key_unknown' };
  }

  private verifyRecord(record: AgentKeyRecord): AgentKeyVerifyResult {
    if (record.revokedAt) return { ok: false, reason: 'agent_key_revoked' };
    const now = Date.now();
    if (record.graceUntil && now > record.graceUntil) return { ok: false, reason: 'agent_key_expired' };
    if (!record.graceUntil && now > record.expiresAt) return { ok: false, reason: 'agent_key_expired' };
    record.lastUsedAt = now;
    return { ok: true, record: { ...record } };
  }

  async get(agentKeyId: string): Promise<AgentKeyRecord | null> {
    const record = this.records.get(agentKeyId);
    return record ? { ...record } : null;
  }

  async list(filter: { catId?: string; userId?: string; includeRevoked?: boolean }): Promise<AgentKeyRecord[]> {
    const results: AgentKeyRecord[] = [];
    for (const record of this.records.values()) {
      if (filter.catId && record.catId !== filter.catId) continue;
      if (filter.userId && record.userId !== filter.userId) continue;
      if (!filter.includeRevoked && record.revokedAt) continue;
      results.push({ ...record });
    }
    return results;
  }

  async revoke(agentKeyId: string, reason: string): Promise<boolean> {
    const record = this.records.get(agentKeyId);
    if (!record) return false;
    record.revokedAt = Date.now();
    record.revokedReason = reason;
    return true;
  }

  async updateGrace(agentKeyId: string, graceUntil: number): Promise<boolean> {
    const record = this.records.get(agentKeyId);
    if (!record) return false;
    record.graceUntil = graceUntil;
    return true;
  }

  async touchLastUsed(agentKeyId: string, timestamp: number): Promise<void> {
    const record = this.records.get(agentKeyId);
    if (record) record.lastUsedAt = timestamp;
  }

  async claimClientMessageId(agentKeyId: string, clientMessageId: string): Promise<boolean> {
    if (!this.records.has(agentKeyId)) return false;
    const key = `${agentKeyId}:${clientMessageId}`;
    if (this.clientMessageIds.has(key)) return false;
    this.clientMessageIds.set(key, Date.now());
    if (this.clientMessageIds.size > 10_000) {
      const cutoff = Date.now() - MemoryAgentKeyBackend.DEDUP_TTL_MS;
      for (const [k, ts] of this.clientMessageIds) {
        if (ts < cutoff) this.clientMessageIds.delete(k);
      }
    }
    return true;
  }
}
