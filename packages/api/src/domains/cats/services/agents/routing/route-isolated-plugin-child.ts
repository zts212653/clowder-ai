import { commitLifecycleResponseFromAppendInput } from '../../stores/ports/MessageStore.js';
import type { AgentMessage } from '../../types.js';
import { type InvocationParams, invokeSingleCat } from '../invocation/invoke-single-cat.js';
import { accumulateTextAggregate } from '../text-aggregation.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';

/** Shared terminal/output handling, after a lane has validated and built its isolated child input. */
export async function* routeIsolatedPluginChild(
  deps: RouteStrategyDeps,
  params: InvocationParams,
  options: Pick<RouteOptions, 'beforeOutputCommit' | 'persistenceContext' | 'parentInvocationId'>,
  lane: 'public',
): AsyncIterable<AgentMessage> {
  const { userId, threadId, catId } = params;
  let childId: string | undefined;
  let responseMessageId: string | undefined;
  let text = '';
  let done: AgentMessage | undefined;
  let failed = false;
  const signal = params.signal;
  for await (const event of invokeSingleCat(deps.invocationDeps, params)) {
    if (event.turnInvocationId) {
      if (childId && childId !== event.turnInvocationId) throw new Error(`${lane}_route_child_changed`);
      childId = event.turnInvocationId;
    }
    if (event.lifecycleResponseMessageId) responseMessageId = event.lifecycleResponseMessageId;
    if (event.type === 'text') {
      text = accumulateTextAggregate(text, event.content ?? '', event.textMode);
      continue;
    }
    if (event.type === 'error') failed = true;
    if (event.type === 'done') {
      if (done || !childId) throw new Error(`${lane}_route_done_invalid`);
      done = event;
      continue;
    }
    yield event;
  }
  const child = childId ? await deps.invocationDeps.turnExecutionStore?.get(childId) : null;
  if (failed || !done || !childId || child?.status !== 'succeeded') throw new Error(`${lane}_route_child_unsuccessful`);
  signal?.throwIfAborted();
  if (!responseMessageId) throw new Error(`${lane}_route_response_missing`);
  if (options.beforeOutputCommit && !(await options.beforeOutputCommit(catId)))
    throw new Error(`${lane}_route_output_rejected`);
  signal?.throwIfAborted();
  // Main History owns the response, including successful turns without text.
  // A Host transcript has no plugin payload and is not a business reply receipt.
  const message = await commitLifecycleResponseFromAppendInput(
    deps.messageStore,
    responseMessageId,
    childId,
    { status: 'completed', completedAt: Date.now() },
    {
      userId,
      threadId,
      from: { kind: 'agent', catId },
      content: text,
      timestamp: Date.now(),
      mentions: [],
      origin: 'stream',
      extra: { stream: { invocationId: options.parentInvocationId ?? childId, turnInvocationId: childId } },
    },
  );
  options.persistenceContext?.persistedOutputMessageIds?.push(message.id);
  if (text.trim())
    yield {
      type: 'text',
      catId,
      content: message.content,
      textMode: 'replace',
      timestamp: message.timestamp,
      turnInvocationId: childId,
    };
  yield done;
}
