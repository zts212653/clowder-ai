import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { normalizeTranscriptEvent } from '../TranscriptEventEnvelope.js';
import { materializeFilesTouched, type TranscriptFileTouch } from '../transcript-file-touches.js';
import { updateCanonicalInvocationIndex } from './transcript-invocation-canonical-index.js';
import {
  beginTranscriptIndexUpdate,
  TRANSCRIPT_INVOCATION_INDEX_SCHEMA,
} from './transcript-invocation-index-schema.js';
import type {
  IndexedEventPointer,
  IndexedInvocationPage,
  InvocationIndexDiagnostics,
  InvocationIndexRequest,
  InvocationIndexResponse,
  SessionIndexInput,
} from './transcript-invocation-index-types.js';
import { type IndexedSource, updateTranscriptSourceIndex } from './transcript-invocation-source-index.js';

const compare = (a: InvocationTrajectorySummary, b: InvocationTrajectorySummary) =>
  b.startedAt - a.startedAt || a.invocationId.localeCompare(b.invocationId);

function collectLatest(db: Database.Database, limit: number, output: InvocationIndexResponse): void {
  output.total += (db.prepare('SELECT COUNT(*) AS count FROM summaries').get() as { count: number }).count;
  for (const row of db.prepare('SELECT projection FROM summaries ORDER BY started_at DESC').iterate() as Iterable<{
    projection: string;
  }>) {
    const summary = JSON.parse(row.projection) as InvocationTrajectorySummary;
    const last = output.invocations.at(-1);
    if (output.invocations.length === limit && last && summary.startedAt < last.startedAt) break;
    output.invocations.push(summary);
    output.invocations.sort(compare);
    if (output.invocations.length > limit) output.invocations.pop();
  }
}

async function readInvocationPage(
  db: Database.Database,
  input: SessionIndexInput,
  sources: IndexedSource[],
  query: Extract<InvocationIndexRequest['query'], { kind: 'invocation' }>,
  diagnostics: InvocationIndexDiagnostics,
): Promise<IndexedInvocationPage> {
  const total = (
    db.prepare('SELECT COUNT(*) AS count FROM canonical WHERE invocation_id = ?').get(query.invocationId) as {
      count: number;
    }
  ).count;
  const page: IndexedInvocationPage = { sessionId: input.session.id, events: [], total };
  const summary = db.prepare('SELECT projection FROM summaries WHERE invocation_id = ?').get(query.invocationId) as
    | { projection: string }
    | undefined;
  if (summary) page.summary = JSON.parse(summary.projection) as InvocationTrajectorySummary;
  const start = db
    .prepare(`SELECT MIN(logical_no) AS start FROM canonical
    WHERE invocation_id = ? AND event_no >= ?`)
    .get(query.invocationId, query.cursor ?? 0) as { start: number | null };
  if (start.start === null) return page;
  const rows = db
    .prepare(`SELECT source, seq, event_no, byte_offset, byte_length FROM canonical
    WHERE invocation_id = ? AND logical_no >= ? ORDER BY logical_no LIMIT ?`)
    .iterate(
      query.invocationId,
      start.start,
      query.limit === undefined ? -1 : query.limit + 1,
    ) as Iterable<IndexedEventPointer>;
  for (const row of rows) {
    if (query.limit !== undefined && page.events.length === query.limit) {
      page.nextCursor = { eventNo: row.event_no };
      break;
    }
    if (row.source === 2) {
      page.events.push({ bufferIndex: row.seq, eventNo: row.event_no });
      continue;
    }
    const file = sources[row.source]?.file;
    if (!file) throw new Error('Transcript source disappeared during indexed read');
    const bytes = Buffer.alloc(row.byte_length);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, row.byte_offset + offset);
      if (bytesRead === 0) throw new Error('Transcript changed during indexed read');
      offset += bytesRead;
    }
    diagnostics.hydratedBytes += bytes.length;
    const event = normalizeTranscriptEvent(JSON.parse(bytes.toString('utf8')));
    if (!event || event.invocationId !== query.invocationId)
      throw new Error('Transcript index no longer matches its source');
    if (row.source === 1) {
      const { cliSessionId: _, ...rest } = event;
      page.events.push({
        event: {
          ...rest,
          v: 1,
          threadId: input.session.threadId,
          catId: input.session.catId,
          sessionId: input.session.id,
          eventNo: row.event_no,
          ...(input.session.cliSessionId ? { cliSessionId: input.session.cliSessionId } : {}),
        },
      });
    } else page.events.push({ event: { ...event, eventNo: row.event_no } });
  }
  return page;
}

