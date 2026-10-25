import type { CatId, RoutingPreflightDecisionV1 } from '@cat-cafe/shared';
import { executionFactsChanged } from '../../../../routing-context/preflight/RoutingQueueAdmissionObservation.js';
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
  _originalTarget: boolean,
): Promise<AgentMessage | undefined> {
  const receipt = routingDispatchPreflightReceipt(decision, catId);
  if (receipt.target.disposition === 'allowed' && !executionFactsChanged(options.routingAdmission, decision, catId))
    return undefined;
  if (receipt.target.disposition === 'rejected') await options.onRoutingPreflightRejected?.(receipt.target);
  if (options.beforeOutputCommit && !(await options.beforeOutputCommit(catId))) {
    if (options.persistenceContext) options.persistenceContext.actionOutputCommitRejected = true;
    return undefined;
  }
  const payload = {
    ...receipt,
    ...(options.currentUserMessageId ? { sourceMessageId: options.currentUserMessageId } : {}),
  };
  const content = JSON.stringify(payload);
  // History is fed back into agent prompts. Keep the exact C in durable metadata
  // and the live notice, while its readable body carries the warnings and provenance.
  const historyContent = JSON.stringify({
    type: receipt.type,
    stage: receipt.stage,
    projection: 'summary',
    ...(receipt.snapshotRef ? { snapshotRef: receipt.snapshotRef } : {}),
    target: {
      targetCatId: receipt.target.targetCatId,
      disposition: receipt.target.disposition,
      reasons: receipt.target.reasons.map(({ code, summary }) => ({ code, summary })),
      ...(receipt.target.ownerAttempt ? { ownerAttempt: true } : {}),
      ...(receipt.target.automaticRetryAt !== undefined ? { automaticRetryAt: receipt.target.automaticRetryAt } : {}),
    },
  });
  const timestamp = Date.now();
  let messageId: string | undefined;
  try {
    const stored = await deps.messageStore.append({
      userId: 'system',
      from: { kind: 'system', service: 'routing-preflight' },
      threadId,
      timestamp,
      content: historyContent,
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
