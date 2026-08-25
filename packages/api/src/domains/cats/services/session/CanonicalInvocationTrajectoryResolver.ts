import type { IInvocationRecordStore } from '../stores/ports/InvocationRecordStore.js';
import type { ISessionChainStore } from '../stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../stores/ports/TurnExecutionStore.js';
import { projectRequestGenerations } from './RequestGenerationProjector.js';
import type { TranscriptEvent } from './TranscriptReader.js';
import { filterThreadRecords, resolveThreadAccess, threadAccessDeniedBody } from './thread-access-policy.js';

interface InvocationSession {
  id: string;
  threadId: string;
  catId: string;
  userId: string;
  cliSessionId?: string;
  seq: number;
  status: string;
}

type FailureStatus = 403 | 404 | 409;
type ResolutionResult =
  | {
      status: 200;
      body: {
        invocationId: string;
        threadId: string;
        sessionId: string;
        sessionIds?: string[];
        generationSessions?: Array<{ generationOrdinal: number; sessionId: string }>;
      };
    }
  | { status: FailureStatus; body: { error: string; code: string; reason?: string } };

export interface CanonicalInvocationTrajectoryInput {
  invocationId: string;
  userId: string;
  threadIdHint?: string;
  sessionIdHint?: string;
  callerCatId?: string;
}

interface CanonicalInvocationTrajectoryDependencies {
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  turnExecutionStore: Pick<ITurnExecutionStore, 'get'>;
  sessionChainStore: Pick<ISessionChainStore, 'getChainByThread'>;
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  readInvocationEvents: (session: InvocationSession, invocationId: string) => Promise<readonly TranscriptEvent[]>;
}

function failure(status: FailureStatus, code: string, error: string, reason?: string): ResolutionResult {
  return { status, body: { error, code, ...(reason ? { reason } : {}) } };
}

function validateExecutionAccess(
  input: CanonicalInvocationTrajectoryInput,
  execution: { userId: string; threadId: string },
): ResolutionResult | undefined {
  if (execution.userId !== input.userId) {
    return failure(403, 'INVOCATION_RECORD_ACCESS_DENIED', 'Access denied', 'record_belongs_to_another_user');
  }
  if (input.threadIdHint && input.threadIdHint !== execution.threadId) {
    return failure(409, 'INVOCATION_THREAD_HINT_MISMATCH', 'Invocation thread hint does not match canonical record');
  }
  return undefined;
}

function validateParentIdentity(
  execution: { userId: string; threadId: string },
  parent: { userId: string; threadId: string },
): ResolutionResult | undefined {
  return parent.userId !== execution.userId || parent.threadId !== execution.threadId
    ? failure(409, 'INVOCATION_RECORD_INTEGRITY_MISMATCH', 'Invocation record identity does not match parent')
    : undefined;
}

function resolveSessionEvidence(matches: Array<{ session: InvocationSession; events: readonly TranscriptEvent[] }>):
  | {
      orderedMatches: Array<{ session: InvocationSession; events: readonly TranscriptEvent[] }>;
      generationSessions: Array<{ generationOrdinal: number; sessionId: string }>;
    }
  | { failure: ResolutionResult } {
  const orderedMatches = [...matches].sort(
    (left, right) => left.session.seq - right.session.seq || left.session.id.localeCompare(right.session.id),
  );
  let generationSessions: Array<{ generationOrdinal: number; sessionId: string }>;
  try {
    generationSessions = projectRequestGenerations(orderedMatches.flatMap(({ events }) => events)).map(
      ({ envelope }) => ({ generationOrdinal: envelope.generationOrdinal, sessionId: envelope.sessionId }),
    );
  } catch {
    return {
      failure: failure(
        409,
        'INVOCATION_GENERATION_INTEGRITY_MISMATCH',
        'Invocation request-generation evidence is inconsistent',
      ),
    };
  }
  if (orderedMatches.length > 1 && generationSessions.length === 0) {
    return {
      failure: failure(
        409,
        'INVOCATION_SESSION_AMBIGUOUS',
        'Legacy invocation resolves to multiple visible sessions without generation evidence',
      ),
    };
  }
  return { orderedMatches, generationSessions };
}

export async function resolveCanonicalInvocationTrajectory(
  input: CanonicalInvocationTrajectoryInput,
  dependencies: CanonicalInvocationTrajectoryDependencies,
): Promise<ResolutionResult> {
  const execution = await dependencies.turnExecutionStore.get(input.invocationId);
  if (!execution) return failure(404, 'INVOCATION_RECORD_NOT_FOUND', 'Invocation record not found');
  const executionFailure = validateExecutionAccess(input, execution);
  if (executionFailure) return executionFailure;
  const parentInvocation = await dependencies.invocationRecordStore.get(execution.parentInvocationId);
  if (!parentInvocation) {
    return failure(404, 'INVOCATION_PARENT_RECORD_NOT_FOUND', 'Invocation parent record not found');
  }
  const parentFailure = validateParentIdentity(execution, parentInvocation);
  if (parentFailure) return parentFailure;

  const access = await resolveThreadAccess({
    threadStore: dependencies.threadStore,
    thread: await dependencies.threadStore.get(execution.threadId),
    userId: input.userId,
    request: { resource: 'invocations', action: 'read' },
  });
  if (access.status === 403) return { status: 403, body: threadAccessDeniedBody(access) };

  const readableSessions = filterThreadRecords(
    access,
    await dependencies.sessionChainStore.getChainByThread(execution.threadId),
  );
  const executionSessions = readableSessions.filter((session) => session.catId === execution.catId);
  const scopedSessions = input.callerCatId
    ? executionSessions.filter((session) => session.catId === input.callerCatId)
    : executionSessions;
  const matches = (
    await Promise.all(
      scopedSessions.map(async (session) => ({
        session,
        events: await dependencies.readInvocationEvents(session, input.invocationId),
      })),
    )
  ).filter((candidate) => candidate.events.length > 0);

  if (matches.length === 0) return failure(404, 'INVOCATION_SESSION_NOT_FOUND', 'Invocation session not found');
  const evidence = resolveSessionEvidence(matches);
  if ('failure' in evidence) return evidence.failure;
  const { orderedMatches, generationSessions } = evidence;
  const canonicalSessionId = generationSessions[0]?.sessionId ?? orderedMatches[0]?.session.id;
  const canonicalSession = orderedMatches.find(({ session }) => session.id === canonicalSessionId)?.session;
  if (!canonicalSession) return failure(404, 'INVOCATION_SESSION_NOT_FOUND', 'Invocation session not found');
  if (input.sessionIdHint && !orderedMatches.some(({ session }) => session.id === input.sessionIdHint)) {
    return failure(
      409,
      'INVOCATION_SESSION_HINT_MISMATCH',
      'Invocation session hint does not match canonical transcript',
    );
  }
  return {
    status: 200,
    body: {
      invocationId: input.invocationId,
      threadId: execution.threadId,
      sessionId: canonicalSession.id,
      ...(orderedMatches.length > 1 ? { sessionIds: orderedMatches.map(({ session }) => session.id) } : {}),
      ...(generationSessions.length > 0 ? { generationSessions } : {}),
    },
  };
}
