import { isDeepStrictEqual } from 'node:util';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { capturePublicInvocationAuth } from '../domains/cats/services/agents/invocation/public-invocation-auth-binding.js';
import { toolExecutionPolicyDenial } from '../domains/cats/services/agents/invocation/tool-execution-policy.js';
import type { PluginNativeActionTarget } from '../domains/cats/services/types.js';
import { snapshotPluginProtocolData } from '../domains/plugin/carrier/plugin-protocol-data.js';
import { NativePluginActionError } from '../domains/plugin/declared/native-plugin-actions.js';
import { getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';
import type { PluginNativeActionRouteOptions } from './plugin-native-action-routes.js';

/** Pins presence as well as contents before source capture; public identity never comes from the source. */
export function captureNativeCallbackCurrentness(
  record: InvocationRecord,
  callbackToken: string,
  target: PluginNativeActionTarget | undefined,
  options: PluginNativeActionRouteOptions,
) {
  const expired = () => new NativePluginActionError(409, 'Invocation is no longer current');
  let captured: InvocationRecord;
  try {
    captured = capturePublicInvocationAuth(record);
  } catch {
    throw expired();
  }
  const publicBinding = captured.publicInvocationBinding;
  const ownerAuthProvenance = captured.ownerAuthProvenance;
  const toolExecutionPolicy =
    captured.toolExecutionPolicy === undefined
      ? undefined
      : (snapshotPluginProtocolData(captured.toolExecutionPolicy) as typeof captured.toolExecutionPolicy);
  const identity = Object.freeze({
    catId: captured.catId,
    userId: captured.userId,
    threadId: captured.threadId,
    invocationId: captured.invocationId,
    originTriggerMessageId: captured.originTriggerMessageId,
    ownerAuthProvenance: ownerAuthProvenance ?? 'unknown',
    ...(toolExecutionPolicy === undefined ? {} : { toolExecutionPolicy }),
  });
  const lifetime = new AbortController();
  const assertLive = () => {
    if (lifetime.signal.aborted) throw expired();
  };
  const close = () => lifetime.abort();
  const assertIdentityCurrent = (latest: InvocationRecord) => {
    const keys = ['userId', 'threadId', 'catId', 'invocationId', 'originTriggerMessageId'] as const;
    if (keys.some((key) => latest[key] !== identity[key])) throw expired();
    if (
      latest.ownerAuthProvenance !== ownerAuthProvenance ||
      !isDeepStrictEqual(latest.toolExecutionPolicy, toolExecutionPolicy)
    )
      throw expired();
    if (!isDeepStrictEqual(latest.publicInvocationBinding, publicBinding)) throw expired();
  };
  const assertRegistryCurrent = async () => {
    try {
      assertLive();
      if (await getDeletedCallbackThreadGuard(options.threadStore, identity.threadId))
        throw new NativePluginActionError(410, 'Thread is deleted');
      assertLive();
      const current = await options.registry.verifyLatest(identity.invocationId, callbackToken);
      assertLive();
      if (!current.ok) throw expired();
      assertIdentityCurrent(current.record);
      // Revalidate the whole public identity, including policy, owner provenance and non-Work/non-A2A scope.
      if (publicBinding) capturePublicInvocationAuth(current.record);
      if (toolExecutionPolicyDenial(current.record.toolExecutionPolicy, 'POST /api/plugin-runtime/action', target))
        throw new NativePluginActionError(403, 'Invocation policy denies plugin action');
    } catch (error) {
      close();
      if (!publicBinding && error instanceof NativePluginActionError) throw error;
      throw expired();
    }
  };
  const assertCurrent = async () => {
    try {
      await assertRegistryCurrent();
      if (publicBinding) {
        if (!options.publicInvocations) throw expired();
        await options.publicInvocations.assertPublicInvocationCurrent(
          publicBinding.carrier.pluginInstanceId,
          publicBinding.carrier,
          {
            entryId: publicBinding.entryId,
            userId: identity.userId,
            threadId: identity.threadId,
            targetCatId: identity.catId,
            invocationId: identity.invocationId,
          },
          { signal: lifetime.signal, assertCurrent: assertRegistryCurrent },
        );
        await assertRegistryCurrent();
      }
    } catch (error) {
      // A failed fence poisons this request even if package code catches it and restores authority.
      close();
      if (!publicBinding && error instanceof NativePluginActionError) throw error;
      throw expired();
    }
  };
  return { identity, assertCurrent, assertInvocationCurrent: assertRegistryCurrent, close };
}
