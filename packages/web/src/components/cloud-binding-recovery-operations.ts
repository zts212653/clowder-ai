import { apiFetch } from '@/utils/api-client';
import { parseChatGptConversationUrl } from '@/utils/chatgpt-chat-url';
import { type AuthorizedConversationCandidate, fetchAuthorizedConversations } from './authorized-conversations';
import { projectPersonalChromeRecoveryStatus } from './cloud-binding-recovery-status';

export type { AuthorizedConversationCandidate } from './authorized-conversations';

export type RecoveryLoadState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      candidates: AuthorizedConversationCandidate[];
      boundConversationId: string | null;
      hydratedAttemptId?: string;
      retryStateError?: string;
      retryState?: 'ready' | 'pending' | 'unavailable';
      connectionIssue?: string;
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

interface RetryAuthorityResponse {
  attemptId?: unknown;
  error?: string;
  code?: string;
  targetState?: string;
}

function safeAttemptId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

function deniesOwnerAccess(response: Response | null): boolean {
  return response?.status === 401 || response?.status === 403;
}

function projectRetryState(
  response: Response | null,
  body: RetryAuthorityResponse | undefined,
): Pick<Extract<RecoveryLoadState, { kind: 'ready' }>, 'hydratedAttemptId' | 'retryStateError' | 'retryState'> {
  const hydratedAttemptId = response?.ok ? safeAttemptId(body?.attemptId) : undefined;
  if (hydratedAttemptId) return { hydratedAttemptId, retryState: 'ready' };
  if (response?.status === 409 && ['queued', 'starting', 'appended'].includes(body?.targetState ?? '')) {
    return { retryState: 'pending' };
  }
  if (!response?.ok) {
    const retryStateError =
      response?.status === 409 || response?.status === 404
        ? '无法确认这条旧消息的发送状态。连接会话不会重发它。'
        : (body?.error ?? `可重试状态读取失败 (${response?.status ?? 'unknown'})`);
    return { retryStateError, retryState: 'unavailable' };
  }
  return { retryState: 'unavailable', retryStateError: '暂时无法确认发送状态。连接会话不会重发原消息。' };
}

export async function readRecoveryState(
  identity: RecoveryIdentity,
  signal: AbortSignal,
  syncTitles = false,
): Promise<RecoveryLoadState | null> {
  const retryAuthorityRequest = apiFetch(
    `/api/messages/${encodeURIComponent(identity.sourceMessageId)}/queue-targets/${encodeURIComponent(identity.targetCatId)}/retry-authority`,
    { signal },
  );
  const [authorized, bindingResponse, retryAuthorityResponse] = await Promise.all([
    fetchAuthorizedConversations(signal, { syncTitles }),
    apiFetch(`/api/threads/${encodeURIComponent(identity.threadId)}/cloud-bindings`, { signal }),
    retryAuthorityRequest,
  ]);
  if (signal.aborted) return null;
  if ([authorized.response, bindingResponse, retryAuthorityResponse].some(deniesOwnerAccess)) {
    return { kind: 'unauthorized' };
  }

  const [bindingBody, retryAuthorityBody] = await Promise.all([
    bindingResponse.json().catch(() => ({})) as Promise<CloudBindingsResponse>,
    retryAuthorityResponse?.json().catch(() => ({})) as Promise<RetryAuthorityResponse | undefined>,
  ]);
  if (signal.aborted) return null;
  if (!authorized.response.ok) {
    return { kind: 'error', message: authorized.body.error ?? `授权会话读取失败 (${authorized.response.status})` };
  }
  if (!bindingResponse.ok) {
    return { kind: 'error', message: bindingBody.error ?? `当前 Thread 绑定读取失败 (${bindingResponse.status})` };
  }

  const { candidates } = authorized;
  const rawBinding = bindingBody.bindings?.[identity.targetCatId];
  const binding = rawBinding === undefined ? null : parseChatGptConversationUrl(rawBinding);
  const retryState = projectRetryState(retryAuthorityResponse, retryAuthorityBody);
  return {
    kind: 'ready',
    candidates,
    boundConversationId:
      binding && candidates.some((candidate) => candidate.conversationId === binding.conversationId)
        ? binding.conversationId
        : null,
    ...retryState,
    ...projectPersonalChromeRecoveryStatus(authorized.body),
  };
}

/**
 * The conversation bound to `targetCatId` in the thread, read after any read already in flight (it may
 * predate a write): `null` when none is, `undefined` when the binding cannot be read.
 */
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
    `/api/messages/${encodeURIComponent(sourceMessageId)}/queue-targets/${encodeURIComponent(targetCatId)}/retry`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!args.isCurrent()) return false;
  if (response.ok) return true;
  const stale =
    response.status === 409 &&
    (body.code === 'QUEUE_RETRY_AUTHORITY_STALE' || body.code === 'QUEUE_TARGET_NOT_RETRYABLE');
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
