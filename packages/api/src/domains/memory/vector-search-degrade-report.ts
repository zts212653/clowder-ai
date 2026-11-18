// Why a vector search fell back to lexical.
//
// The fallback is deliberate: search keeps answering. But the catch that
// performs it used to drop the error, so a degraded search left no trace of
// what failed (2026-11-15: a hybrid search degraded 94 ms after its query was
// embedded successfully, and nothing recorded the reason).
//
// Privacy rule for the record: every field is drawn from a vocabulary fixed in
// this file. Nothing is copied or hashed from the error's text, because that
// text can carry the query (a provider response that echoes its input, a SQL
// fragment). That rules out a throw site read from error.stack, whose leading
// lines are the message, and a fingerprint of the message, which a reader can
// test candidate queries against. Two errors that differ only in such text
// produce identical records.
//
// Searches on file-backed stores run in a read worker whose stderr is dropped
// when the job succeeds, and a degraded search succeeds. So the worker reports
// over its existing read-diagnostic IPC, and the parent publishes here. The
// store, the worker and the process pool stay free of any logger; the API
// subscribes once at its composition root.
//
// A search whose vectors were retired by a source write is read once more (see
// SqliteEvidenceStore.runProjectionRead). Its records then carry `operationId`
// and `attempt`, and a VectorReadRepeatRecord with the same id says how the
// search ended. A record without `attempt` is still the final state of its
// search. The id is random; it is not derived from the query or from any error.

import { channel, subscribe, unsubscribe } from 'node:diagnostics_channel';

export type VectorSearchDegradeStage =
  | 'vector_generation_open'
  | 'embedding_availability'
  | 'passage_embedding_availability'
  | 'summary_semantic'
  | 'summary_hybrid'
  | 'raw_passage_semantic'
  | 'raw_passage_hybrid'
  | 'message_passage_semantic'
  | 'message_passage_hybrid'
  /** The parent found the projection retired when the worker's vector result arrived. */
  | 'projection_publication';

export interface VectorSearchDegradeRecord {
  /** The catch that swallowed the failure: a coordinate chosen by our code, not read from the error. */
  stage: VectorSearchDegradeStage;
  /** A listed error class, `other`, or `non_error`. */
  errorName: string;
  /** A listed code, `other` for an unlisted one, or null when the error has none. */
  errorCode: string | null;
  errorCategory: string;
  /** Present only on an attempt of a search that a source write retired. */
  operationId?: string;
  attempt?: 1 | 2;
}

/** Final search outcome after its one permitted repeat, including an enclosing budget's lexical read. */
export type VectorReadRepeatOutcome =
  /** The repeat returned vectors under a snapshot that was still current. */
  | 'recovered'
  /** The repeat lost its vectors too. */
  | 'degraded_again'
  /** The repeat ran out of its own time, or failed. */
  | 'repeat_stopped'
  /** Not attempted: less than three times the first attempt's duration was left. */
  | 'skipped_budget'
  /** Not attempted: the projection or its provider was no longer servable. */
  | 'skipped_unavailable'
  /** The caller cancelled, or the search's own deadline passed, before the final result. */
  | 'cancelled'
  /** The enclosing message vector budget expired and its final lexical read succeeded. */
  | 'vector_budget_exhausted'
  /** The final lexical read failed, so no degraded answer was returned. */
  | 'lexical_failed';

export interface VectorReadRepeatRecord {
  operationId: string;
  outcome: VectorReadRepeatOutcome;
  firstAttemptMs: number;
  /** Null when no repeat was started. */
  repeatMs: number | null;
}

const ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'SqliteError',
]);

const SYSTEM_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

// Extended SQLite codes collapse to their primary code (SQLITE_BUSY_SNAPSHOT -> SQLITE_BUSY).
const SQLITE_PRIMARY_CODES: readonly string[] = [
  'SQLITE_ERROR',
  'SQLITE_INTERNAL',
  'SQLITE_PERM',
  'SQLITE_ABORT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
  'SQLITE_INTERRUPT',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_NOTFOUND',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_SCHEMA',
  'SQLITE_TOOBIG',
  'SQLITE_CONSTRAINT',
  'SQLITE_MISMATCH',
  'SQLITE_MISUSE',
  'SQLITE_AUTH',
  'SQLITE_RANGE',
  'SQLITE_NOTADB',
];

