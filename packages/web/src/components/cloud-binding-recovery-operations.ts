import { apiFetch } from '@/utils/api-client';
import { parseChatGptConversationUrl } from '@/utils/chatgpt-chat-url';
import { projectPersonalChromeRecoveryStatus } from './cloud-binding-recovery-status';

export interface AuthorizedConversationCandidate {
  conversationId: string;
  chatUrl: string;
  displayTitle?: string;
  authorizedAt: string;
  updatedAt: string;
}

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

interface PersonalChromeStateResponse {
  authorization?: { conversations?: unknown };
  artifact?: { helper?: string };
  live?: { status?: string };
  titleSync?: { status?: string; errorCode?: string; updatedCount?: number; requestedCount?: number };
  error?: string;
}

interface CloudBindingsResponse {
  bindings?: Record<string, unknown>;
  error?: string;
  code?: string;
}

function safeDisplayTitle(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 160) return undefined;
  const invalid = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint < 32 ||
      codePoint === 127 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
  if (invalid) return undefined;
  const title = value.trim().replace(/\s+/g, ' ');
  return title && !/^(ChatGPT|New chat|新聊天)$/iu.test(title) ? title : undefined;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

function deniesOwnerAccess(response: Response | null): boolean {
  return response?.status === 401 || response?.status === 403;
}

function authorizedCandidates(value: unknown): AuthorizedConversationCandidate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const candidates: AuthorizedConversationCandidate[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const conversationId = (raw as { conversationId?: unknown }).conversationId;
    if (typeof conversationId !== 'string') continue;
    const parsed = parseChatGptConversationUrl(`https://chatgpt.com/c/${conversationId}`);
    if (!parsed || parsed.conversationId !== conversationId || seen.has(conversationId)) continue;
    const authorizedAt = canonicalTimestamp((raw as { authorizedAt?: unknown }).authorizedAt);
    const updatedAt = canonicalTimestamp((raw as { updatedAt?: unknown }).updatedAt);
    if (!authorizedAt || !updatedAt || updatedAt < authorizedAt) continue;
    seen.add(conversationId);
    const displayTitle = safeDisplayTitle((raw as { displayTitle?: unknown }).displayTitle);
    candidates.push({ ...parsed, authorizedAt, updatedAt, ...(displayTitle ? { displayTitle } : {}) });
  }
  return candidates.sort((left, right) => right.authorizedAt.localeCompare(left.authorizedAt));
}

export async function readRecoveryState(
  identity: RecoveryIdentity,
  signal: AbortSignal,
  syncTitles = false,
): Promise<RecoveryLoadState | null> {
  const [pluginResponse, bindingResponse] = await Promise.all([
    syncTitles
      ? apiFetch('/api/plugins/personal-chrome/refresh-titles', { method: 'POST', signal })
      : apiFetch('/api/plugins/personal-chrome', { signal }),
    apiFetch(`/api/threads/${encodeURIComponent(identity.threadId)}/cloud-bindings`, { signal }),
  ]);
  if (signal.aborted) return null;
  if ([pluginResponse, bindingResponse].some(deniesOwnerAccess)) {
    return { kind: 'unauthorized' };
  }

  const [pluginBody, bindingBody] = await Promise.all([
    pluginResponse.json().catch(() => ({})) as Promise<PersonalChromeStateResponse>,
    bindingResponse.json().catch(() => ({})) as Promise<CloudBindingsResponse>,
  ]);
  if (signal.aborted) return null;
  if (!pluginResponse.ok) {
    return { kind: 'error', message: pluginBody.error ?? `授权会话读取失败 (${pluginResponse.status})` };
  }
  if (!bindingResponse.ok) {
    return { kind: 'error', message: bindingBody.error ?? `当前 Thread 绑定读取失败 (${bindingResponse.status})` };
  }

  const candidates = authorizedCandidates(pluginBody.authorization?.conversations);
  const rawBinding = bindingBody.bindings?.['gpt-pro'];
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
    ...projectPersonalChromeRecoveryStatus(pluginBody),
  };
}

async function persistSelectedRoute(args: {
  identity: RecoveryIdentity;
  selected: AuthorizedConversationCandidate;
  routeIsBound: boolean;
  isCurrent: () => boolean;
  onBound: () => void;
}): Promise<boolean> {
  if (args.routeIsBound) return true;
  const { threadId, targetCatId } = args.identity;
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/cloud-bindings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catId: targetCatId, chatUrl: args.selected.chatUrl }),
  });
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
