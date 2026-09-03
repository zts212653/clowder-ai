import type {
  AgentCarrierSession,
  ProviderNativeGoal,
  ProviderNativeGoalRequest,
  ProviderNativeGoalStatus,
} from '../../types.js';
import { asCodexAppServerRecord } from './CodexAppServerEventMapper.js';
import { runCodexAppServerNativeRpc } from './CodexAppServerNativeRpc.js';

const GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);

export async function requestCodexAppServerGoal(input: {
  readonly wire: AgentCarrierSession;
  readonly threadId: string;
  readonly timeoutMs: number;
  readonly request: ProviderNativeGoalRequest;
}): Promise<ProviderNativeGoal> {
  return runCodexAppServerNativeRpc({
    wire: input.wire,
    threadId: input.threadId,
    timeoutMs: input.timeoutMs,
    run: async (client) => {
      const params = goalParams(input.threadId, input.request);
      const response = await client.request(`thread/goal/${input.request.action}`, params);
      return parseGoalResponse(input.threadId, input.request.action, response);
    },
  });
}

function goalParams(threadId: string, request: ProviderNativeGoalRequest): Record<string, unknown> {
  if (request.action !== 'set') return { threadId };
  return {
    threadId,
    objective: request.objective,
    status: request.status,
    ...(request.tokenBudget !== undefined ? { tokenBudget: request.tokenBudget } : {}),
  };
}

function parseGoalResponse(
  threadId: string,
  action: ProviderNativeGoalRequest['action'],
  value: unknown,
): ProviderNativeGoal {
  const response = asCodexAppServerRecord(value);
  if (action === 'clear') {
    if (response?.cleared !== true) throw new Error('authoritative_native_goal_response_invalid');
    return { action, runtimeSessionId: threadId, goal: null };
  }
  if (action === 'get' && response?.goal === null) return { action, runtimeSessionId: threadId, goal: null };
  const goal = asCodexAppServerRecord(response?.goal);
  if (
    goal?.threadId !== threadId ||
    typeof goal.objective !== 'string' ||
    !GOAL_STATUSES.has(String(goal.status)) ||
    !isFiniteNumber(goal.createdAt) ||
    !isFiniteNumber(goal.updatedAt)
  ) {
    throw new Error('authoritative_native_goal_response_invalid');
  }
  return {
    action,
    runtimeSessionId: threadId,
    goal: {
      objective: goal.objective,
      status: goal.status as ProviderNativeGoalStatus,
      tokenBudget: isFiniteNumber(goal.tokenBudget) ? goal.tokenBudget : null,
      tokensUsed: isFiniteNumber(goal.tokensUsed) ? goal.tokensUsed : 0,
      timeUsedSeconds: isFiniteNumber(goal.timeUsedSeconds) ? goal.timeUsedSeconds : 0,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