function collectLiveFileTouches(db: Database.Database, input: SessionIndexInput): TranscriptFileTouch[] {
  const files = new Map<string, Set<string>>();
  const add = (touches: TranscriptFileTouch[]) => {
    for (const touch of touches) {
      const ops = files.get(touch.path) ?? new Set<string>();
      for (const op of touch.ops) ops.add(op);
      files.set(touch.path, ops);
    }
  };
  const rows = db
    .prepare('SELECT files_touched FROM source_events WHERE source = 1 ORDER BY seq')
    .iterate() as Iterable<{
    files_touched: string;
  }>;
  for (const row of rows) add(JSON.parse(row.files_touched) as TranscriptFileTouch[]);
  for (const buffered of input.buffered) add(buffered.filesTouched);
  return materializeFilesTouched(files);
}

async function readSessionIndex(
  input: SessionIndexInput,
  query: InvocationIndexRequest['query'],
  persistent: boolean,
): Promise<InvocationIndexResponse> {
  if (persistent) await mkdir(input.directory, { recursive: true });
  const db = new Database(persistent ? join(input.directory, 'invocations.v1.sqlite') : ':memory:', { timeout: 0 });
  const output = emptyResponse();
  const sources: IndexedSource[] = [];
  try {
    await beginTranscriptIndexUpdate(db);
    db.exec(TRANSCRIPT_INVOCATION_INDEX_SCHEMA);
    // Seal publishes canonical before deleting live. Observe live first so a seal
    // between the two opens cannot make both sources appear absent. Keep the
    // opened live handle until hydration finishes, even after the writer unlinks it.
    sources[1] = input.includeLive
      ? await updateTranscriptSourceIndex(db, 1, join(input.directory, 'events.live.jsonl'), output.diagnostics)
      : { file: null, signature: 'not-read' };
    sources[0] =
      query.kind === 'files'
        ? { file: null, signature: 'not-read' }
        : await updateTranscriptSourceIndex(db, 0, join(input.directory, 'events.jsonl'), output.diagnostics);
    if (query.kind === 'files') {
      output.filesTouched.push(...collectLiveFileTouches(db, input));
    } else {
      updateCanonicalInvocationIndex(
        db,
        input,
        sources.map((source) => source.signature),
        output.diagnostics,
      );
      if (query.kind === 'list') collectLatest(db, query.limit, output);
      else output.pages.push(await readInvocationPage(db, input, sources, query, output.diagnostics));
    }
    db.exec('COMMIT');
    return output;
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
    await Promise.all(sources.map((source) => source.file?.close()));
  }
}

function emptyResponse(): InvocationIndexResponse {
  return {
    invocations: [],
    total: 0,
    pages: [],
    diagnostics: { sourceBytesScanned: 0, hydratedBytes: 0, summaryCacheHits: 0 },
    filesTouched: [],
  };
}

async function readSession(input: SessionIndexInput, query: InvocationIndexRequest['query']) {
  try {
    return await readSessionIndex(input, query, true);
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (!/^(SQLITE_(CORRUPT|NOTADB|READONLY|CANTOPEN)(_|$)|EACCES$|EPERM$)/.test(code)) throw error;
    // The cache is disposable; a corrupt or unwritable cache must never hide intact source records.
    // Do not unlink a cache another reader may have open, or mutate the canonical JSONL to repair it.
    return readSessionIndex(input, query, false);
  }
}

/** Called in one bounded worker for the entire authorized request, not one worker per session. */
export async function readTranscriptInvocationIndex(request: InvocationIndexRequest): Promise<InvocationIndexResponse> {
  const output = emptyResponse();
  for (const session of request.sessions) {
    const result = await readSession(session, request.query);
    output.total += result.total;
    output.pages.push(...result.pages);
    output.filesTouched.push(...result.filesTouched);
    output.invocations.push(...result.invocations);
    output.invocations.sort(compare);
    if (request.query.kind === 'list')
      output.invocations.length = Math.min(output.invocations.length, request.query.limit);
    output.diagnostics.sourceBytesScanned += result.diagnostics.sourceBytesScanned;
    output.diagnostics.hydratedBytes += result.diagnostics.hydratedBytes;
    output.diagnostics.summaryCacheHits += result.diagnostics.summaryCacheHits;
  }
  return output;
}
