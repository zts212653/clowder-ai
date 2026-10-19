import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { runModuleWorker } from '../../../../../utils/run-module-worker.js';
import type { TranscriptEvent, TranscriptReader } from '../TranscriptReader.js';
import type { TranscriptWriter } from '../TranscriptWriter.js';
import { projectRequestGenerationEvidence } from './request-generation-evidence.js';
import type {
  IndexedSession,
  InvocationIndexRequest,
  InvocationIndexResponse,
  SessionIndexInput,
} from './transcript-invocation-index-types.js';
import {
  notifyTranscriptRead,
  type TranscriptReadMetrics,
  type TranscriptReadObserver,
} from './transcript-read-observer.js';

export interface InvocationReadPage {
  events: TranscriptEvent[];
  total: number;
  nextCursor?: { eventNo: number };
  summary?: InvocationTrajectorySummary;
}

/** Static worker target stays in this module so TS development and compiled JS use the same URL. */
export async function readInvocationIndexInWorker(input: InvocationIndexRequest): Promise<InvocationIndexResponse> {
  const { readTranscriptInvocationIndex } = await import('./transcript-invocation-index-worker.js');
  return readTranscriptInvocationIndex(input);
}

export class TranscriptInvocationReader {
  constructor(
    private readonly reader: TranscriptReader,
    private readonly writer?: TranscriptWriter,
  ) {}

  private async read(
    sessions: readonly IndexedSession[],
    query: InvocationIndexRequest['query'],
    signal?: AbortSignal,
    observer?: TranscriptReadObserver,
    metrics?: TranscriptReadMetrics,
  ) {
    const prepareStarted = metrics ? performance.now() : 0;
    signal?.throwIfAborted();
    const snapshots = new Map<string, TranscriptEvent[]>();
    const inputs: SessionIndexInput[] = [];
    for (const session of sessions) {
      signal?.throwIfAborted();
      const includeLive = session.status !== 'sealed';
      const snapshot =
        includeLive && this.writer
          ? await this.writer.readBufferedSnapshot({
              sessionId: session.id,
              threadId: session.threadId,
              catId: session.catId,
              seq: session.seq,
              ...(session.cliSessionId ? { cliSessionId: session.cliSessionId } : {}),
            })
          : { events: [], compact: [] };
      snapshots.set(session.id, snapshot.events);
      inputs.push({
        session,
        directory: this.reader.getSessionDir(session.threadId, session.catId, session.id),
        buffered: snapshot.compact,
        includeLive,
      });
    }
    if (metrics) metrics.prepareMs = performance.now() - prepareStarted;
    const workerStarted = metrics ? performance.now() : 0;
    let result: InvocationIndexResponse;
    try {
      result = await runModuleWorker<InvocationIndexResponse>({
        moduleUrl: new URL(import.meta.url),
        exportName: 'readInvocationIndexInWorker',
        isolation: 'process',
        input: { sessions: inputs, query } satisfies InvocationIndexRequest,
        ...(signal ? { signal } : {}),
        timeoutMs: 120_000,
        ...(observer ? { onTiming: observer.onWorkerTiming } : {}),
      });
    } finally {
      if (metrics) metrics.workerAwaitMs = performance.now() - workerStarted;
    }
    if (metrics) {
      metrics.sourceBytesScanned = result.diagnostics.sourceBytesScanned;
      metrics.hydratedBytes = result.diagnostics.hydratedBytes;
      metrics.summaryCacheHits = result.diagnostics.summaryCacheHits;
    }
    return { result, snapshots };
  }

  async list(sessions: readonly IndexedSession[], limit: number, signal?: AbortSignal) {
    const { result } = await this.read(sessions, { kind: 'list', limit }, signal);
    return { invocations: result.invocations, total: result.total };
  }

  async readFiles(session: IndexedSession, signal?: AbortSignal) {
    const { result } = await this.read([session], { kind: 'files' }, signal);
    return result.filesTouched;
  }

  async readInvocation(
    sessions: readonly IndexedSession[],
    invocationId: string,
    page: { cursor?: number; limit?: number; generationEvidenceOnly?: boolean } = {},
    signal?: AbortSignal,
    observer?: TranscriptReadObserver,
  ): Promise<Map<string, InvocationReadPage>> {
    if (!observer) {
      const { result, snapshots } = await this.read(sessions, { kind: 'invocation', invocationId, ...page }, signal);
      return this.materializePages(result, snapshots, invocationId, page.generationEvidenceOnly);
    }
    const started = performance.now();
    const metrics: TranscriptReadMetrics = {
      status: 'failed',
      sessionCount: sessions.length,
      rows: 0,
      prepareMs: 0,
      workerAwaitMs: 0,
      materializeMs: 0,
      elapsedMs: 0,
      sourceBytesScanned: 0,
      hydratedBytes: 0,
      summaryCacheHits: 0,
    };
    try {
      const { result, snapshots } = await this.read(
        sessions,
        { kind: 'invocation', invocationId, ...page },
        signal,
        observer,
        metrics,
      );
      const materializeStarted = performance.now();
      let pages: Map<string, InvocationReadPage>;
      try {
        pages = this.materializePages(result, snapshots, invocationId, page.generationEvidenceOnly);
      } finally {
        metrics.materializeMs = performance.now() - materializeStarted;
      }
      metrics.rows = [...pages.values()].reduce((sum, value) => sum + value.events.length, 0);
      metrics.status = 'success';
      return pages;
    } finally {
      metrics.elapsedMs = performance.now() - started;
      if (metrics.workerAwaitMs === 0) metrics.prepareMs = metrics.elapsedMs;
      if (signal?.aborted) metrics.status = 'aborted';
      notifyTranscriptRead(observer, metrics);
    }
  }

  /** Exact session coordinates share the invocation index, including live-only recovery. */
  async readEvents(
    session: IndexedSession,
    page: { cursor?: number; limit: number },
    signal?: AbortSignal,
  ): Promise<InvocationReadPage> {
    signal?.throwIfAborted();
    if (session.status === 'sealed') {
      return this.reader.readEvents(
        session.id,
        session.threadId,
        session.catId,
        page.cursor === undefined ? undefined : { eventNo: page.cursor },
        page.limit,
      );
    }
    const { result, snapshots } = await this.read([session], { kind: 'events', ...page }, signal);
    const materialized = this.materializePages(result, snapshots).get(session.id);
    if (!materialized) throw new Error('Transcript index omitted the requested session');
    return materialized;
  }

  private materializePages(
    result: InvocationIndexResponse,
    snapshots: Map<string, TranscriptEvent[]>,
    invocationId?: string,
    generationEvidenceOnly = false,
  ): Map<string, InvocationReadPage> {
    return new Map(
      result.pages.map((indexed) => [
        indexed.sessionId,
        {
          ...indexed,
          events: indexed.events.map((item) => {
            if ('event' in item) return item.event;
            const event = snapshots.get(indexed.sessionId)?.[item.bufferIndex];
            if (!event || (invocationId !== undefined && event.invocationId !== invocationId))
              throw new Error('Transcript buffer changed during indexed read');
            const envelope = { ...event, eventNo: item.eventNo };
            return generationEvidenceOnly ? projectRequestGenerationEvidence(envelope) : envelope;
          }),
        },
      ]),
    );
  }
}
