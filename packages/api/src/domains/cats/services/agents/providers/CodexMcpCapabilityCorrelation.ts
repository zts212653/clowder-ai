type JsonObject = Record<string, unknown>;

export const CODEX_CUA_SERVER_NAME = 'cua_repl';
export const CODEX_BUNDLED_COMPUTER_USE_PLUGIN_ID = 'unified-computer-use@openai-bundled';

interface ProviderTurnBinding {
  readonly threadId: string;
  readonly turnId: string;
}

interface ActiveComputerUseCall {
  readonly tool: string;
  pendingReviewId: string | null;
  approved: boolean;
}

interface CorrelationState {
  readonly activeCalls: Map<string, ActiveComputerUseCall>;
  readonly seenCallIds: Set<string>;
  readonly reviewOwners: Map<string, string>;
  readonly completedReviewIds: Set<string>;
}

export interface CodexMcpCapabilityApprovalEvidence {
  isProviderAutoReviewApproved(input: ProviderTurnBinding & { readonly callId: string }): boolean;
}

export interface CodexMcpCapabilityCorrelation extends CodexMcpCapabilityApprovalEvidence {
  bindProviderTurn(binding: ProviderTurnBinding): void;
  observe(envelope: JsonObject): void;
  close(): void;
}

/**
 * A transport-local correlation window for provider-native Computer Use.
 * It is deliberately neither persisted nor shared across turns or carriers.
 */
export function createCodexMcpCapabilityCorrelation(): CodexMcpCapabilityCorrelation {
  let binding: ProviderTurnBinding | null = null;
  let closed = false;
  let sealed = false;
  const state: CorrelationState = {
    activeCalls: new Map(),
    seenCallIds: new Set(),
    reviewOwners: new Map(),
    completedReviewIds: new Set(),
  };

  const clear = (): void => {
    state.activeCalls.clear();
    state.seenCallIds.clear();
    state.reviewOwners.clear();
    state.completedReviewIds.clear();
  };

  return {
    bindProviderTurn(nextBinding) {
      if (closed || sealed) return;
      if (binding) {
        if (binding.threadId === nextBinding.threadId && binding.turnId === nextBinding.turnId) return;
        sealed = true;
        binding = null;
        clear();
        return;
      }
      clear();
      binding = { ...nextBinding };
    },
    observe(envelope) {
      if (closed || !binding) return;
      observeBoundEnvelope(envelope, binding, state, () => {
        sealed = true;
        binding = null;
        clear();
      });
    },
    isProviderAutoReviewApproved(input) {
      if (closed || !binding || input.threadId !== binding.threadId || input.turnId !== binding.turnId) return false;
      return state.activeCalls.get(input.callId)?.approved === true;
    },
    close() {
      if (closed) return;
      closed = true;
      sealed = true;
      binding = null;
      clear();
    },
  };
}

function observeBoundEnvelope(
  envelope: JsonObject,
  binding: ProviderTurnBinding,
  state: CorrelationState,
  sealTurn: () => void,
): void {
  const method = envelope.method;
  const params = asRecord(envelope.params);
  if (!params) return;
  if (method === 'turn/completed') {
    if (isBoundTurnCompletion(params, binding)) sealTurn();
    return;
  }
  if (!matchesBinding(params, binding)) return;
  if (method === 'item/started') {
    observeItemStarted(params, state);
    return;
  }
  if (method === 'item/completed') {
    observeItemCompleted(params, state);
    return;
  }
  if (method === 'item/autoApprovalReview/started') {
    observeReviewStarted(params, state);
    return;
  }
  if (method === 'item/autoApprovalReview/completed') observeReviewCompleted(params, state);
}

function isBoundTurnCompletion(params: JsonObject, binding: ProviderTurnBinding): boolean {
  const turn = asRecord(params.turn);
  return params.threadId === binding.threadId && turn?.id === binding.turnId;
}

