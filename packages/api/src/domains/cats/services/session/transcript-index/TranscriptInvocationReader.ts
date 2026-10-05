import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { runModuleWorker } from '../../../../../utils/run-module-worker.js';
import type { TranscriptEvent, TranscriptReader } from '../TranscriptReader.js';
import type { TranscriptWriter } from '../TranscriptWriter.js';
import type {
  IndexedSession,
  InvocationIndexRequest,
  InvocationIndexResponse,
  SessionIndexInput,
} from './transcript-invocation-index-types.js';

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
  ) {
    signal?.throwIfAborted();
    const snapshots = new Map<string, TranscriptEvent[]>();
    const inputs: SessionIndexInput[] = [];
    for (const session of sessions) {
      signal?.throwIfAborted();
      const includeLive = session.status !== 'sealed' && !!this.writer;
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
    const result = await runModuleWorker<InvocationIndexResponse>({
      moduleUrl: new URL(import.meta.url),
      exportName: 'readInvocationIndexInWorker',
      isolation: 'process',
      input: { sessions: inputs, query } satisfies InvocationIndexRequest,
      ...(signal ? { signal } : {}),
      timeoutMs: 120_000,
    });
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
    page: { cursor?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<Map<string, InvocationReadPage>> {
    const { result, snapshots } = await this.read(sessions, { kind: 'invocation', invocationId, ...page }, signal);
    return new Map(
      result.pages.map((indexed) => [
        indexed.sessionId,
        {
          ...indexed,
          events: indexed.events.map((item) => {
            if ('event' in item) return item.event;
            const event = snapshots.get(indexed.sessionId)?.[item.bufferIndex];
            if (!event || event.invocationId !== invocationId)
              throw new Error('Transcript buffer changed during indexed read');
            return { ...event, eventNo: item.eventNo };
          }),
        },
      ]),
    );
  }
}
