import type { InvocationTrajectorySummary, SessionStatus } from '@cat-cafe/shared';
import type { TranscriptEvent } from '../TranscriptReader.js';
import type { TranscriptFileTouch } from '../transcript-file-touches.js';

export interface IndexedSession {
  id: string;
  threadId: string;
  catId: string;
  seq: number;
  status: SessionStatus;
  sealReason?: string | null;
  cliSessionId?: string;
}

export interface CompactTranscriptEvent {
  hash: string;
  projection: TranscriptEvent;
  filesTouched: TranscriptFileTouch[];
}

export interface SessionIndexInput {
  session: IndexedSession;
  directory: string;
  buffered: CompactTranscriptEvent[];
  includeLive: boolean;
}

export interface IndexedEventPointer {
  source: number;
  seq: number;
  event_no: number;
  byte_offset: number;
  byte_length: number;
}

export type HydratedIndexedEvent = { event: TranscriptEvent } | { bufferIndex: number; eventNo: number };

export interface IndexedInvocationPage {
  sessionId: string;
  events: HydratedIndexedEvent[];
  total: number;
  nextCursor?: { eventNo: number };
  summary?: InvocationTrajectorySummary;
}

export interface InvocationIndexRequest {
  sessions: SessionIndexInput[];
  query:
    | { kind: 'list'; limit: number }
    | { kind: 'invocation'; invocationId: string; cursor?: number; limit?: number }
    | { kind: 'files' };
}

export interface InvocationIndexDiagnostics {
  sourceBytesScanned: number;
  hydratedBytes: number;
  summaryCacheHits: number;
}

export interface InvocationIndexResponse {
  invocations: InvocationTrajectorySummary[];
  total: number;
  pages: IndexedInvocationPage[];
  diagnostics: InvocationIndexDiagnostics;
  filesTouched: TranscriptFileTouch[];
}
