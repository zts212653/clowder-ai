/**
 * CommunityReconciliationFindingStore — Redis-backed finding store (F168 Phase D)
 *
 * Stores reconciliation and SLA findings as operational read-model state.
 * No TTL — findings are persistent (铁律 #5 / LL-048).
 *
 * Redis layout (ioredis keyPrefix applied by client factory):
 *   community:reconciliation:finding:{findingId}           → HASH (finding fields)
 *   community:reconciliation:subject:{subjectKey}          → SET  (findingIds)
 *   community:reconciliation:index                         → SET  (all findingIds)
 *
 * Status lifecycle: open → acknowledged → resolved
 *                   open → waived (sticky unless evidence fingerprint changes)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingStatus = 'open' | 'acknowledged' | 'resolved' | 'waived';

export interface FindingWaiver {
  reason: string;
  actor: string;
  evidence: string;
}

export interface ReconciliationFinding {
  findingId: string;
  subjectKey: string;
  findingKind: string;
  severity: string;
  message: string;
  status: FindingStatus;
  waiver: FindingWaiver | null;
  /** Optional fingerprint to detect evidence changes for waiver reopening. */
  evidenceFingerprint: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FindingInput {
  findingId: string;
  subjectKey: string;
  findingKind: string;
  severity: string;
  message: string;
  evidenceFingerprint?: string;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const KEY_NS = 'community:reconciliation:';

function findingKey(findingId: string): string {
  return `${KEY_NS}finding:${findingId}`;
}

function subjectSetKey(subjectKey: string): string {
  return `${KEY_NS}subject:${subjectKey}`;
}

const INDEX_KEY = `${KEY_NS}index`;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CommunityReconciliationFindingStore {
  constructor(private readonly redis: RedisClient) {}

  // ─── Write operations ──────────────────────────────────────────────────

  /**
   * Idempotent upsert. Creates finding as 'open' if new.
   * If finding exists and is 'waived', only reopens if evidenceFingerprint changed.
   */
  async upsert(input: FindingInput): Promise<void> {
    const existing = await this.get(input.findingId);
    const now = Date.now();

    if (existing) {
      // Waived finding: only reopen if evidence fingerprint changed
      if (existing.status === 'waived') {
        const newFingerprint = input.evidenceFingerprint ?? null;
        if (newFingerprint && newFingerprint !== existing.evidenceFingerprint) {
          await this.redis.hmset(findingKey(input.findingId), {
            status: 'open',
            message: input.message,
            evidenceFingerprint: newFingerprint ?? '',
            waiver: '',
            updatedAt: String(now),
          });
        }
        // Otherwise stay waived — idempotent
        return;
      }
      // Resolved → reopen (drift recurred)
      if (existing.status === 'resolved') {
        await this.redis.hmset(findingKey(input.findingId), {
          status: 'open',
          message: input.message,
          evidenceFingerprint: input.evidenceFingerprint ?? '',
          updatedAt: String(now),
        });
        return;
      }
      // Already open/acknowledged — update message but keep status
      await this.redis.hmset(findingKey(input.findingId), {
        message: input.message,
        evidenceFingerprint: input.evidenceFingerprint ?? '',
        updatedAt: String(now),
      });
      return;
    }

    // New finding — create as open
    await this.redis.hmset(findingKey(input.findingId), {
      findingId: input.findingId,
      subjectKey: input.subjectKey,
      findingKind: input.findingKind,
      severity: input.severity,
      message: input.message,
      status: 'open',
      waiver: '',
      evidenceFingerprint: input.evidenceFingerprint ?? '',
      createdAt: String(now),
      updatedAt: String(now),
    });
    await this.redis.sadd(subjectSetKey(input.subjectKey), input.findingId);
    await this.redis.sadd(INDEX_KEY, input.findingId);
  }

  async acknowledge(findingId: string): Promise<void> {
    await this.redis.hmset(findingKey(findingId), {
      status: 'acknowledged',
      updatedAt: String(Date.now()),
    });
  }

  async resolve(findingId: string): Promise<void> {
    await this.redis.hmset(findingKey(findingId), {
      status: 'resolved',
      updatedAt: String(Date.now()),
    });
  }

  /**
   * Waive a finding with audit trail.
   * Rejects if reason/actor/evidence are empty strings.
   */
  async waive(findingId: string, waiver: FindingWaiver): Promise<void> {
    if (!waiver.reason) throw new Error('Waiver requires non-empty reason');
    if (!waiver.actor) throw new Error('Waiver requires non-empty actor');
    if (!waiver.evidence) throw new Error('Waiver requires non-empty evidence');

    await this.redis.hmset(findingKey(findingId), {
      status: 'waived',
      waiver: JSON.stringify(waiver),
      updatedAt: String(Date.now()),
    });
  }

  /**
   * Resolve all open/acknowledged findings for a subject that are NOT in
   * the `stillPresent` set. Waived findings are never auto-resolved.
   */
  async resolveAbsent(subjectKey: string, stillPresent: string[]): Promise<void> {
    const presentSet = new Set(stillPresent);
    const findingIds = await this.redis.smembers(subjectSetKey(subjectKey));
    for (const id of findingIds) {
      if (presentSet.has(id)) continue;
      const finding = await this.get(id);
      if (!finding) continue;
      if (finding.status === 'open' || finding.status === 'acknowledged') {
        await this.resolve(id);
      }
    }
  }

  // ─── Read operations ───────────────────────────────────────────────────

  async get(findingId: string): Promise<ReconciliationFinding | null> {
    const raw = await this.redis.hgetall(findingKey(findingId));
    if (!raw || !raw.findingId) return null;
    return deserializeFinding(raw);
  }

  async listBySubject(subjectKey: string): Promise<ReconciliationFinding[]> {
    const ids = await this.redis.smembers(subjectSetKey(subjectKey));
    const results: ReconciliationFinding[] = [];
    for (const id of ids) {
      const f = await this.get(id);
      if (f) results.push(f);
    }
    return results;
  }

  async listOpen(): Promise<ReconciliationFinding[]> {
    const allIds = await this.redis.smembers(INDEX_KEY);
    const results: ReconciliationFinding[] = [];
    for (const id of allIds) {
      const f = await this.get(id);
      if (f && (f.status === 'open' || f.status === 'acknowledged')) {
        results.push(f);
      }
    }
    return results;
  }

  /** Return all findings regardless of status (D-PR2 read-model contract for D-PR3 UX). */
  async listAll(): Promise<ReconciliationFinding[]> {
    const allIds = await this.redis.smembers(INDEX_KEY);
    const results: ReconciliationFinding[] = [];
    for (const id of allIds) {
      const f = await this.get(id);
      if (f) results.push(f);
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function deserializeFinding(raw: Record<string, string>): ReconciliationFinding {
  return {
    findingId: raw.findingId,
    subjectKey: raw.subjectKey,
    findingKind: raw.findingKind,
    severity: raw.severity,
    message: raw.message,
    status: raw.status as FindingStatus,
    waiver: raw.waiver ? JSON.parse(raw.waiver) : null,
    evidenceFingerprint: raw.evidenceFingerprint || null,
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
  };
}
