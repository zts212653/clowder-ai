import type { CatInvocationInfo, ChatMessage, ChatMessagePatch } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type ActiveInvocationSlots = Record<string, { catId: string; mode: string; startedAt?: number }>;

export type InvocationReconciliationPhase = 'running' | 'succeeded' | 'failed' | 'canceled' | 'unknown_running';
export type InvocationTerminalPhase = Extract<InvocationReconciliationPhase, 'succeeded' | 'failed' | 'canceled'>;

export interface InvocationTimeoutCandidate {
  invocationId: string;
  slotKeys: string[];
  catIds: string[];
  turnInvocationIds: string[];
}

interface InvocationRecordProjection {
  id: string;
  threadId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  error?: string;
  updatedAt: number;
}

const INVOCATION_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'canceled']);
export const INVOCATION_RECONCILIATION_POLL_MS = 30_000;

const scheduledReconciliations = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightReconciliations = new Map<string, Promise<void>>();

export interface InvocationReconciliationResult {
  phase: InvocationReconciliationPhase;
  invocationId: string;
  error?: string;
  reason?: 'record_not_found' | 'record_unavailable' | 'record_mismatch';
  updatedAt: number;
}

function normalizeParentInvocationId(slotKey: string, catId: string): string | null {
  if (slotKey.startsWith('hydrated-')) return null;
  const suffix = `-${catId}`;
  return slotKey.endsWith(suffix) ? slotKey.slice(0, -suffix.length) : slotKey;
}

/**
 * Collapse the UI's per-cat slot keys onto the canonical parent invocation id.
 * The parent remains the cancel/liveness key; turn ids are retained as receipts.
 */
export function collectInvocationTimeoutCandidates(
  activeInvocations: ActiveInvocationSlots,
  catInvocations: Record<string, CatInvocationInfo> | undefined,
): InvocationTimeoutCandidate[] {
  const candidates = new Map<string, { slotKeys: Set<string>; catIds: Set<string>; turnInvocationIds: Set<string> }>();

  for (const [slotKey, slot] of Object.entries(activeInvocations)) {
    const direct = catInvocations?.[slot.catId];
    const slotInvocationId = normalizeParentInvocationId(slotKey, slot.catId);
    const directMatchesSlot =
      direct?.invocationId !== undefined &&
      (direct.invocationId === slotInvocationId || (slotInvocationId === null && slotKey.startsWith('hydrated-')));
    const invocationId = directMatchesSlot ? direct.invocationId : slotInvocationId;
    if (!invocationId) continue;
    const candidate = candidates.get(invocationId) ?? {
      slotKeys: new Set<string>(),
      catIds: new Set<string>(),
      turnInvocationIds: new Set<string>(),
    };
    candidate.slotKeys.add(slotKey);
    candidate.catIds.add(slot.catId);
    if (directMatchesSlot && direct?.turnInvocationId) candidate.turnInvocationIds.add(direct.turnInvocationId);
    candidates.set(invocationId, candidate);
  }

  return [...candidates.entries()].map(([invocationId, candidate]) => ({
    invocationId,
    slotKeys: [...candidate.slotKeys],
    catIds: [...candidate.catIds],
    turnInvocationIds: [...candidate.turnInvocationIds],
  }));
}

export async function queryInvocationReconciliation(
  threadId: string,
  invocationId: string,
): Promise<InvocationReconciliationResult> {
  const updatedAt = Date.now();
  try {
    const response = await apiFetch(`/api/invocations/${encodeURIComponent(invocationId)}`);
    if (response.status === 404) {
      return { phase: 'unknown_running', invocationId, reason: 'record_not_found', updatedAt };
    }
    if (!response.ok) {
      return { phase: 'unknown_running', invocationId, reason: 'record_unavailable', updatedAt };
    }
    const record = (await response.json()) as InvocationRecordProjection;
    if (
      record.id !== invocationId ||
      record.threadId !== threadId ||
      !INVOCATION_STATUSES.has(record.status) ||
      typeof record.updatedAt !== 'number'
    ) {
      return { phase: 'unknown_running', invocationId, reason: 'record_mismatch', updatedAt };
    }
    if (record.status === 'queued' || record.status === 'running') {
      return { phase: 'running', invocationId, updatedAt: record.updatedAt };
    }
    return {
      phase: record.status,
      invocationId,
      ...(record.error ? { error: record.error } : {}),
      updatedAt: record.updatedAt,
    };
  } catch {
    return { phase: 'unknown_running', invocationId, reason: 'record_unavailable', updatedAt };
  }
}

