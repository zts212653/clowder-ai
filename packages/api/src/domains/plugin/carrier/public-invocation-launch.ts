import { isDeepStrictEqual } from 'node:util';
import type { PluginPublicInvocationCarrierV1 } from '../../cats/services/stores/ports/plugin-public-invocation-carrier.js';
import type { ToolExecutionPolicy } from '../../cats/services/types.js';
import type { NativeMcpServer } from '../declared/native-mcp-launches.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { snapshotPluginProtocolData as snapshot } from './plugin-protocol-data.js';
import type { PublicInvocationBinding, VerifiedPublicInvocationSource } from './public-invocation-currentness.js';
import { capturePublicVerification, type PublicInvocationVerifierContext } from './public-invocation-verifier.js';

export interface PublicInvocationLaunchLease {
  readonly source: { readonly messageId: string; readonly content: string };
  readonly server: NativeMcpServer;
  assertCurrent(): Promise<void>;
  dispose(): void;
}
interface LaunchPorts {
  generation(): number | undefined;
  resolve(policy: ToolExecutionPolicy): Promise<NativeMcpServer>;
  read(
    carrier: PluginPublicInvocationCarrierV1,
    binding: PublicInvocationBinding,
    context: PublicInvocationVerifierContext,
  ): Promise<VerifiedPublicInvocationSource>;
}
function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Public launch authority changed or is unavailable');
}

/** Bind one already-created child to immutable source bytes and one activation.
 * This is authority preparation, never admission, scheduling or provider support. */
export async function resolvePublicInvocationLaunchLease(
  instanceId: string,
  input: PluginPublicInvocationCarrierV1,
  expected: PublicInvocationBinding,
  authority: PublicInvocationVerifierContext,
  ports: LaunchPorts,
): Promise<PublicInvocationLaunchLease> {
  const { carrier, context } = capturePublicVerification(instanceId, input, authority);
  const binding = snapshot(expected) as PublicInvocationBinding;
  if (!binding || typeof binding.invocationId !== 'string' || !binding.invocationId.length) refuse();
  const generation = ports.generation();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, lifetime.signal]);
  const policy = Object.freeze({
    mode: 'plugin_native' as const,
    pluginInstanceId: instanceId,
    contributionId: carrier.contributionId,
    actionMethods: carrier.actionMethods,
  });
  const pinned: {
    originalServer?: NativeMcpServer;
    server?: NativeMcpServer;
    source?: VerifiedPublicInvocationSource;
  } = {};
  const checkActivation = async () => {
    signal.throwIfAborted();
    await context.assertCurrent();
    signal.throwIfAborted();
    const current = await ports.resolve(policy);
    signal.throwIfAborted();
    if (!current || ports.generation() !== generation) refuse();
    if (
      pinned.originalServer !== undefined &&
      (current !== pinned.originalServer || !isDeepStrictEqual(current, pinned.server))
    )
      refuse();
    pinned.originalServer = current;
    pinned.server ??= snapshot(current) as NativeMcpServer;
  };
  const assertCurrent = async () => {
    try {
      signal.throwIfAborted();
      // The durable reader checks this activation around every storage await and
      // runs the private package verifier. It also races cancellation itself.
      const current = await ports.read(carrier, binding, Object.freeze({ signal, assertCurrent: checkActivation }));
      signal.throwIfAborted();
      if (pinned.source !== undefined && !isDeepStrictEqual(current, pinned.source)) refuse();
      pinned.source ??= current;
    } catch (error) {
      lifetime.abort(error);
      throw error;
    }
  };
  const dispose = () => lifetime.abort(new Error('public_launch_disposed'));
  await assertCurrent();
  signal.throwIfAborted();
  if (!pinned.source || !pinned.server) {
    dispose();
    refuse();
  }
  return Object.freeze({
    source: Object.freeze({ messageId: carrier.sourceMessageId, content: pinned.source.content }),
    server: pinned.server,
    assertCurrent,
    dispose,
  });
}
