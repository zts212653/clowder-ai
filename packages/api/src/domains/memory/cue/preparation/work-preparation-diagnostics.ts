import { ContextSourceTimeout, ReadStopError, readStopReason } from '../../read-stop-diagnostics.js';

const errorNames = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AbortError',
  'TimeoutError',
  'SqliteError',
  'MessageSearchAccessError',
]);
const errorCodes = new Set([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_ERROR',
  'SQLITE_INTERRUPT',
  'ABORT_ERR',
  'ERR_OPERATION_ABORTED',
]);

function failureTags(error: unknown) {
  try {
    const errorClass =
      error instanceof ContextSourceTimeout
        ? 'ContextSourceTimeout'
        : error instanceof ReadStopError
          ? 'ReadStopError'
          : error instanceof DOMException
            ? 'DOMException'
            : error instanceof Error
              ? 'Error'
              : 'UnknownError';
    const value = error && typeof error === 'object' ? (error as { code?: unknown; name?: unknown }) : undefined;
    const name = value?.name,
      code = value?.code;
    return {
      errorClass,
      ...(typeof name === 'string' && errorNames.has(name) ? { errorName: name } : {}),
      ...(typeof code === 'string' && errorCodes.has(code) ? { errorCode: code } : {}),
      ...(error instanceof DOMException && (code === 20 || code === 23) ? { errorCode: code } : {}),
    };
  } catch {
    return { errorClass: 'UnknownError' };
  }
}

export interface WorkPreparationLogger {
  warn(fields: object, message: string): void;
}

export type WorkPreparationStage =
  | 'bind'
  | 'receive'
  | 'create'
  | 'source_metadata'
  | 'discovery'
  | 'validate'
  | 'publish'
  | 'finish';

/** Log only identifiers and bounded error tags; exception messages/stacks may contain source text. */
export function preparationFailureFields(
  scope: { invocationId: string; threadId: string },
  opportunityId: string | undefined,
  stage: WorkPreparationStage,
  started: number,
  stageStarted: number,
  error: unknown,
  signal?: AbortSignal,
) {
  return {
    invocationId: scope.invocationId,
    threadId: scope.threadId,
    ...(opportunityId ? { opportunityId } : {}),
    stage,
    stopReason: readStopReason(error, signal, 'operation_rejected'),
    elapsedMs: Math.round(performance.now() - started),
    stageElapsedMs: Math.round(performance.now() - stageStarted),
    ...failureTags(error),
  };
}
