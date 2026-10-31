import { sessionChainCopy } from './session-chain.shell-copy';

export type SessionAction = 'restore' | 'seal' | 'compact';
export interface SessionActionFailure {
  operation: SessionAction;
  message: string;
  status?: number;
  code?: string;
}

// Preserve the server diagnostic for Classic/projections; v2 presents a code-owned
// message. Neither the code nor its translation changes the action's state guard.
export async function readSessionActionFailure(
  response: Response,
  operation: SessionAction,
): Promise<SessionActionFailure | null> {
  if (response.ok) return null;
  const fallback = `${{ restore: '恢复失败', seal: '封存失败', compact: '原生压缩失败' }[operation]} (${response.status})`;
  let data: { error?: unknown; code?: unknown } | null = null;
  try {
    data = (await response.json()) as { error?: unknown; code?: unknown } | null;
  } catch {
    // A missing diagnostic never turns a failed operation into success.
  }
  const error = typeof data?.error === 'string' ? data.error : undefined;
  return {
    operation,
    status: response.status,
    message: operation === 'compact' ? (error ?? fallback) : error || fallback,
    code: typeof data?.code === 'string' ? data.code : undefined,
  };
}

export function sessionActionErrorCopy(failure: SessionActionFailure, t: typeof sessionChainCopy.zh): string {
  if (failure.status === undefined) return t.actionRequestFailure(failure.operation);
  if (failure.status === 401) return t.actionIdentityRequired;
  if (failure.status === 403) return t.actionDenied;
  const labels: Readonly<Record<string, string>> = {
    SESSION_ACTIVE_INVOCATION: t.sealNeedsStop,
    SESSION_SEAL_RACE: t.sessionChanged,
    SESSION_NOT_ACTIVE: t.sessionNotActive,
    SESSION_NOT_FOUND: t.sessionNotFound,
    THREAD_NOT_FOUND: t.threadNotFound,
    SESSION_SEAL_UNAVAILABLE: t.sealUnavailable,
    SESSION_LIVENESS_UNAVAILABLE: t.livenessUnavailable,
    SESSION_SEAL_PENDING: t.sealPending,
    SESSION_SEAL_PARTIAL: t.sealPartial,
    active_session_confirmation_required: t.confirmActiveSession,
    active_session_changed: t.activeSessionChanged,
    session_switch_busy: t.restoreBusy,
    NATIVE_SESSION_BUSY: t.compactBusy,
    NATIVE_COMPACTION_UNSUPPORTED: t.compactUnsupported,
    NATIVE_SESSION_UNAVAILABLE: t.nativeUnavailable,
    NATIVE_COMPACTION_CURSOR_CHANGED: t.compactCursorChanged,
    NATIVE_COMPACTION_FAILED: t.compactFailed,
  };
  return failure.code !== undefined && Object.hasOwn(labels, failure.code)
    ? labels[failure.code]
    : t.actionFailure(failure.operation, failure.status);
}

export function translateSessionMessage(message: string, t: typeof sessionChainCopy.zh): string {
  const keys = [
    'accessDenied',
    'loadFailed',
    'restoreFailed',
    'restoreRequestFailed',
    'sealFailed',
    'sealRequestFailed',
    'compactFailed',
    'compactRequestFailed',
  ] as const;
  for (const key of keys) {
    const original = sessionChainCopy.zh[key];
    if (message === original || message.startsWith(`${original} (`))
      return `${t[key]}${message.slice(original.length)}`;
  }
  return message;
}