// The fixed messages our own code throws on the vector path. Only the label is kept.
const MESSAGE_CATEGORIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Vector projection is not ready/, 'vector_projection_not_ready'],
  [/^Vector generation /, 'vector_generation_unavailable'],
  [/^(?:EmbeddingService not ready|Embedding service unavailable)/, 'embedding_not_ready'],
  [/^fetch failed/, 'embed_api_unreachable'],
  [/^(?:Embedding |Invalid embedding |Embed API omitted )/, 'embedding_response_or_identity'],
];

function listedName(name: unknown): string {
  return typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'other';
}

function listedCode(code: unknown): string | null {
  if (code === undefined || code === null) return null;
  if (typeof code !== 'string') return 'other';
  if (SYSTEM_CODES.has(code)) return code;
  return SQLITE_PRIMARY_CODES.find((primary) => code === primary || code.startsWith(`${primary}_`)) ?? 'other';
}

function categorize(name: string, code: string | null, message: string): string {
  const status = /^Embed API error: (\d{3})\b/.exec(message);
  if (status) {
    const value = Number(status[1]);
    return value >= 100 && value <= 599 ? `embed_api_http_${value}` : 'embed_api_http_other';
  }
  for (const [pattern, label] of MESSAGE_CATEGORIES) if (pattern.test(message)) return label;
  if (name === 'AbortError' || name === 'TimeoutError') return 'aborted_or_timed_out';
  if (name === 'SqliteError' || code?.startsWith('SQLITE_')) return 'sqlite';
  return 'other';
}

export function describeVectorSearchFailure(
  stage: VectorSearchDegradeStage,
  error: unknown,
): VectorSearchDegradeRecord {
  if (!(error instanceof Error)) return { stage, errorName: 'non_error', errorCode: null, errorCategory: 'other' };
  const errorName = listedName(error.name);
  const errorCode = listedCode((error as { code?: unknown }).code);
  return { stage, errorName, errorCode, errorCategory: categorize(errorName, errorCode, String(error.message)) };
}

const CHANNEL = 'cat-cafe.memory-vector-search-degrade';
const degrades = channel(CHANNEL);

/** Once per degraded search: where it ran in this process, or where a read worker's report arrives. */
export function publishVectorSearchDegrade(record: VectorSearchDegradeRecord): void {
  degrades.publish(record);
}

export function onVectorSearchDegrade(listener: (record: VectorSearchDegradeRecord) => void): () => void {
  const onMessage = (record: unknown) => listener(record as VectorSearchDegradeRecord);
  subscribe(CHANNEL, onMessage);
  return () => {
    unsubscribe(CHANNEL, onMessage);
  };
}

const REPEAT_CHANNEL = 'cat-cafe.memory-vector-read-repeat';
const repeats = channel(REPEAT_CHANNEL);

export function publishVectorReadRepeat(record: VectorReadRepeatRecord): void {
  repeats.publish(record);
}

export function onVectorReadRepeat(listener: (record: VectorReadRepeatRecord) => void): () => void {
  const onMessage = (record: unknown) => listener(record as VectorReadRepeatRecord);
  subscribe(REPEAT_CHANNEL, onMessage);
  return () => {
    unsubscribe(REPEAT_CHANNEL, onMessage);
  };
}

/** The API's one subscription: a warning per degraded search, per lost attempt, and per repeat outcome. */
export function logVectorSearchDegradesTo(log: { warn(fields: object, message: string): void }): () => void {
  const stopDegrades = onVectorSearchDegrade((record) =>
    log.warn(
      { module: 'memory-vector-search', ...record },
      record.attempt ? 'Vector search attempt lost its vectors to a source write' : 'Vector search degraded to lexical',
    ),
  );
  const stopRepeats = onVectorReadRepeat((record) =>
    log.warn({ module: 'memory-vector-search', ...record }, 'Vector search was read again after a source write'),
  );
  return () => {
    stopDegrades();
    stopRepeats();
  };
}
