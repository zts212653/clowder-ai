/** F317 E: bind one F195 transcript stream to one exact Live call generation. */
import {
  type F195Record,
  type F317MeetingBinding,
  type F317MeetingContext,
  object,
  projectF195Context,
  readF195Artifact,
  validateF195Sequence,
  validBinding,
} from './f317-meeting-artifact.js';

export type { F317MeetingBinding, F317MeetingContext } from './f317-meeting-artifact.js';

type MeetingSourceState = 'ready' | 'stopped' | 'binding_mismatch' | 'unavailable' | 'closed';
type RefreshResult = { state: MeetingSourceState; cursor: number; delivered: number };
type ReadyRead =
  | { state: 'ready'; records: readonly F195Record[]; artifactId: string }
  | { state: Exclude<MeetingSourceState, 'ready'>; records: readonly [] };

export interface F317MeetingSubscription {
  readonly epoch: number;
  readonly cursor: number;
  refresh(): Promise<RefreshResult>;
  close(): void;
}

async function inspectCapture(
  fetchFn: typeof fetch,
  serviceUrl: string,
  binding: F317MeetingBinding,
  signal: AbortSignal,
): Promise<MeetingSourceState> {
  if (signal.aborted) return 'closed';
  try {
    const response = await fetchFn(`${serviceUrl}/status`, { signal });
    if (signal.aborted) return 'closed';
    if (!response.ok) return 'unavailable';
    const status = object(await response.json());
    if (signal.aborted) return 'closed';
    if (!status) return 'unavailable';
    if (status.thread_id !== binding.threadId || status.meeting_id !== binding.meetingId) return 'binding_mismatch';
    return status.running === true ? 'ready' : 'stopped';
  } catch {
    return signal.aborted ? 'closed' : 'unavailable';
  }
}

function isAsrError(record: F195Record): boolean {
  return record.line.asr_error !== undefined || (record.line.text as string).startsWith('[ASR error');
}

export function createF317MeetingSource(input: {
  readonly transcriptDir: string;
  readonly audioServiceUrl: string;
  readonly fetchFn?: typeof fetch;
}): {
  bind(
    binding: F317MeetingBinding,
    callbacks: {
      onContext(item: F317MeetingContext, signal: AbortSignal): void | Promise<void>;
    },
  ): F317MeetingSubscription;
} {
  const fetchFn = input.fetchFn ?? fetch;
  const serviceUrl = input.audioServiceUrl.replace(/\/$/, '');
  let nextEpoch = 0;

  return {
    bind(binding, callbacks) {
      if (!validBinding(binding)) throw new Error('meeting_source_binding_invalid');
      const epoch = ++nextEpoch;
      const controller = new AbortController();
      let cursor = binding.afterCursor ?? 0;
      let pinnedArtifactId: string | undefined;
      let pending: Promise<RefreshResult> | undefined;

      async function readReady(): Promise<ReadyRead> {
        if (controller.signal.aborted) return { state: 'closed', records: [] };
        const first = await inspectCapture(fetchFn, serviceUrl, binding, controller.signal);
        if (first !== 'ready') return { state: first, records: [] };
        const artifact = await readF195Artifact(input.transcriptDir, binding);
        if (controller.signal.aborted) return { state: 'closed', records: [] };
        if (artifact.state !== 'ready') return { state: artifact.state, records: [] };
        const second = await inspectCapture(fetchFn, serviceUrl, binding, controller.signal);
        if (second !== 'ready') return { state: second, records: [] };
        return { state: 'ready', records: artifact.records, artifactId: artifact.artifactId };
      }

      async function deliver(records: readonly F195Record[], artifactId: string): Promise<RefreshResult> {
        let delivered = 0;
        for (const record of records.slice(cursor)) {
          if (controller.signal.aborted) return { state: 'closed', cursor, delivered };
          if (isAsrError(record)) {
            cursor = record.cursor;
            continue;
          }
          await callbacks.onContext(projectF195Context(record, binding, artifactId, epoch), controller.signal);
          if (controller.signal.aborted) return { state: 'closed', cursor, delivered };
          cursor = record.cursor;
          delivered += 1;
        }
        return { state: 'ready', cursor, delivered };
      }

      async function refresh(): Promise<RefreshResult> {
        const ready = await readReady();
        if (ready.state !== 'ready') return { state: ready.state, cursor, delivered: 0 };
        if (pinnedArtifactId && pinnedArtifactId !== ready.artifactId) {
          return { state: 'binding_mismatch', cursor, delivered: 0 };
        }
        pinnedArtifactId = ready.artifactId;
        validateF195Sequence(ready.records, cursor);
        return deliver(ready.records, ready.artifactId);
      }

      return {
        epoch,
        get cursor() {
          return cursor;
        },
        refresh() {
          pending ??= refresh().finally(() => {
            pending = undefined;
          });
          return pending;
        },
        close() {
          controller.abort();
        },
      };
    },
  };
}
