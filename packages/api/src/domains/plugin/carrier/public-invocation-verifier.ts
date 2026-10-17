import type { PluginManifest } from '@clowder-ai/plugin-contract';
import {
  assertPluginPublicInvocationCarrier,
  type PluginPublicInvocationCarrierV1,
} from '../../cats/services/stores/ports/plugin-public-invocation-carrier.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { withoutPluginCallContext } from './plugin-call-context.js';
import { snapshotPluginProtocolData as snapshot } from './plugin-protocol-data.js';
import { withPluginTransportPurpose } from './plugin-transport-context.js';
import type { PluginRuntimeAdmission } from './runtime-carrier.js';

export const PUBLIC_INVOCATION_VERIFIER_METHOD = 'host.public-invocation.assert-current';
export interface PublicInvocationVerifierContext {
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export interface PublicInvocationVerifierPort {
  invokePublicInvocationVerifier(
    instanceId: string,
    carrier: PluginPublicInvocationCarrierV1,
    context: PublicInvocationVerifierContext,
  ): Promise<Readonly<{ current: true }>>;
}
export type PublicInvocationVerifierHandler = (input: unknown, context: PublicInvocationVerifierContext) => unknown;
function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', message);
}

/** Capture all caller-owned values before the first asynchronous authority lookup. */
export function capturePublicVerification(
  instanceId: string,
  input: PluginPublicInvocationCarrierV1,
  context: PublicInvocationVerifierContext,
) {
  const carrier = snapshot(input);
  assertPluginPublicInvocationCarrier(carrier);
  if (carrier.pluginInstanceId !== instanceId) refuse('Public verifier instance mismatch');
  const signal = context.signal;
  const assertCurrent = context.assertCurrent;
  if (!(signal instanceof AbortSignal) || typeof assertCurrent !== 'function') refuse('Missing public verifier fence');
  signal.throwIfAborted();
  return { carrier, context: Object.freeze({ signal, assertCurrent }) };
}

export function assertPublicVerifierContribution(
  manifest: PluginManifest,
  grants: readonly string[],
  carrier: PluginPublicInvocationCarrierV1,
): void {
  const declarations =
    manifest.contributions?.filter((item) => item.type === 'mcp' && item.id === carrier.contributionId) ?? [];
  const contribution = declarations[0];
  const owners = manifest.features.filter((feature) =>
    feature.contributions?.some((item) => item.type === 'mcp' && item.id === carrier.contributionId),
  );
  if (
    declarations.length !== 1 ||
    contribution?.type !== 'mcp' ||
    owners.length !== 1 ||
    !owners[0]?.capabilities.every((capability) => grants.includes(capability)) ||
    !carrier.actionMethods.every(
      (method) =>
        method !== PUBLIC_INVOCATION_VERIFIER_METHOD &&
        contribution.actions?.some((action) => action.method === method),
    )
  ) {
    refuse('Public verifier contribution or grants mismatch');
  }
}

export function assertPublicVerifierAdmission(
  admission: PluginRuntimeAdmission,
  carrier: PluginPublicInvocationCarrierV1,
): void {
  const { instance, packageRecord, effectiveGrants, grantRevision } = admission;
  if (
    instance.pluginInstanceId !== carrier.pluginInstanceId ||
    instance.activationState !== 'enabled' ||
    instance.lifecycleState !== 'installed' ||
    instance.configReadiness !== 'ready' ||
    instance.packageDigest !== carrier.packageDigest ||
    instance.lifecycleRevision !== carrier.lifecycleRevision ||
    (grantRevision ?? 0) !== carrier.grantRevision ||
    packageRecord.packageState !== 'installed' ||
    packageRecord.packageDigest !== carrier.packageDigest ||
    packageRecord.pluginId !== instance.pluginId ||
    packageRecord.manifest.runtime?.transport !== 'builtin'
  )
    refuse('Public verifier admission changed');
  assertPublicVerifierContribution(packageRecord.manifest, effectiveGrants, carrier);
}

/** A fixed private slot, captured once; never selected through an action or MCP method. */
export function capturePublicInvocationVerifier(
  activation: object,
  actions: Readonly<Record<string, unknown>>,
  manifest: PluginManifest,
): PublicInvocationVerifierHandler | undefined {
  if (
    PUBLIC_INVOCATION_VERIFIER_METHOD in actions ||
    manifest.contributions?.some(
      (item) =>
        item.type === 'mcp' && item.actions?.some((action) => action.method === PUBLIC_INVOCATION_VERIFIER_METHOD),
    )
  ) {
    refuse('Public verifier cannot be an ordinary action');
  }
  const descriptor = Object.getOwnPropertyDescriptor(activation, 'publicInvocationVerifier');
  if (!descriptor) {
    if ('publicInvocationVerifier' in activation) refuse('Public verifier must be an own data function');
    return undefined;
  }
  if (!('value' in descriptor) || typeof descriptor.value !== 'function')
    refuse('Public verifier must be an own data function');
  return descriptor.value as PublicInvocationVerifierHandler;
}

export async function invokeIsolatedPublicVerifier(
  carrier: PluginPublicInvocationCarrierV1,
  handler: PublicInvocationVerifierHandler,
  context: PublicInvocationVerifierContext,
  activationSignal: AbortSignal,
  assertActivation: () => void,
): Promise<Readonly<{ current: true }>> {
  const input = snapshot({
    authority: { ref: carrier.authorityRef, revision: carrier.authorityRevision },
    source: { messageRef: `message:${carrier.sourceMessageId}` },
    targetCatId: carrier.targetCatId,
    native: { contributionId: carrier.contributionId, methods: carrier.actionMethods },
  });
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, activationSignal, lifetime.signal]);
  const checkAuthority = context.assertCurrent;
  let finished = false;
  const assertCurrent = async () => {
    try {
      if (finished) refuse('Public verifier invocation expired');
      signal.throwIfAborted();
      assertActivation();
      await checkAuthority();
      signal.throwIfAborted();
      if (finished) refuse('Public verifier invocation expired');
      assertActivation();
    } catch (error) {
      lifetime.abort(error);
      throw error;
    }
  };
  const isolated = Object.freeze({ signal, assertCurrent });
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Public verification cancelled'),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      (async () => {
        await assertCurrent();
        const raw = await withoutPluginCallContext(() =>
          withPluginTransportPurpose('verifier', async () => {
            signal.throwIfAborted();
            assertActivation();
            return handler(input, isolated);
          }),
        );
        await assertCurrent();
        const result = snapshot(raw);
        if (
          !result ||
          typeof result !== 'object' ||
          Array.isArray(result) ||
          Object.keys(result).length !== 1 ||
          !('current' in result) ||
          result.current !== true
        )
          refuse('Invalid public verifier result');
        return Object.freeze({ current: true as const });
      })(),
      aborted,
    ]);
  } finally {
    finished = true;
    removeAbortListener();
    lifetime.abort();
  }
}
