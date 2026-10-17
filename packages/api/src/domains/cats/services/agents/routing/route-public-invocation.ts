import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';
import { routeIsolatedPluginChild } from './route-isolated-plugin-child.js';

/** Isolated execution precedes owner history; business replies belong to the plugin's native methods. */
export async function* routePublicInvocation(
  deps: RouteStrategyDeps,
  input: {
    userId: string;
    threadId: string;
    userMessageId: string;
    targetCats: readonly CatId[];
    options: RouteOptions;
  },
): AsyncIterable<AgentMessage> {
  const { userId, threadId, userMessageId, options } = input;
  const binding = options.publicInvocationBinding;
  const catId = input.targetCats[0];
  if (
    !binding ||
    !options.publicInvocationExecution ||
    input.targetCats.length !== 1 ||
    !catId ||
    binding.carrier.targetCatId !== catId ||
    binding.carrier.sourceMessageId !== userMessageId ||
    options.ownerAuthProvenance !== 'unknown' ||
    !options.onPromptMessagesExposed ||
    options.contentBlocks?.length ||
    options.liveCompanion ||
    options.memoryCueOpportunitySeeds?.length ||
    options.asrPersonMemoryScenes?.length
  )
    throw new Error('public_route_identity_invalid');
  const service = deps.services[catId];
  if (!service) throw new Error('public_route_service_unavailable');
  yield* routeIsolatedPluginChild(
    deps,
    {
      catId,
      userId,
      threadId,
      service,
      prompt: '',
      isLastCat: true,
      ownerAuthProvenance: 'unknown',
      publicInvocationBinding: binding,
      publicInvocationExecution: options.publicInvocationExecution,
      toolExecutionPolicy: options.toolExecutionPolicy,
      parentInvocationId: options.parentInvocationId,
      signal: options.signalForCat?.(catId) ?? options.signal,
      executionCausal: { triggerMessageId: userMessageId },
      promptMessageIds: [userMessageId],
      onPromptMessagesExposed: options.onPromptMessagesExposed,
      onLifecycleInvocationStarted: options.onLifecycleInvocationStarted,
    },
    options,
    'public',
  );
}
