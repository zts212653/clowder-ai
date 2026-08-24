import type { SessionStatus } from './session.js';

export type InvocationTrajectoryStatus = 'running' | 'done' | 'error' | 'cancelled' | 'timeout';

export interface InvocationTrajectoryTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  total?: number;
}

/** Invocation-first read projection over the canonical session transcript. */
export interface InvocationTrajectorySummary {
  invocationId: string;
  threadId: string;
  sessionId: string;
  sessionSeq: number;
  sessionStatus: SessionStatus;
  sealReason?: string;
  catId: string;
  status: InvocationTrajectoryStatus;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  eventCount: number;
  statusEventCount: number;
  toolUseCount: number;
  toolResultCount: number;
  messageCount: number;
  errorCount: number;
  toolNames: string[];
  keyMessages: string[];
  terminalReason?: string;
  tokens?: InvocationTrajectoryTokens;
}

export interface InvocationTrajectoryListResponse {
  invocations: InvocationTrajectorySummary[];
  total: number;
}

export type InvocationPromptMessageProjection =
  | {
      messageId: string;
      status: 'available';
      author: 'user' | 'assistant' | 'system';
      excerpt: string;
    }
  | { messageId: string; status: 'deleted' | 'invisible' | 'missing' };

export type InvocationPromptInputProjection =
  | { status: 'available'; messages: InvocationPromptMessageProjection[] }
  | {
      status: 'unavailable';
      reason: 'prompt_message_ids_unavailable' | 'trigger_message_not_covered' | 'execution_scope_mismatch';
      messages: [];
    };

export type TrajectoryOriginRef =
  | {
      kind: 'message';
      threadId: string;
      messageId: string;
      viewportOffsetPx: number;
    }
  | {
      kind: 'eval';
      threadId: string;
      eventId: string;
      viewportOffsetPx: number;
    };
