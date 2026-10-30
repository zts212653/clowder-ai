import type { ProfileUsageSummary } from '@cat-cafe/shared';
import { CURRENT_CORPUS_PROFILE_URI, CURRENT_RELATIONSHIP_PROFILE_URI } from '@cat-cafe/shared/profile-contract';
import { readProfileOpeningReference } from '@cat-cafe/shared/profile-opening-reference';
import type Database from 'better-sqlite3';
import type { StoredProfileMemoryEntry } from './ProfileMemoryLifecycleStore.js';

interface UsageRow {
  event_id: string;
  kind: 'opening' | 'read';
  occurred_at: number;
  source_revision: string;
  consumer_cat_id: string;
  thread_id: string | null;
}
/** The old relationship URI named the capsule. Persona primers have explicit, consumer-bound anchors. */
function cueIdentity(entry: StoredProfileMemoryEntry) {
  if (entry.layer === 'primer') {
    if (!entry.relationshipKey) throw new Error('Profile relationship identity unavailable');
    return {
      opening: `profile:opening-primer:${encodeURIComponent(entry.relationshipKey)}:`,
      ordinary: `profile:primer:${encodeURIComponent(entry.relationshipKey)}:`,
      persona: 1,
    };
  }
  return {
    opening: entry.layer === 'capsule' ? 'profile:opening-capsule' : '',
    ordinary: `profile:${entry.layer === 'capsule' ? CURRENT_RELATIONSHIP_PROFILE_URI : CURRENT_CORPUS_PROFILE_URI}`,
    persona: 0,
  };
}

export function readProfileUsage(
  db: Database.Database,
  ownerUserId: string,
  entry: StoredProfileMemoryEntry,
): ProfileUsageSummary {
  const identity = cueIdentity(entry);
  const parameters = { owner: ownerUserId, memory: entry.id, revision: entry.revision, ...identity };
  // Existing cue events remain authoritative for opening delivery and successful drills.
  // A direct read has no invented 'presented' cue or invented thread for an agent-key caller.
  const observations = `WITH observations AS (
    SELECT event_id, 'read' AS kind, occurred_at, source_revision, consumer_cat_id, thread_id
      FROM profile_read_events WHERE owner_user_id = @owner AND memory_id = @memory
    UNION ALL
    SELECT event_id, CASE WHEN consumption_outcome = 'presented' THEN 'opening' ELSE 'read' END AS kind,
      occurred_at, source_revision, consumer_cat_id, thread_id FROM memory_cue_events
      WHERE owner_user_id = @owner AND resolver_family = 'profile' AND axis = 'consumption'
      AND ((consumption_outcome = 'presented' AND @opening != '' AND
        source_anchor = @opening || CASE WHEN @persona = 1 THEN consumer_cat_id ELSE '' END)
      OR (consumption_outcome = 'drilled' AND
        (source_anchor = @ordinary || CASE WHEN @persona = 1 THEN consumer_cat_id ELSE '' END
        OR (@opening != '' AND source_anchor = @opening || CASE WHEN @persona = 1 THEN consumer_cat_id ELSE '' END))))
  )`;
  return db.transaction(() => {
    const row = db
      .prepare(`${observations} SELECT
      COUNT(CASE WHEN kind = 'opening' THEN 1 END) AS opening,
      COUNT(CASE WHEN kind = 'read' THEN 1 END) AS read,
      COUNT(CASE WHEN kind = 'opening' AND source_revision = @revision THEN 1 END) AS current_opening,
      COUNT(CASE WHEN kind = 'read' AND source_revision = @revision THEN 1 END) AS current_read,
      MIN(occurred_at) AS earliest FROM observations`)
      .get(parameters) as {
      opening: number;
      read: number;
      current_opening: number;
      current_read: number;
      earliest: number | null;
    };
    const boundary = db.prepare('SELECT applied_at FROM schema_version WHERE version = 74').get() as
      | { applied_at: string }
      | undefined;
    if (!boundary || !Number.isFinite(Date.parse(boundary.applied_at)))
      throw new Error('Profile recording boundary unavailable');
    const recent = db
      .prepare(`${observations} SELECT * FROM observations
      WHERE source_revision = @revision ORDER BY occurred_at DESC, event_id DESC LIMIT 10`)
      .all(parameters) as UsageRow[];
    return {
      memoryId: entry.id,
      revision: entry.revision,
      openingMode:
        entry.layer === 'capsule' || (entry.layer === 'primer' && readProfileOpeningReference(entry.content))
          ? ('enabled' as const)
          : ('on_demand' as const),
      currentVersion: { opening: row.current_opening, read: row.current_read },
      allVersions: { opening: row.opening, read: row.read },
      historyComplete: false as const,
      directReadRecordedSince: Date.parse(boundary.applied_at),
      earliestRecordedAt: row.earliest,
      recent: recent.map((item) => ({
        eventId: item.event_id,
        kind: item.kind,
        occurredAt: item.occurred_at,
        sourceRevision: item.source_revision,
        catId: item.consumer_cat_id,
        threadId: item.thread_id,
      })),
    };
  })();
}
