import type { MemoryReadUsage } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';

/** Read only durable, owner-bound successes. Missing historical direct reads stay unknown. */
export function readMemoryUsage(
  db: Database.Database,
  input: {
    owner: string;
    family: 'person_entity' | 'event';
    anchor: string;
    revision: string;
    cueRevision: string | null;
  },
): MemoryReadUsage {
  const observations = `WITH observations AS (
    SELECT e.event_id,r.occurred_at,r.consumer_cat_id,r.thread_id,e.source_revision,
      'direct_read' AS kind, e.memory_revision = @revision AS current_version
    FROM memory_direct_read_events e JOIN memory_direct_read_requests r ON r.request_key=e.request_key
    WHERE r.owner_user_id=@owner AND e.resolver_family=@family AND e.source_anchor=@anchor
    UNION ALL
    SELECT event_id,occurred_at,consumer_cat_id,thread_id,source_revision,'cue_drill' AS kind,
      source_revision = @cueRevision AS current_version FROM memory_cue_events
    WHERE owner_user_id=@owner AND resolver_family=@family AND source_anchor=@anchor
      AND axis='consumption' AND consumption_outcome='drilled'
  ), attributed AS (
    SELECT *, TRIM(consumer_cat_id) NOT IN ('', 'legacy-unbound') AS attributable FROM observations
  )`;
  return db.transaction(() => {
    const boundary = db.prepare('SELECT applied_at FROM schema_version WHERE version=82').get() as
      | { applied_at: string }
      | undefined;
    if (!boundary || !Number.isFinite(Date.parse(boundary.applied_at)))
      throw new Error('Memory read boundary unavailable');
    const groups = db
      .prepare(`${observations} SELECT attributable,current_version,
      COUNT(*) AS read, SUM(kind='direct_read') AS directRead, SUM(kind='cue_drill') AS cueDrill
      FROM attributed GROUP BY attributable,current_version`)
      .all(input) as Array<{
      attributable: number;
      current_version: number | null;
      read: number;
      directRead: number;
      cueDrill: number;
    }>;
    const totals = () => ({
      currentVersion: { read: 0, directRead: 0, cueDrill: 0 },
      allVersions: { read: 0, directRead: 0, cueDrill: 0 },
    });
    const verified = totals(),
      recordedUnattributed = totals();
    for (const group of groups) {
      const counts = group.attributable ? verified : recordedUnattributed;
      for (const key of ['read', 'directRead', 'cueDrill'] as const) {
        counts.allVersions[key] += group[key];
        if (group.current_version) counts.currentVersion[key] += group[key];
      }
    }
    const recent = db
      .prepare(`${observations} SELECT * FROM attributed WHERE attributable AND current_version
      ORDER BY occurred_at DESC,event_id DESC LIMIT 10`)
      .all(input) as Array<{
      event_id: string;
      occurred_at: number;
      consumer_cat_id: string;
      thread_id: string | null;
      source_revision: string;
      kind: 'direct_read' | 'cue_drill';
    }>;
    return {
      sourceAnchor: input.anchor,
      revision: input.revision,
      ...verified,
      recordedUnattributed,
      historyComplete: false as const,
      unverifiedReadCount: null,
      directReadRecordedSince: Date.parse(boundary.applied_at),
      recent: recent.map((r) => ({
        eventId: r.event_id,
        occurredAt: r.occurred_at,
        catId: r.consumer_cat_id,
        threadId: r.thread_id,
        sourceRevision: r.source_revision,
        kind: r.kind,
      })),
    };
  })();
}
