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
) {
  const value =
    error && typeof error === 'object'
      ? (error as { code?: unknown; name?: unknown; constructor?: { name?: unknown } })
      : null;
  const name = value?.constructor?.name;
  const code = value?.code;
  const errorName = value?.name;
  return {
    invocationId: scope.invocationId,
    threadId: scope.threadId,
    ...(opportunityId ? { opportunityId } : {}),
    stage,
    elapsedMs: Math.round(performance.now() - started),
    stageElapsedMs: Math.round(performance.now() - stageStarted),
    errorClass: typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'UnknownError',
    ...(typeof errorName === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(errorName) ? { errorName } : {}),
    ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { errorCode: code } : {}),
    ...(typeof code === 'number' && Number.isSafeInteger(code) ? { errorCode: code } : {}),
  };
}
