import { apiFetch } from '@/utils/api-client';
import { parseChatGptConversationUrl } from '@/utils/chatgpt-chat-url';
import { type AuthorizedConversationCandidate, fetchAuthorizedConversations } from './authorized-conversations';
import { projectPersonalChromeRecoveryStatus } from './cloud-binding-recovery-status';

export type { AuthorizedConversationCandidate } from './authorized-conversations';

export type RecoveryLoadState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string; actionLabel?: string }
  | {
      kind: 'ready';
      candidates: AuthorizedConversationCandidate[];
      boundConversationId: string | null;
      hydratedAttemptId?: string;
      retryStateError?: string;
      retryState?: 'ready' | 'pending' | 'unavailable';
      connectionIssue?: string;
      connectionActionLabel?: string;
      titleSyncMessage?: string;
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
  error?: string;
  code?: string;
}

function deniesOwnerAccess(response: Response | null): boolean {
  return response?.status === 401 || response?.status === 403;
}

export async function readRecoveryState(
  identity: RecoveryIdentity,
  signal: AbortSignal,
  syncTitles = false,
): Promise<RecoveryLoadState | null> {
  const [authorized, bindingResponse] = await Promise.all([
    fetchAuthorizedConversations(signal, { syncTitles }),
    apiFetch(`/api/threads/${encodeURIComponent(identity.threadId)}/cloud-bindings`, { signal }),
  ]);
  if (signal.aborted) return null;
  if ([authorized.response, bindingResponse].some(deniesOwnerAccess)) {
    return { kind: 'unauthorized' };
  }

  const [bindingBody] = await Promise.all([bindingResponse.json().catch(() => ({})) as Promise<CloudBindingsResponse>]);
  if (signal.aborted) return null;
  if (!authorized.response.ok) {
    return {
      kind: 'error',
      message: authorized.body.setupIssue?.message ?? '暂时读不到已授权的会话，请检查 Personal Chrome 插件状态后重试。',
      actionLabel: authorized.body.setupIssue?.actionLabel ?? '检查 Personal Chrome',
    };
  }
  if (!bindingResponse.ok) {
    return { kind: 'error', message: bindingBody.error ?? `当前 Thread 绑定读取失败 (${bindingResponse.status})` };
  }

  const { candidates } = authorized;
  const rawBinding = bindingBody.bindings?.[identity.targetCatId];
  const binding = rawBinding === undefined ? null : parseChatGptConversationUrl(rawBinding);
  return {
    kind: 'ready',
    candidates,
    boundConversationId:
      binding && candidates.some((candidate) => candidate.conversationId === binding.conversationId)
        ? binding.conversationId
        : null,
    ...(identity.attemptId
      ? { hydratedAttemptId: identity.attemptId, retryState: 'ready' as const }
      : {
          retryState: 'unavailable' as const,
          retryStateError: '这条消息缺少可验证的发送记录，请查看最新状态。',
        }),
    ...projectPersonalChromeRecoveryStatus(authorized.body),
  };
}

export async function readBoundConversationId(
  threadId: string,
  targetCatId: string,
): Promise<string | null | undefined> {
  try {
    const response = await apiFetch(
      `/api/threads/${encodeURIComponent(threadId)}/cloud-bindings`,
      {},
      { afterCurrentGet: true },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as CloudBindingsResponse;
    const raw = body.bindings?.[targetCatId];
    return raw === undefined ? null : (parseChatGptConversationUrl(raw)?.conversationId ?? null);
  } catch {
    return undefined;
  }
}

async function persistSelectedRoute(args: {
  identity: RecoveryIdentity;
  selected: AuthorizedConversationCandidate;
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
      body: JSON.stringify({ catId: targetCatId, chatUrl: args.selected.chatUrl }),
    });
  } finally {
    // Whatever the answer, the binding may have changed: whoever else shows it reads it again.
    args.onWriteSettled();
  }
  const body = (await response.json().catch(() => ({}))) as CloudBindingsResponse;
  if (!args.isCurrent()) return false;
  const persisted = parseChatGptConversationUrl(body.bindings?.[targetCatId]);
  if (!response.ok || persisted?.conversationId !== args.selected.conversationId) {
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

function selectReadyCandidate(
  loadState: RecoveryLoadState,
  selectedConversationId: string | null,
): AuthorizedConversationCandidate | undefined {
  if (loadState.kind !== 'ready' || !selectedConversationId) return undefined;
  return loadState.candidates.find((candidate) => candidate.conversationId === selectedConversationId);
}

export function markConversationBound(state: RecoveryLoadState, conversationId: string): RecoveryLoadState {
  return state.kind === 'ready' ? { ...state, boundConversationId: conversationId } : state;
}

/** The ready state with `conversationId` as the bound one — if it is an authorized conversation. */
export function showBound(
  state: Extract<RecoveryLoadState, { kind: 'ready' }>,
  conversationId: string | null,
): Extract<RecoveryLoadState, { kind: 'ready' }> {
  const authorized = state.candidates.some((candidate) => candidate.conversationId === conversationId);
  return { ...state, boundConversationId: authorized ? conversationId : null };
}

function recoveryFailureMessage(routeIsBound: boolean, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : '绑定没有完成';
  return routeIsBound ? `会话已绑定，但这条消息还没有重新发送。 ${detail}` : detail;
}

export interface PreparedRecoveryOperation {
  selected: AuthorizedConversationCandidate;
  attemptId?: string;
  routeIsBound: boolean;
}

export function prepareRecoveryOperation(args: {
  loadState: RecoveryLoadState;
  selectedConversationId: string | null;
  attemptId?: string;
  busy: boolean;
}): PreparedRecoveryOperation | undefined {
  const selected = selectReadyCandidate(args.loadState, args.selectedConversationId);
  if (args.busy || !selected || args.loadState.kind !== 'ready' || args.loadState.retryState === 'pending')
    return undefined;
  if (args.attemptId && args.loadState.connectionIssue) return undefined;
  return {
    selected,
    attemptId: args.attemptId,
    routeIsBound: args.loadState.boundConversationId === selected.conversationId,
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
      selected: args.prepared.selected,
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