function observeItemStarted(params: JsonObject, state: CorrelationState): void {
  const item = asRecord(params.item);
  const callId = exactCoordinate(item?.id);
  if (!callId) return;
  if (state.seenCallIds.has(callId)) {
    state.activeCalls.delete(callId);
    return;
  }
  state.seenCallIds.add(callId);
  const tool = nonBlankString(item?.tool);
  if (
    item?.type !== 'mcpToolCall' ||
    item.status !== 'inProgress' ||
    item.server !== CODEX_CUA_SERVER_NAME ||
    item.pluginId !== CODEX_BUNDLED_COMPUTER_USE_PLUGIN_ID ||
    !tool
  ) {
    return;
  }
  state.activeCalls.set(callId, { tool, pendingReviewId: null, approved: false });
}

function observeItemCompleted(params: JsonObject, state: CorrelationState): void {
  const item = asRecord(params.item);
  const callId = exactCoordinate(item?.id);
  if (!callId) return;
  state.seenCallIds.add(callId);
  state.activeCalls.delete(callId);
}

function observeReviewStarted(params: JsonObject, state: CorrelationState): void {
  const callId = exactCoordinate(params.targetItemId);
  const active = callId ? state.activeCalls.get(callId) : undefined;
  if (active) {
    active.approved = false;
    active.pendingReviewId = null;
  }
  const reviewId = exactCoordinate(params.reviewId);
  if (!reviewId) return;
  const previousOwner = state.reviewOwners.get(reviewId);
  if (previousOwner !== undefined) {
    state.activeCalls.delete(previousOwner);
    if (callId) state.activeCalls.delete(callId);
    return;
  }
  state.reviewOwners.set(reviewId, callId ?? '');
  if (!active || !matchesReview(params, active.tool, 'inProgress')) return;
  active.pendingReviewId = reviewId;
}

function observeReviewCompleted(params: JsonObject, state: CorrelationState): void {
  const callId = exactCoordinate(params.targetItemId);
  const reviewId = exactCoordinate(params.reviewId);
  const active = callId ? state.activeCalls.get(callId) : undefined;
  if (active) active.approved = false;
  if (!reviewId) {
    if (callId) state.activeCalls.delete(callId);
    return;
  }
  const owner = state.reviewOwners.get(reviewId);
  if (owner === undefined) {
    state.reviewOwners.set(reviewId, callId ?? '');
    state.completedReviewIds.add(reviewId);
    if (callId) state.activeCalls.delete(callId);
    return;
  }
  if (state.completedReviewIds.has(reviewId) || !callId || owner !== callId) {
    state.activeCalls.delete(owner);
    if (callId) state.activeCalls.delete(callId);
    state.completedReviewIds.add(reviewId);
    return;
  }
  state.completedReviewIds.add(reviewId);
  if (!active || active.pendingReviewId !== reviewId) {
    state.activeCalls.delete(owner);
    return;
  }
  active.pendingReviewId = null;
  active.approved = matchesReview(params, active.tool, 'approved');
}

function matchesReview(params: JsonObject, tool: string, status: 'inProgress' | 'approved'): boolean {
  const review = asRecord(params.review);
  const action = asRecord(params.action);
  return (
    review?.status === status &&
    action?.type === 'mcpToolCall' &&
    action.server === CODEX_CUA_SERVER_NAME &&
    action.toolName === tool
  );
}

function matchesBinding(params: JsonObject, binding: ProviderTurnBinding): boolean {
  return params.threadId === binding.threadId && params.turnId === binding.turnId;
}

function asRecord(input: unknown): JsonObject | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as JsonObject) : null;
}

function nonBlankString(input: unknown): string | null {
  return typeof input === 'string' && input.trim() ? input : null;
}

function exactCoordinate(input: unknown): string | null {
  return typeof input === 'string' && input.length > 0 && input === input.trim() ? input : null;
}
