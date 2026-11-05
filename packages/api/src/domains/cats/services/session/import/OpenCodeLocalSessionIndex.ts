import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  humanSessionFirstLine,
  isCatCafeSessionInput,
  isLocalSessionId,
  LOCAL_SESSION_CANDIDATE_LIMIT,
} from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { resolveOpenCodeDbCandidates } from '../../agents/providers/opencode-recovery.js';
import type { LocalSessionList, LocalSessionMetadata } from '../../types.js';

/** Approved list-only projection: one indexed user message / one non-synthetic text part. */
function firstUserPreview(db: Database.Database, sessionId: string): string {
  try {
    const row = db
      .prepare(
        "SELECT substr(json_extract(data, '$.text'), 1, 2000) AS text FROM part INDEXED BY part_message_id_id_idx WHERE message_id = (SELECT id FROM message INDEXED BY message_session_time_created_id_idx WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created, id LIMIT 1) AND json_extract(data, '$.type') = 'text' AND coalesce(json_extract(data, '$.synthetic'), 0) = 0 ORDER BY id LIMIT 1",
      )
      .get(sessionId) as { text: string | null } | undefined;
    return typeof row?.text === 'string' ? row.text : '';
  } catch {
    // Missing/invalid native preview metadata leaves the original title/empty fallback intact.
    return '';
  }
}

/** Use the same database precedence as the execution adapter; never create or migrate native data. */
export function resolveOpenCodeLocalIndex(): string {
  const candidate = resolveOpenCodeDbCandidates().find((entry) => existsSync(entry.path));
  if (!candidate) throw new Error('OpenCode session index unavailable');
  return candidate.path;
}

export function readOpenCodeLocalSessions(
  path: string,
  selection: { limit: number } | { sessionId: string },
): LocalSessionList {
  if (
    'limit' in selection &&
    (!Number.isInteger(selection.limit) || selection.limit < 1 || selection.limit > LOCAL_SESSION_CANDIDATE_LIMIT)
  )
    throw new Error('Invalid recent-session limit');
  if ('sessionId' in selection && !isLocalSessionId('opencode', selection.sessionId))
    throw new Error('Invalid OpenCode session ID');
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    // Session metadata has no first-human-input field. The accepted bounded first-part
    // read is list-only: it is never copied into preflight/bind metadata or native history.
    const rows = (
      'sessionId' in selection
        ? db.prepare('SELECT id, directory, time_updated, parent_id FROM session WHERE id = ?').all(selection.sessionId)
        : db
            .prepare(
              'SELECT id, directory, time_updated, parent_id FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_updated DESC LIMIT ?',
            )
            .all(LOCAL_SESSION_CANDIDATE_LIMIT + 1)
    ) as {
      id: string;
      directory: string;
      time_updated: number;
      parent_id: string | null;
    }[];
    if ('sessionId' in selection && rows[0]?.parent_id != null)
      throw Object.assign(new Error('Subagent sessions cannot be imported. Choose the original parent session.'), {
        code: 'SESSION_NOT_TOP_LEVEL',
      });
    const limit = 'limit' in selection ? selection.limit : 1;
    const sessions: LocalSessionMetadata[] = rows.slice(0, LOCAL_SESSION_CANDIDATE_LIMIT).flatMap((row) => {
      if (!isLocalSessionId('opencode', row.id) || !isAbsolute(row.directory) || !Number.isFinite(row.time_updated))
        return [];
      const preview = 'limit' in selection ? firstUserPreview(db, row.id) : '';
      if ('limit' in selection && isCatCafeSessionInput(preview)) return [];
      return [
        {
          sessionId: row.id,
          clientId: 'opencode',
          projectPath: row.directory,
          firstPrompt: humanSessionFirstLine(preview),
          lastActivityAt: row.time_updated,
          turnCount: null,
        },
      ];
    });
    if ('sessionId' in selection && sessions.length !== 1) throw new Error('OpenCode session metadata unavailable');
    return {
      sessions: sessions.slice(0, limit),
      limited: rows.length > LOCAL_SESSION_CANDIDATE_LIMIT || sessions.length > limit,
    };
  } finally {
    db.close();
  }
}