function reconciliationNotice(
  candidate: InvocationTimeoutCandidate,
  result: InvocationReconciliationResult,
): ChatMessage {
  const id = `invocation-status-${candidate.invocationId}`;
  let variant: ChatMessage['variant'] = 'info';
  let content: string;

  switch (result.phase) {
    case 'running':
      content = `Client wait window ended; execution is still running and can still be canceled. ID: ${candidate.invocationId}`;
      break;
    case 'succeeded':
      content = `Execution completed after the client wait window; syncing final messages. ID: ${candidate.invocationId}`;
      break;
    case 'failed':
      variant = 'error';
      content = `Execution failed. ID: ${candidate.invocationId}${result.error ? ` — ${result.error}` : ''}`;
      break;
    case 'canceled':
      content = `Execution was canceled. ID: ${candidate.invocationId}`;
      break;
    case 'unknown_running':
      content = `Client wait window ended. Canonical status could not be verified, so the running slot was retained. ID: ${candidate.invocationId}`;
      break;
  }

  return {
    id,
    type: 'system',
    variant,
    content,
    timestamp: result.updatedAt,
    extra: {
      invocationReconciliation: {
        v: 1,
        invocationId: candidate.invocationId,
        catIds: candidate.catIds,
        turnInvocationIds: candidate.turnInvocationIds,
        phase: result.phase,
        ...(result.reason ? { reason: result.reason } : {}),
        updatedAt: result.updatedAt,
      },
    },
  };
}

function currentCandidate(threadId: string, invocationId: string): InvocationTimeoutCandidate | undefined {
  const state = useChatStore.getState().getThreadState(threadId);
  return collectInvocationTimeoutCandidates(state.activeInvocations ?? {}, state.catInvocations).find(
    (candidate) => candidate.invocationId === invocationId,
  );
}

function candidateFromNotice(message: ChatMessage | undefined): InvocationTimeoutCandidate | undefined {
  const projection = message?.extra?.invocationReconciliation;
  if (!projection) return undefined;
  return {
    invocationId: projection.invocationId,
    slotKeys: [],
    catIds: projection.catIds,
    turnInvocationIds: projection.turnInvocationIds,
  };
}

function unresolvedCandidateFromNotice(message: ChatMessage | undefined): InvocationTimeoutCandidate | undefined {
  const phase = message?.extra?.invocationReconciliation?.phase;
  if (phase !== 'running' && phase !== 'unknown_running') return undefined;
  return candidateFromNotice(message);
}

function unresolvedNoticeCandidate(threadId: string, invocationId: string): InvocationTimeoutCandidate | undefined {
  const notice = useChatStore
    .getState()
    .getThreadState(threadId)
    .messages.find((message) => message.id === `invocation-status-${invocationId}`);
  return unresolvedCandidateFromNotice(notice);
}

function directIdentityMatches(
  direct: CatInvocationInfo | undefined,
  invocationId: string,
  turnInvocationId: string | undefined,
): boolean {
  if (direct?.invocationId !== invocationId) return false;
  if (turnInvocationId && direct.turnInvocationId && direct.turnInvocationId !== turnInvocationId) return false;
  return true;
}

function upsertNotice(threadId: string, message: ChatMessage): void {
  const store = useChatStore.getState();
  const existing = store.getThreadState(threadId).messages.some((item) => item.id === message.id);
  if (existing) {
    const patch: ChatMessagePatch = {
      variant: message.variant,
      content: message.content,
      timestamp: message.timestamp,
      extra: message.extra,
      cachedFrom: undefined,
    };
    store.patchThreadMessage(threadId, message.id, patch);
  } else {
    store.addMessageToThread(threadId, message);
  }
}

interface InvocationTerminalizationInput {
  threadId: string;
  invocationId: string;
  phase: InvocationTerminalPhase;
  catId?: string;
  turnInvocationId?: string;
  error?: string;
  candidate?: InvocationTimeoutCandidate;
  projectNotice?: boolean;
  removeActiveSlots?: boolean;
}

function clearMatchingDirectIdentities(
  threadId: string,
  invocationId: string,
  targetCatIds: readonly string[],
  eventCatId: string | undefined,
  turnInvocationId: string | undefined,
  clearTurnIdentity: boolean,
): void {
  const store = useChatStore.getState();
  for (const targetCatId of targetCatIds) {
    const direct =
      store.currentThreadId === threadId
        ? store.catInvocations?.[targetCatId]
        : store.getThreadState(threadId).catInvocations?.[targetCatId];
    const expectedTurnId = eventCatId === targetCatId ? turnInvocationId : undefined;
    if (!directIdentityMatches(direct, invocationId, expectedTurnId)) continue;
    const patch: Partial<CatInvocationInfo> = {
      invocationId: undefined,
      ...(clearTurnIdentity ? { turnInvocationId: undefined } : {}),
    };
    if (store.currentThreadId === threadId) {
      store.setCatInvocation(targetCatId, patch);
    } else {
      store.setThreadCatInvocation(threadId, targetCatId, patch);
    }
  }
}

