import { apiFetch } from '@/utils/api-client';

// The host's part of a recovery: the thread's binding for the target cat and the cat's contract provider. Which
// conversation to bind is chosen by the provider's plugin, which hands the chosen chatUrl to the retry.
export type RecoveryLoadState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      boundChatUrl: string | null;
      provider?: string;
      hydratedAttemptId?: string;
      retryState?: 'ready' | 'pending' | 'unavailable';
    };

export type RecoveryPhase = 'idle' | 'binding' | 'retrying' | 'queued' | 'connected';
export type RecoveryDeliveryStatus = 'sent' | 'sending' | 'failed' | 'unknown';

export interface RecoveryIdentity {
  threadId: string;
  sourceMessageId: string;
  targetCatId: string;
  attemptId?: string;
  deliveryStatus?: RecoveryDeliveryStatus;
}

interface CloudBindingsResponse {
  bindings?: Record<string, unknown>;
  providers?: Record<string, string>;
  error?: string;
  code?: string;
}

function chatUrlOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function deniesOwnerAccess(response: Response | null): boolean {
  return response?.status === 401 || response?.status === 403;
}

export async function readRecoveryState(
  identity: RecoveryIdentity,
  signal: AbortSignal,
): Promise<RecoveryLoadState | null> {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(identity.threadId)}/cloud-bindings`, { signal });
  if (signal.aborted) return null;
  if (deniesOwnerAccess(response)) return { kind: 'unauthorized' };
  const body = (await response.json().catch(() => ({}))) as CloudBindingsResponse;
  if (signal.aborted) return null;
  if (!response.ok) return { kind: 'error', message: body.error ?? `当前 Thread 绑定读取失败 (${response.status})` };
  const provider = body.providers?.[identity.targetCatId];
  return {
    kind: 'ready',
    boundChatUrl: chatUrlOf(body.bindings?.[identity.targetCatId]),
    ...(provider ? { provider } : {}),
    ...(identity.attemptId
      ? { hydratedAttemptId: identity.attemptId, retryState: 'ready' as const }
      : { retryState: 'unavailable' as const }),
  };
}

export async function readBoundChatUrl(threadId: string, targetCatId: string): Promise<string | null | undefined> {
  try {
    const response = await apiFetch(
      `/api/threads/${encodeURIComponent(threadId)}/cloud-bindings`,
      {},
      { afterCurrentGet: true },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as CloudBindingsResponse;
    return chatUrlOf(body.bindings?.[targetCatId]);
  } catch {
    return undefined;
  }
}

async function persistSelectedRoute(args: {
  identity: RecoveryIdentity;
  chatUrl: string;
  routeIsBound: boolean;
  isCurrent: () => boolean;
  onBound: () => void;
  onWriteStart: () => void;
  onWriteSettled: () => void;
}): Promise<boolean> {
  if (args.routeIsBound) return true;
  const { threadId, targetCatId } = args.identity;
  args.onWriteStart();
  let response: Response;
  try {
    response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/cloud-bindings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: targetCatId, chatUrl: args.chatUrl }),
    });
  } finally {
    // Whatever the answer, the binding may have changed: whoever else shows it reads it again.
    args.onWriteSettled();
  }
  const body = (await response.json().catch(() => ({}))) as CloudBindingsResponse;
  if (!args.isCurrent()) return false;
  if (!response.ok || body.bindings?.[targetCatId] !== args.chatUrl) {
    throw new Error(body.error ?? `绑定失败 (${response.status})`);
  }
  args.onBound();
  return true;
}

async function retryExactSource(args: {
  identity: RecoveryIdentity & { attemptId: string };
  isCurrent: () => boolean;
}): Promise<boolean> {
  const { sourceMessageId, targetCatId, attemptId } = args.identity;
  const response = await apiFetch(
    `/api/messages/${encodeURIComponent(sourceMessageId)}/delivery-targets/${encodeURIComponent(targetCatId)}/retry`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!args.isCurrent()) return false;
  if (response.ok) return true;
  // This exact endpoint reserves 409 for an immutable retry fence that no
  // longer matches. Treat the status as authoritative even if an intermediary
  // strips the structured body; retrying the same stale attempt cannot heal it.
  const stale = response.status === 409;
  if (stale) throw new RecoveryReconciliationRequired();
  throw new Error(body.error ?? '重新发送未成功');
}

class RecoveryReconciliationRequired extends Error {}

export function markBound(state: RecoveryLoadState, chatUrl: string | null): RecoveryLoadState {
  return state.kind === 'ready' ? { ...state, boundChatUrl: chatUrl } : state;
}

function recoveryFailureMessage(routeIsBound: boolean, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : '绑定没有完成';
  return routeIsBound ? `会话已绑定，但这条消息还没有重新发送。 ${detail}` : detail;
}

export interface PreparedRecoveryOperation {
  chatUrl: string;
  attemptId?: string;
  routeIsBound: boolean;
}

export function prepareRecoveryOperation(args: {
  loadState: RecoveryLoadState;
  chatUrl: string;
  attemptId?: string;
  busy: boolean;
}): PreparedRecoveryOperation | undefined {
  if (args.busy || !args.chatUrl || args.loadState.kind !== 'ready' || args.loadState.retryState === 'pending')
    return undefined;
  return {
    chatUrl: args.chatUrl,
    attemptId: args.attemptId,
    routeIsBound: args.loadState.boundChatUrl === args.chatUrl,
  };
}

export type RecoveryOperationOutcome =
  | { kind: 'queued' }
  | { kind: 'connected' }
  | { kind: 'reconcile' }
  | { kind: 'stale' }
  | { kind: 'error'; message: string };

export async function executeRecoveryOperation(args: {
  identity: RecoveryIdentity;
  prepared: PreparedRecoveryOperation;
  isCurrent: () => boolean;
  setPhase: (phase: RecoveryPhase) => void;
  onBound: () => void;
  onWriteStart: () => void;
  onWriteSettled: () => void;
}): Promise<RecoveryOperationOutcome> {
  let routeIsBound = args.prepared.routeIsBound;
  try {
    args.setPhase(routeIsBound ? 'retrying' : 'binding');
    routeIsBound = await persistSelectedRoute({
      identity: args.identity,
      chatUrl: args.prepared.chatUrl,
      routeIsBound,
      isCurrent: args.isCurrent,
      onBound: args.onBound,
      onWriteStart: args.onWriteStart,
      onWriteSettled: args.onWriteSettled,
    });
    if (!routeIsBound || !args.isCurrent()) return { kind: 'stale' };
    if (!args.prepared.attemptId) return { kind: 'connected' };
    args.setPhase('retrying');
    const queued = await retryExactSource({
      identity: { ...args.identity, attemptId: args.prepared.attemptId },
      isCurrent: args.isCurrent,
    });
    return queued && args.isCurrent() ? { kind: 'queued' } : { kind: 'stale' };
  } catch (cause) {
    if (cause instanceof RecoveryReconciliationRequired && args.isCurrent()) return { kind: 'reconcile' };
    return args.isCurrent()
      ? { kind: 'error', message: recoveryFailureMessage(routeIsBound, cause) }
      : { kind: 'stale' };
  }
}
