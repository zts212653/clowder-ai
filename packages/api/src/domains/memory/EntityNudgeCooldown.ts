/**
 * F260 Phase B AC-B4: Entity nudge cooldown manager.
 *
 * In-memory cooldown tracker that suppresses repeated nudges for the same
 * entity for the same consumer in the same thread within 24 hours. This is a noise-control
 * mechanism — not a persistence layer.
 *
 * The map is a process-local cache. EntityNudgeEventStore hydrates it from
 * durable delivery rows after restart, still scoped to the same consumer.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import type { NudgePayload } from './EntityNudgeBuilder.js';

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

export class EntityNudgeCooldown {
  /** Map<compositeKey, lastNudgedTimestamp> */
  private readonly seen = new Map<string, number>();

  /** Check if an entity has ANY record in the cooldown map (for hydration gating). */
  hasRecord(entityKey: string, threadId: string, consumerCatId: string): boolean {
    return this.seen.has(this.compositeKey(entityKey, threadId, consumerCatId));
  }

  /** Check if an entity nudge is allowed (not in cooldown). */
  isAllowed(entityKey: string, threadId: string, consumerCatId: string, now: number): boolean {
    const key = this.compositeKey(entityKey, threadId, consumerCatId);
    const last = this.seen.get(key);
    if (last == null) return true;
    return now - last >= COOLDOWN_MS;
  }

  /** Record that an entity nudge was delivered. */
  record(entityKey: string, threadId: string, consumerCatId: string, now: number): void {
    const key = this.compositeKey(entityKey, threadId, consumerCatId);
    this.seen.set(key, now);
  }

  /** Record all entities from a delivered nudge batch. */
  recordAll(
    nudges: Pick<NudgePayload, 'entityId' | 'docAnchor'>[],
    threadId: string,
    consumerCatId: string,
    now: number,
  ): void {
    for (const n of nudges) {
      const entityKey = n.entityId ?? n.docAnchor;
      if (entityKey) this.record(entityKey, threadId, consumerCatId, now);
    }
  }

  /** Filter a nudge list, removing cooldown-suppressed entries. */
  filterNudges<T extends Pick<NudgePayload, 'entityId' | 'docAnchor'>>(
    nudges: T[],
    threadId: string,
    consumerCatId: string,
    now: number,
  ): T[] {
    return nudges.filter((n) => {
      const entityKey = n.entityId ?? n.docAnchor;
      if (!entityKey) return true;
      return this.isAllowed(entityKey, threadId, consumerCatId, now);
    });
  }

  private compositeKey(entityKey: string, threadId: string, consumerCatId: string): string {
    return `${threadId}::${consumerCatId}::${entityKey}`;
  }
}