function projectTerminalNotice(
  input: InvocationTerminalizationInput,
  candidate: InvocationTimeoutCandidate | undefined,
  existingNotice: ChatMessage | undefined,
): boolean {
  const existingPhase = existingNotice?.extra?.invocationReconciliation?.phase;
  const alreadyTerminal = existingPhase && existingPhase !== 'running' && existingPhase !== 'unknown_running';
  const mayCreateNotice = existingNotice !== undefined || input.candidate !== undefined;
  if (input.projectNotice === false || !candidate || alreadyTerminal || !mayCreateNotice) return false;
  upsertNotice(
    input.threadId,
    reconciliationNotice(candidate, {
      phase: input.phase,
      invocationId: input.invocationId,
      ...(input.error ? { error: input.error } : {}),
      updatedAt: Date.now(),
    }),
  );
  return true;
}

function applyMissingSocketCleanup(
  threadId: string,
  candidate: InvocationTimeoutCandidate | undefined,
  targetCatIds: readonly string[],
  phase: InvocationTerminalPhase,
): void {
  if (!candidate) return;
  const store = useChatStore.getState();
  const snapshot = store.getThreadState(threadId);
  const uiOwnedCatIds = targetCatIds.filter((targetCatId) => {
    const direct = snapshot.catInvocations?.[targetCatId];
    if (direct?.invocationId && direct.invocationId !== candidate.invocationId) return false;

    const realParentIds = Object.entries(snapshot.activeInvocations ?? {}).flatMap(([slotKey, slot]) => {
      if (slot.catId !== targetCatId) return [];
      const parentId = normalizeParentInvocationId(slotKey, slot.catId);
      return parentId ? [parentId] : [];
    });
    if (realParentIds.some((parentId) => parentId !== candidate.invocationId)) return false;
    return direct?.invocationId === candidate.invocationId || realParentIds.includes(candidate.invocationId);
  });

  for (const slotKey of candidate.slotKeys) store.removeThreadActiveInvocation(threadId, slotKey);
  for (const targetCatId of uiOwnedCatIds) {
    store.updateThreadCatStatus(threadId, targetCatId, phase === 'failed' ? 'error' : 'done');
  }
  for (const message of store.getThreadState(threadId).messages) {
    if (message.type !== 'assistant' || !message.catId || !uiOwnedCatIds.includes(message.catId)) continue;
    store.setThreadMessageStreaming(threadId, message.id, false);
  }
}

/**
 * Project one correlated terminal outcome onto the existing timeout notice and
 * clean up only identities that still name that exact execution. Socket events
 * and InvocationRecord polling both use this writer, so the first terminal
 * transition wins and late duplicates cannot regress the visible outcome.
 */
export function terminalizeInvocationReconciliation(input: InvocationTerminalizationInput): void {
  const { threadId, invocationId } = input;
  const store = useChatStore.getState();
  const noticeId = `invocation-status-${invocationId}`;
  const existingNotice = store.getThreadState(threadId).messages.find((message) => message.id === noticeId);
  const activeCandidate = currentCandidate(threadId, invocationId);
  const noticeCandidate = candidateFromNotice(existingNotice);
  const candidate = input.candidate ?? activeCandidate ?? noticeCandidate;
  const targetCatIds = input.catId ? [input.catId] : (candidate?.catIds ?? []);

  clearMatchingDirectIdentities(
    threadId,
    invocationId,
    targetCatIds,
    input.catId,
    input.turnInvocationId,
    input.catId === undefined || input.turnInvocationId !== undefined,
  );
  const projectedTerminalNotice = projectTerminalNotice(input, candidate, existingNotice);

  // HTTP terminal reconciliation owns the missing socket cleanup. Socket
  // handlers already own their normal status/bubble teardown and call this
  // helper only for identity + notice convergence.
  if (input.removeActiveSlots) applyMissingSocketCleanup(threadId, candidate, targetCatIds, input.phase);
  if (input.removeActiveSlots || projectedTerminalNotice) store.requestStreamCatchUp(threadId);
}

