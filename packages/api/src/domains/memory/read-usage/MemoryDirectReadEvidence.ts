import { createHash } from 'node:crypto';
import type { CallbackPrincipal } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';

export interface MemoryReadItem {
  family: 'person_entity' | 'event';
  anchor: string;
  sourceRevision: string;
  memoryRevision: string;
}
export class MemoryDirectReadConflict extends Error {}
const stableJson = (value: unknown) =>
  JSON.stringify(value, (_key: string, part: unknown) =>
    part && typeof part === 'object' && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)))
      : part,
  );
const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');

/** One verified consumer turn: refreshes replay together; cats, owners and origins never share state. */
export function memoryReadConsumerScope(principal: CallbackPrincipal): string {
  const consumer = [principal.userId, principal.catId, principal.kind];
  return JSON.stringify(
    principal.kind === 'invocation'
      ? [...consumer, principal.threadId, principal.parentInvocationId ?? principal.invocationId]
      : [...consumer, principal.agentKeyId],
  );
}

/** Retries retain the first observation; changing the returned set/version never rewrites it. */
export function recordMemoryDirectRead(
  db: Database.Database,
  principal: CallbackPrincipal,
  requestId: string,
  items: readonly MemoryReadItem[],
  requestSemantics: unknown,
): void {
  const ordered = [...new Map(items.map((item) => [stableJson(item), item])).values()].sort((a, b) =>
    stableJson(a).localeCompare(stableJson(b)),
  );
  const key = hash([principal.userId, principal.catId, requestId]);
  const digest = hash([memoryReadConsumerScope(principal), requestSemantics, ordered]);
  db.transaction(() => {
    const prior = db.prepare('SELECT request_digest FROM memory_direct_read_requests WHERE request_key = ?').get(key) as
      | { request_digest: string }
      | undefined;
    if (prior) {
      if (prior.request_digest !== digest) throw new MemoryDirectReadConflict('memory_read_request_changed');
      return;
    }
    db.prepare(`INSERT INTO memory_direct_read_requests
      (request_key,owner_user_id,consumer_cat_id,principal_kind,thread_id,invocation_id,request_digest,occurred_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      key,
      principal.userId,
      principal.catId,
      principal.kind,
      principal.kind === 'invocation' ? principal.threadId : null,
      principal.kind === 'invocation' ? (principal.parentInvocationId ?? principal.invocationId) : null,
      digest,
      Date.now(),
    );
    const insert = db.prepare(`INSERT INTO memory_direct_read_events
      (event_id,request_key,resolver_family,source_anchor,source_revision,memory_revision) VALUES (?,?,?,?,?,?)`);
    for (const item of ordered)
      insert.run(
        `memory-read-${hash([key, item.anchor, item.sourceRevision])}`,
        key,
        item.family,
        item.anchor,
        item.sourceRevision,
        item.memoryRevision,
      );
  }).immediate();
}
