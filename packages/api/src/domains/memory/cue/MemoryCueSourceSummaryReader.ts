import type { RecallResolverFamily } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { MemoryCueEpisodeStore } from './MemoryCueEpisodeStore.js';
import { projectInvocationCues } from './project-invocation-cues.js';

export interface MemoryCueSourceSummary {
  resolverFamily: RecallResolverFamily;
  sourceAnchor: string;
  counts: { presented: number; drilled: number; applied: number; dismissed: number };
  latest: {
    threadId: string;
    invocationId: string;
    presentedAt: number;
    outcome: 'applied' | 'dismissed' | 'drilled' | 'presented_unreported' | 'invalidated';
  } | null;
}

interface CountRow {
  presented: number;
  drilled: number;
  applied: number;
  dismissed: number;
}

interface PresentedRow {
  cue_id: string;
  thread_id: string;
  invocation_id: string;
  consumer_cat_id: string;
  source_revision: string;
  occurred_at: number;
}

/** Read-only F287 ledger projection; all SQL starts at the authenticated owner key. */
export class MemoryCueSourceSummaryReader {
  private readonly episodeStore: MemoryCueEpisodeStore;

  constructor(private readonly db: Database.Database) {
    this.episodeStore = new MemoryCueEpisodeStore(db);
  }

  summarize(ownerUserId: string, resolverFamily: RecallResolverFamily, sourceAnchor: string): MemoryCueSourceSummary {
    const counts = this.db
      .prepare(`
      SELECT
        COUNT(CASE WHEN consumption_outcome = 'presented' THEN 1 END) AS presented,
        COUNT(CASE WHEN consumption_outcome = 'drilled' THEN 1 END) AS drilled,
        COUNT(CASE WHEN consumption_outcome = 'applied' THEN 1 END) AS applied,
        COUNT(CASE WHEN consumption_outcome = 'dismissed' THEN 1 END) AS dismissed
      FROM memory_cue_events
      WHERE owner_user_id = ? AND resolver_family = ? AND source_anchor = ?
    `)
      .get(ownerUserId, resolverFamily, sourceAnchor) as CountRow;

    const presented = this.db
      .prepare(`
      SELECT cue_id, thread_id, invocation_id, consumer_cat_id, source_revision, occurred_at
      FROM memory_cue_events
      WHERE owner_user_id = ? AND resolver_family = ? AND source_anchor = ?
        AND axis = 'consumption' AND consumption_outcome = 'presented'
      ORDER BY occurred_at DESC, rowid DESC LIMIT 1
    `)
      .get(ownerUserId, resolverFamily, sourceAnchor) as PresentedRow | undefined;

    if (!presented) return { resolverFamily, sourceAnchor, counts, latest: null };

    const cueEvents = this.episodeStore
      .listByCue(ownerUserId, presented.cue_id)
      .filter(
        (event) =>
          event.resolverFamily === resolverFamily &&
          event.sourceAnchor === sourceAnchor &&
          event.sourceRevision === presented.source_revision &&
          event.scope.threadId === presented.thread_id &&
          event.scope.invocationId === presented.invocation_id &&
          event.consumerCatId === presented.consumer_cat_id,
      );
    const cue = projectInvocationCues(cueEvents)[0];
    if (!cue) throw new Error('Presented memory cue is missing its source-scoped event');
    return {
      resolverFamily,
      sourceAnchor,
      counts,
      latest: {
        threadId: presented.thread_id,
        invocationId: presented.invocation_id,
        presentedAt: presented.occurred_at,
        outcome: cue.status,
      },
    };
  }
}