function applyReconciliationResult(
  threadId: string,
  candidate: InvocationTimeoutCandidate,
  result: InvocationReconciliationResult,
): void {
  const store = useChatStore.getState();
  const activeCandidate = currentCandidate(threadId, candidate.invocationId);
  const noticeCandidate = unresolvedNoticeCandidate(threadId, candidate.invocationId);
  const currentProjection = activeCandidate ?? noticeCandidate;
  if (!currentProjection) return;

  if (result.phase === 'running' || result.phase === 'unknown_running') {
    upsertNotice(threadId, reconciliationNotice(currentProjection, result));
    if (activeCandidate) {
      for (const catId of activeCandidate.catIds) store.updateThreadCatStatus(threadId, catId, 'alive_but_silent');
    }
    return;
  }

  terminalizeInvocationReconciliation({
    threadId,
    invocationId: candidate.invocationId,
    phase: result.phase,
    ...(result.error ? { error: result.error } : {}),
    candidate: currentProjection,
    removeActiveSlots: activeCandidate !== undefined,
  });
}

function clearScheduledReconciliation(threadId: string): void {
  const timeout = scheduledReconciliations.get(threadId);
  if (timeout !== undefined) clearTimeout(timeout);
  scheduledReconciliations.delete(threadId);
}

function scheduleReconciliation(threadId: string, invocationIds?: readonly string[]): void {
  if (scheduledReconciliations.has(threadId)) return;
  scheduledReconciliations.set(
    threadId,
    setTimeout(() => {
      scheduledReconciliations.delete(threadId);
      void reconcileTimedOutInvocations(threadId, invocationIds ? { invocationIds } : undefined);
    }, INVOCATION_RECONCILIATION_POLL_MS),
  );
}

/**
 * Presentation timeout reconciliation. InvocationRecord is canonical; this
 * function only updates the rebuildable UI projection and never writes a new
 * lifecycle state machine or retries work automatically.
 */
async function performReconciliation(threadId: string, invocationIds?: readonly string[]): Promise<void> {
  clearScheduledReconciliation(threadId);
  const store = useChatStore.getState();
  const snapshot = store.getThreadState(threadId);
  const requestedIds = invocationIds ? new Set(invocationIds) : undefined;
  const activeCandidates = collectInvocationTimeoutCandidates(
    snapshot.activeInvocations ?? {},
    snapshot.catInvocations,
  );
  const candidatesById = new Map<string, InvocationTimeoutCandidate>();
  for (const message of snapshot.messages) {
    const candidate = unresolvedCandidateFromNotice(message);
    if (candidate) candidatesById.set(candidate.invocationId, candidate);
  }
  for (const candidate of activeCandidates) candidatesById.set(candidate.invocationId, candidate);
  const candidates = [...candidatesById.values()].filter(
    (candidate) => !requestedIds || requestedIds.has(candidate.invocationId),
  );

  if (candidates.length === 0) {
    store.requestStreamCatchUp(threadId);
    return;
  }
  store.setThreadLoading(threadId, false);

  const results = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      result: await queryInvocationReconciliation(threadId, candidate.invocationId),
    })),
  );

  // A terminal socket/callback event may have won while HTTP was in flight;
  // applyReconciliationResult rechecks activity before projecting anything.
  for (const { candidate, result } of results) applyReconciliationResult(threadId, candidate, result);

  const needsContinuedReconciliation = results.some(
    ({ candidate, result }) =>
      (result.phase === 'running' || result.phase === 'unknown_running') &&
      (currentCandidate(threadId, candidate.invocationId) !== undefined ||
        unresolvedNoticeCandidate(threadId, candidate.invocationId) !== undefined),
  );
  if (needsContinuedReconciliation) scheduleReconciliation(threadId, invocationIds);
}

export function reconcileTimedOutInvocations(
  threadId: string,
  options?: { invocationIds?: readonly string[] },
): Promise<void> {
  const existing = inFlightReconciliations.get(threadId);
  if (existing) return existing;
  const reconciliation = performReconciliation(threadId, options?.invocationIds).finally(() => {
    if (inFlightReconciliations.get(threadId) === reconciliation) inFlightReconciliations.delete(threadId);
  });
  inFlightReconciliations.set(threadId, reconciliation);
  return reconciliation;
}

/** Resume timeout projections that survived F5, even after `/queue` became empty. */
export function resumeInvocationReconciliationAfterHydration(threadId: string): void {
  const snapshot = useChatStore.getState().getThreadState(threadId);
  const unresolvedIds = snapshot.messages.flatMap((message) => {
    const projection = message.extra?.invocationReconciliation;
    if (!projection || (projection.phase !== 'running' && projection.phase !== 'unknown_running')) {
      return [];
    }
    return [projection.invocationId];
  });
  if (unresolvedIds.length > 0) {
    void reconcileTimedOutInvocations(threadId, { invocationIds: [...new Set(unresolvedIds)] });
  }
}
