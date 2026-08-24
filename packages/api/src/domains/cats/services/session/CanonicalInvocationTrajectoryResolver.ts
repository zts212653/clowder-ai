import type { IInvocationRecordStore } from '../stores/ports/InvocationRecordStore.js';
import type { ISessionChainStore } from '../stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
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
  | { status: 200; body: { invocationId: string; threadId: string; sessionId: string } }
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
  sessionChainStore: Pick<ISessionChainStore, 'getChainByThread'>;
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  readInvocationEvents: (session: InvocationSession, invocationId: string) => Promise<readonly unknown[]>;
}

function failure(status: FailureStatus, code: string, error: string, reason?: string): ResolutionResult {
  return { status, body: { error, code, ...(reason ? { reason } : {}) } };
}

export async function resolveCanonicalInvocationTrajectory(
  input: CanonicalInvocationTrajectoryInput,
  dependencies: CanonicalInvocationTrajectoryDependencies,
): Promise<ResolutionResult> {
  const invocation = await dependencies.invocationRecordStore.get(input.invocationId);
  if (!invocation) return failure(404, 'INVOCATION_RECORD_NOT_FOUND', 'Invocation record not found');
  if (invocation.userId !== input.userId) {
    return failure(403, 'INVOCATION_RECORD_ACCESS_DENIED', 'Access denied', 'record_belongs_to_another_user');
  }
  if (input.threadIdHint && input.threadIdHint !== invocation.threadId) {
    return failure(409, 'INVOCATION_THREAD_HINT_MISMATCH', 'Invocation thread hint does not match canonical record');
  }

  const access = await resolveThreadAccess({
    threadStore: dependencies.threadStore,
    thread: await dependencies.threadStore.get(invocation.threadId),
    userId: input.userId,
    request: { resource: 'invocations', action: 'read' },
  });
  if (access.status === 403) return { status: 403, body: threadAccessDeniedBody(access) };

  const readableSessions = filterThreadRecords(
    access,
    await dependencies.sessionChainStore.getChainByThread(invocation.threadId),
  );
  const scopedSessions = input.callerCatId
    ? readableSessions.filter((session) => session.catId === input.callerCatId)
    : readableSessions;
  const matches = (
    await Promise.all(
      scopedSessions.map(async (session) => ({
        session,
        hasInvocation: (await dependencies.readInvocationEvents(session, input.invocationId)).length > 0,
      })),
    )
  ).filter((candidate) => candidate.hasInvocation);

  if (matches.length === 0) return failure(404, 'INVOCATION_SESSION_NOT_FOUND', 'Invocation session not found');
  if (matches.length > 1) {
    return failure(409, 'INVOCATION_SESSION_AMBIGUOUS', 'Invocation resolves to multiple visible sessions');
  }
  const canonicalSession = matches[0]?.session;
  if (!canonicalSession) return failure(404, 'INVOCATION_SESSION_NOT_FOUND', 'Invocation session not found');
  if (input.sessionIdHint && input.sessionIdHint !== canonicalSession.id) {
    return failure(
      409,
      'INVOCATION_SESSION_HINT_MISMATCH',
      'Invocation session hint does not match canonical transcript',
    );
  }
  return {
    status: 200,
    body: { invocationId: input.invocationId, threadId: invocation.threadId, sessionId: canonicalSession.id },
  };
}
