import type { CatId, RoutingPreflightDecisionV1 } from '@cat-cafe/shared';
import { routingDispatchPreflightReceipt } from '../../../../routing-context/RoutingDispatchPreflightPort.js';
import type { AgentMessage } from '../../types.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';

/** Persist the same receipt that live clients consume; its source ref is not retry authorization. */
export async function routingPreflightNotice(
  deps: RouteStrategyDeps,
  options: RouteOptions,
  decision: RoutingPreflightDecisionV1,
  catId: CatId,
  threadId: string,
  originalTarget: boolean,
): Promise<AgentMessage | undefined> {
  const receipt = routingDispatchPreflightReceipt(decision, catId);
  if (receipt.target.disposition === 'allowed') return undefined;
  if (options.beforeOutputCommit && !(await options.beforeOutputCommit(catId))) {
    if (options.persistenceContext) options.persistenceContext.actionOutputCommitRejected = true;
    return undefined;
  }
  const payload = {
    ...receipt,
    ...(options.currentUserMessageId ? { sourceMessageId: options.currentUserMessageId } : {}),
    ...(originalTarget && !options.routingQueueSource && options.parentInvocationId
      ? { retryInvocationId: options.parentInvocationId }
      : {}),
  };
  const content = JSON.stringify(payload);
  const timestamp = Date.now();
  let messageId: string | undefined;
  try {
    const stored = await deps.messageStore.append({
      userId: 'system',
      from: { kind: 'system', service: 'routing-preflight' },
      threadId,
      timestamp,
      content,
      mentions: [],
      origin: 'stream',
      extra: { systemInfo: { v: 1, payload, fallbackCatId: catId } },
    });
    messageId = stored.id;
  } catch (error) {
    if (options.persistenceContext) {
      options.persistenceContext.failed = true;
      options.persistenceContext.errors.push({
        catId,
        error: error instanceof Error ? error.message : 'routing receipt persistence failed',
      });
    }
  }
  return { type: 'system_info', catId, content, timestamp, ...(messageId ? { messageId } : {}) };
}
