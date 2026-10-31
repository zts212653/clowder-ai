import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AbstractiveResult } from '../abstractive-summary-types.js';

export interface LunaCurationState {
  ownerUserId: string;
  sessionId: string | null;
  providerIdentity: string;
  summaryRevision: string;
  directoryLine: string;
}

export function overviewRevision(summary: string | null): string {
  return createHash('sha256')
    .update(summary ?? '')
    .digest('hex');
}

/** Only committed model output may supply retained narrative; citation-shaped legacy text cannot. */
export function isCanonicalThreadOverview(
  db: Database.Database,
  owner: string,
  threadId: string,
  summary: string | null,
) {
  if (!summary) return false;
  const state = db
    .prepare(
      'SELECT provider_identity AS provider,summary_revision AS revision FROM thread_curation_state WHERE owner_user_id=? AND thread_id=?',
    )
    .get(owner, threadId) as { provider: string; revision: string } | undefined;
  if (state && state.provider !== 'initializing' && state.revision === overviewRevision(summary)) return true;
  return Boolean(
    db
      .prepare(`SELECT 1 FROM summary_segments WHERE thread_id=? AND summary=?
    AND prompt_version IN ('f321-luna-v1','f321-luna-overview-v2','f321-luna-overview-v3') LIMIT 1`)
      .get(threadId, summary),
  );
}

/** Taking the mapping invalidates it until the exact overview transaction commits.
 * Failed generation/commit/crash therefore rebuilds from canonical material. */
export function takeCurationSession(db: Database.Database, ownerUserId: string, threadId: string) {
  return db
    .transaction(() => {
      const row = db
        .prepare(`SELECT session_id AS sessionId, provider_identity AS providerIdentity,
      summary_revision AS summaryRevision FROM thread_curation_state WHERE owner_user_id = ? AND thread_id = ?`)
        .get(ownerUserId, threadId) as Omit<LunaCurationState, 'ownerUserId' | 'directoryLine'> | undefined;
      db.prepare('UPDATE thread_curation_state SET session_id = NULL WHERE owner_user_id = ? AND thread_id = ?').run(
        ownerUserId,
        threadId,
      );
      return row;
    })
    .immediate();
}

export function commitCurationState(
  db: Database.Database,
  threadId: string,
  result: Pick<AbstractiveResult, 'curationState'>,
) {
  const state = result.curationState;
  if (!state) return;
  db.prepare(`INSERT INTO thread_curation_state
    (owner_user_id,thread_id,session_id,provider_identity,summary_revision,directory_line)
    VALUES (?,?,?,?,?,?) ON CONFLICT(owner_user_id,thread_id) DO UPDATE SET
    session_id=excluded.session_id,provider_identity=excluded.provider_identity,
    summary_revision=excluded.summary_revision,directory_line=excluded.directory_line`).run(
    state.ownerUserId,
    threadId,
    state.sessionId,
    state.providerIdentity,
    state.summaryRevision,
    state.directoryLine,
  );
}

/** Only canonical same-thread coordinates can authorize retained previous facts. */
export function overviewSourceIds(summary: string | null, threadId: string): string[] {
  const ids: string[] = [];
  for (const coordinate of (summary ?? '').matchAll(/(?:来源：|，)([^#\s（）]+)#([^，\s（）]+)/gu)) {
    if (coordinate[1] === threadId) ids.push(coordinate[2]);
  }
  return [...new Set(ids)];
}
