import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { RecallSourceReaders } from './recall-candidate-view.js';

export const recallPageQuery = z
  .object({
    days: z.enum(['7', '14', '30']).default('7'),
    source: z.enum(['all', 'pull', 'push']).default('all'),
    catId: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(6000).optional(),
  })
  .strict();
export type RecallPageQuery = z.infer<typeof recallPageQuery>;
const cursorSchema = z
  .object({ to: z.number().int().nonnegative(), at: z.number().int().nonnegative(), key: z.string().min(1).max(4000) })
  .strict();
export type RecallPageCursor = z.infer<typeof cursorSchema>;

/** A cursor is bound to its owner and filters, and freezes the upper time boundary. */
export function recallPageCursors() {
  const secret = randomBytes(32);
  const signature = (body: string, owner: string, query: RecallPageQuery) =>
    createHmac('sha256', secret)
      .update(JSON.stringify([owner, query.days, query.source, query.catId ?? '', body]))
      .digest();
  return {
    encode(cursor: RecallPageCursor, owner: string, query: RecallPageQuery) {
      const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
      return `${body}.${signature(body, owner, query).toString('base64url')}`;
    },
    decode(owner: string, query: RecallPageQuery): RecallPageCursor | null | 'invalid' {
      if (!query.cursor) return null;
      try {
        const [body, mac, extra] = query.cursor.split('.');
        if (!body || !mac || extra) return 'invalid';
        const bytes = Buffer.from(mac, 'base64url');
        const expected = signature(body, owner, query);
        if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) return 'invalid';
        const cursor = cursorSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
        if (cursor.to > Date.now() || cursor.at > cursor.to || cursor.at < cursor.to - Number(query.days) * 86400000)
          return 'invalid';
        return cursor;
      } catch {
        return 'invalid';
      }
    },
  };
}

/** Revalidate indexed IDs; foreign/deleted threads cannot contribute names, rows, or counts. */
export async function visibleRecallThreads(owner: string, store: NonNullable<RecallSourceReaders['threadStore']>) {
  const ids = [...new Set((await store.list(owner)).map((thread) => thread.id))];
  const threads = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += 4) {
    const batch = await Promise.all(ids.slice(offset, offset + 4).map((id) => store.get(id)));
    for (const thread of batch) {
      if (thread && !thread.deletedAt && (canAccessThread(thread, owner) || thread.createdBy === 'system'))
        threads.set(thread.id, thread.title?.trim() || '未命名对话');
    }
  }
  return threads;
}
export interface RecallTimelineRow {
  key: string;
  at: number;
  thread_id: string;
  invocation_id: string;
  cue_id: string | null;
  recall_id: string | null;
}
export function recallTimeline(
  db: Database.Database,
  owner: string,
  threads: string[],
  query: RecallPageQuery,
  cursor: RecallPageCursor | null,
  to: number,
) {
  const from = to - Number(query.days) * 86400000;
  return db
    .prepare(`WITH visible AS (SELECT value AS id FROM json_each(@threads)), timeline AS (
    SELECT 'recall:' || recall_id AS key, timestamp AS at, thread_id, invocation_id, NULL AS cue_id, recall_id
    FROM recall_events WHERE thread_id IN (SELECT id FROM visible) AND timestamp BETWEEN @from AND @to
      AND (@source = 'all' OR source = @source) AND (@cat = '' OR cat_id = @cat)
    UNION ALL
    SELECT json_array('cue', thread_id, invocation_id, cue_id) AS key, MIN(occurred_at) AS at, thread_id, invocation_id, cue_id, NULL AS recall_id
    FROM memory_cue_events WHERE owner_user_id = @owner AND thread_id IN (SELECT id FROM visible)
      AND axis = 'consumption' AND consumption_outcome = 'presented'
      AND (@source = 'all' OR @source = 'push') AND (@cat = '' OR consumer_cat_id = @cat)
    GROUP BY thread_id, invocation_id, cue_id HAVING at BETWEEN @from AND @to
  ) SELECT * FROM timeline WHERE (@at IS NULL OR at < @at OR (at = @at AND key < @key))
    ORDER BY at DESC, key DESC LIMIT @limit`)
    .all({
      threads: JSON.stringify(threads),
      owner,
      source: query.source,
      cat: query.catId ?? '',
      from,
      to,
      at: cursor?.at ?? null,
      key: cursor?.key ?? '',
      limit: query.limit + 1,
    }) as RecallTimelineRow[];
}
