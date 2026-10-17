import { isDeepStrictEqual } from 'node:util';
import type { InvocationRegistry } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import { capturePublicInvocationAuth } from '../../cats/services/agents/invocation/public-invocation-auth-binding.js';
import type { PublicInvocationExecution } from '../../cats/services/agents/invocation/public-invocation-execution.js';
import type { PluginRuntimeCarrierRouter } from './runtime-carrier.js';

/** Bind the existing Queue child to the active package's existing native launch port. */
export function createPublicQueueExecution(
  registry: Pick<InvocationRegistry, 'getRecord' | 'verifyLatest'>,
  runtime: () => Pick<PluginRuntimeCarrierRouter, 'preparePublicInvocationExecution'>,
): PublicInvocationExecution {
  return {
    async prepare(input) {
      input.signal.throwIfAborted();
      const record = await registry.getRecord(input.invocationId);
      if (!record) throw new Error('public_queue_auth_missing');
      const captured = capturePublicInvocationAuth(record);
      const binding = captured.publicInvocationBinding;
      if (!binding || binding.carrier.sourceMessageId !== input.sourceMessageId) {
        throw new Error('public_queue_auth_mismatch');
      }
      const assertCurrent = async () => {
        input.signal.throwIfAborted();
        const current = await registry.verifyLatest(input.invocationId, captured.callbackToken);
        if (
          !current.ok ||
          current.record.userId !== captured.userId ||
          current.record.threadId !== captured.threadId ||
          current.record.catId !== captured.catId ||
          !isDeepStrictEqual(current.record.publicInvocationBinding, binding)
        ) {
          throw new Error('public_queue_auth_expired');
        }
        capturePublicInvocationAuth(current.record);
        input.signal.throwIfAborted();
      };
      await assertCurrent();
      return runtime().preparePublicInvocationExecution(
        binding.carrier.pluginInstanceId,
        binding.carrier,
        {
          entryId: binding.entryId,
          userId: captured.userId,
          threadId: captured.threadId,
          targetCatId: captured.catId,
          invocationId: input.invocationId,
        },
        { signal: input.signal, assertCurrent },
      );
    },
  };
}
