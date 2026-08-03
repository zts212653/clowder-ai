/**
 * F260 Phase B AC-B4: Entity nudge cooldown manager.
 *
 * In-memory cooldown tracker that suppresses repeated nudges for the same
 * entity in the same thread within 24 hours. This is a noise-control
 * mechanism — not a persistence layer.
 *
 * The cooldown state is per-process (in-memory Map). This is intentional:
 *   - Nudges are ephemeral typed metadata, not stored (AC-B6)
 *   - Process restart = cooldown reset = acceptable (user sees nudge again)
 *   - No Redis/DB writes required (aligns with AC-B3 zero-writes constraint)
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import type { NudgePayload } from './EntityNudgeBuilder.js';

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

export class EntityNudgeCooldown {
  /** Map<compositeKey, lastNudgedTimestamp> */
  private readonly seen = new Map<string, number>();

  /** Check if an entity has ANY record in the cooldown map (for hydration gating). */
  hasRecord(entityKey: string, threadId: string): boolean {
    return this.seen.has(this.compositeKey(entityKey, threadId));
  }

  /** Check if an entity nudge is allowed (not in cooldown). */
  isAllowed(entityKey: string, threadId: string, now: number): boolean {
    const key = this.compositeKey(entityKey, threadId);
    const last = this.seen.get(key);
    if (last == null) return true;
    return now - last >= COOLDOWN_MS;
  }

  /** Record that an entity nudge was delivered. */
  record(entityKey: string, threadId: string, now: number): void {
    const key = this.compositeKey(entityKey, threadId);
    this.seen.set(key, now);
  }

  /** Record all entities from a delivered nudge batch. */
  recordAll(nudges: Pick<NudgePayload, 'entityId' | 'docAnchor'>[], threadId: string, now: number): void {
    for (const n of nudges) {
      const entityKey = n.entityId ?? n.docAnchor;
      if (entityKey) this.record(entityKey, threadId, now);
    }
  }

  /** Filter a nudge list, removing cooldown-suppressed entries. */
  filterNudges<T extends Pick<NudgePayload, 'entityId' | 'docAnchor'>>(
    nudges: T[],
    threadId: string,
    now: number,
  ): T[] {
    return nudges.filter((n) => {
      const entityKey = n.entityId ?? n.docAnchor;
      if (!entityKey) return true;
      return this.isAllowed(entityKey, threadId, now);
    });
  }

  private compositeKey(entityKey: string, threadId: string): string {
    return `${threadId}::${entityKey}`;
  }
}
