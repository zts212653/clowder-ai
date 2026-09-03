import type {
  AgentCarrierSession,
  ProviderNativeReview,
  ProviderNativeReviewItem,
  ProviderNativeReviewRequest,
} from '../../types.js';
import { asCodexAppServerRecord, type CodexAppServerJsonObject } from './CodexAppServerEventMapper.js';
import { runCodexAppServerNativeRpc } from './CodexAppServerNativeRpc.js';

interface ReviewCoordinate {
  reviewThreadId: string;
  turnId: string;
}

export async function requestCodexAppServerReview(input: {
  readonly wire: AgentCarrierSession;
  readonly threadId: string;
  readonly timeoutMs: number;
  readonly request: ProviderNativeReviewRequest;
  readonly onUpdate?: (review: ProviderNativeReview) => void | Promise<void>;
}): Promise<ProviderNativeReview> {
  const items: ProviderNativeReviewItem[] = [];
  const completedTurns: CodexAppServerJsonObject[] = [];
  let coordinate: ReviewCoordinate | undefined;
  let resolveTerminal!: (review: ProviderNativeReview) => void;
  const terminal = new Promise<ProviderNativeReview>((resolve) => {
    resolveTerminal = resolve;
  });

  const tryResolveTerminal = () => {
    if (!coordinate) return;
    const message = completedTurns.find((candidate) => matchesTurn(candidate, coordinate as ReviewCoordinate));
    if (message) resolveTerminal(buildTerminalReview(input.threadId, coordinate, items, message));
  };

  return runCodexAppServerNativeRpc({
    wire: input.wire,
    threadId: input.threadId,
    timeoutMs: input.timeoutMs,
    onNotification: async (message) => {
      const item = mapReviewItem(message);
      if (item) items.push(item);
      if (message.method === 'turn/completed') completedTurns.push(message);
      if (coordinate && item) await input.onUpdate?.(runningReview(input.threadId, coordinate, items));
      tryResolveTerminal();
    },
    run: async (client) => {
      const response = asCodexAppServerRecord(
        await client.request('review/start', {
          threadId: input.threadId,
          target: mapReviewTarget(input.request.target),
          delivery: input.request.delivery,
        }),
      );
      const turn = asCodexAppServerRecord(response?.turn);
      if (typeof response?.reviewThreadId !== 'string' || typeof turn?.id !== 'string') {
        throw new Error('authoritative_native_review_response_invalid');
      }
      coordinate = { reviewThreadId: response.reviewThreadId, turnId: turn.id };
      for (const item of mapTurnItems(turn.items)) items.push(item);
      const running = runningReview(input.threadId, coordinate, items);
      await input.onUpdate?.(running);
      if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
        return buildTerminalFromTurn(input.threadId, coordinate, items, turn);
      }
      tryResolveTerminal();
      const result = await terminal;
      await input.onUpdate?.(result);
      return result;
    },
  });
}

function runningReview(
  runtimeSessionId: string,
  coordinate: ReviewCoordinate,
  items: readonly ProviderNativeReviewItem[],
): ProviderNativeReview {
  return { status: 'running', runtimeSessionId, ...coordinate, items: [...items] };
}

function mapReviewTarget(target: ProviderNativeReviewRequest['target']): CodexAppServerJsonObject {
  switch (target.kind) {
    case 'uncommitted_changes':
      return { type: 'uncommittedChanges' };
    case 'base_branch':
      return { type: 'baseBranch', branch: target.branch };
    case 'commit':
      return { type: 'commit', sha: target.sha, ...(target.title ? { title: target.title } : {}) };
    case 'custom':
      return { type: 'custom', instructions: target.instructions };
  }
}

function mapReviewItem(message: CodexAppServerJsonObject): ProviderNativeReviewItem | null {
  if (message.method !== 'item/completed') return null;
  const params = asCodexAppServerRecord(message.params);
  const item = asCodexAppServerRecord(params?.item);
  if (typeof item?.id !== 'string' || typeof params?.completedAtMs !== 'number') return null;
  if (item.type === 'enteredReviewMode' && typeof item.review === 'string') {
    return { id: item.id, kind: 'mode_entered', text: item.review, completedAt: params.completedAtMs };
  }
  if (item.type === 'agentMessage' && typeof item.text === 'string') {
    return { id: item.id, kind: 'message', text: item.text, completedAt: params.completedAtMs };
  }
  if (item.type === 'exitedReviewMode' && typeof item.review === 'string') {
    return { id: item.id, kind: 'mode_exited', text: item.review, completedAt: params.completedAtMs };
  }
  return null;
}

function mapTurnItems(value: unknown): ProviderNativeReviewItem[] {
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  return value.flatMap((raw) => {
    const item = asCodexAppServerRecord(raw);
    if (!item) return [];
    return mapReviewItem({ method: 'item/completed', params: { item, completedAtMs: now } }) ?? [];
  });
}

function matchesTurn(message: CodexAppServerJsonObject, coordinate: ReviewCoordinate): boolean {
  const params = asCodexAppServerRecord(message.params);
  const turn = asCodexAppServerRecord(params?.turn);
  return params?.threadId === coordinate.reviewThreadId && turn?.id === coordinate.turnId;
}

function buildTerminalReview(
  runtimeSessionId: string,
  coordinate: ReviewCoordinate,
  items: readonly ProviderNativeReviewItem[],
  message: CodexAppServerJsonObject,
): ProviderNativeReview {
  const turn = asCodexAppServerRecord(asCodexAppServerRecord(message.params)?.turn);
  return buildTerminalFromTurn(runtimeSessionId, coordinate, items, turn);
}

function buildTerminalFromTurn(
  runtimeSessionId: string,
  coordinate: ReviewCoordinate,
  items: readonly ProviderNativeReviewItem[],
  turn: CodexAppServerJsonObject | null,
): ProviderNativeReview {
  const completed = turn?.status === 'completed';
  const summary = [...items].reverse().find((item) => item.kind === 'mode_exited' || item.kind === 'message')?.text;
  const error = asCodexAppServerRecord(turn?.error);
  return {
    status: completed ? 'completed' : 'failed',
    runtimeSessionId,
    ...coordinate,
    items: [...items],
    result: {
      status: completed ? 'completed' : 'failed',
      ...(summary ? { summary } : {}),
      ...(!completed
        ? {
            errorCode:
              turn?.status === 'interrupted'
                ? 'provider_review_interrupted'
                : typeof error?.message === 'string'
                  ? 'provider_review_failed'
                  : 'unknown_failure',
          }
        : {}),
    },
  };
}
