import { AsyncLocalStorage } from 'node:async_hooks';
import { fencePluginResponseStream, retireWithResponse } from './plugin-response-stream.js';

/** Captured before package code runs. Digests identify bytes; none of these fields is a bearer. */
export interface PluginOwnerHttpRequestIdentity {
  readonly kind: 'owner_http';
  readonly requestId: string;
  /** Transport diagnostics only; Fastify may allow caller-supplied/repeated IDs. */
  readonly transportRequestId: string;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly userId: string;
  readonly contributionId: string;
  readonly method: string;
  readonly declaredPath: string;
  readonly path: string;
  readonly bodyDigest: string;
  readonly queryDigest: string;
}
type RequestIdentitySeed = Omit<
  PluginOwnerHttpRequestIdentity,
  'kind' | 'pluginId' | 'pluginInstanceId' | 'userId' | 'contributionId'
>;

/** Host-only HTTP authority. It is never serialized into the package request or native context. */
export interface PluginOwnerRequestContext {
  readonly userId: string;
  readonly operation: 'read' | 'write';
  readonly signal: AbortSignal;
  /** Absent on legacy Host seeds; consumers requiring request identity must refuse absence. */
  readonly requestIdentity?: PluginOwnerHttpRequestIdentity;
  assertCurrent(): Promise<void>;
}
interface RequestAuthority extends Omit<PluginOwnerRequestContext, 'requestIdentity'> {
  readonly requestIdentity?: RequestIdentitySeed;
  readonly pluginId: string;
  readonly contributionId: string;
}
const requests = new AsyncLocalStorage<RequestAuthority>();
const calls = new AsyncLocalStorage<{ instanceId: string; context: PluginOwnerRequestContext }>();
function expired(): never {
  throw new Error('Plugin owner request is no longer current');
}
export function currentPluginOwnerRequestContext(instanceId: string): PluginOwnerRequestContext | undefined {
  const call = calls.getStore();
  return call?.instanceId === instanceId ? call.context : undefined;
}

/** Only the authenticated forwarding route establishes this seed; declared dispatch consumes it once. */
export async function withPluginOwnerRequest<T>(
  input: Omit<RequestAuthority, 'assertCurrent'>,
  run: () => Promise<T>,
): Promise<T> {
  let active = true;
  const { pluginId, contributionId, userId, operation, signal } = input;
  const authority: RequestAuthority = Object.freeze({
    pluginId,
    contributionId,
    userId,
    operation,
    signal,
    ...(input.requestIdentity ? { requestIdentity: Object.freeze({ ...input.requestIdentity }) } : {}),
    assertCurrent: async () => {
      if (!active || signal.aborted) expired();
    },
  });
  let streaming = false;
  try {
    await authority.assertCurrent();
    const value = await calls.exit(() => requests.run(authority, run));
    streaming = retireWithResponse(value, signal, () => {
      active = false;
    });
    return value;
  } finally {
    if (!streaming) active = false;
  }
}

/** Bind the route to this exact activation, without leaving an inheritable seed for nested calls. */
export async function withPluginOwnerWebhook<T>(
  pluginId: string,
  contributionId: string,
  instanceId: string,
  anonymous: boolean,
  assertActivation: () => void,
  run: () => Promise<T>,
  activationSignal?: AbortSignal,
): Promise<T> {
  const request = requests.getStore();
  if (anonymous || !request) {
    const value = await withoutPluginOwnerRequestContext(run);
    return activationSignal
      ? fencePluginResponseStream(value, activationSignal, async () => assertActivation())
      : value;
  }
  if (request.pluginId !== pluginId || request.contributionId !== contributionId) expired();
  let active = true;
  const signal = activationSignal ? AbortSignal.any([request.signal, activationSignal]) : request.signal;
  const context: PluginOwnerRequestContext = Object.freeze({
    userId: request.userId,
    operation: request.operation,
    signal,
    ...(request.requestIdentity
      ? {
          requestIdentity: Object.freeze({
            ...request.requestIdentity,
            kind: 'owner_http' as const,
            pluginId,
            pluginInstanceId: instanceId,
            userId: request.userId,
            contributionId,
          }),
        }
      : {}),
    assertCurrent: async () => {
      if (!active || signal.aborted) expired();
      await request.assertCurrent();
      assertActivation();
    },
  });
  let streaming = false;
  try {
    await context.assertCurrent();
    const value = await requests.exit(() => calls.run({ instanceId, context }, run));
    const response = fencePluginResponseStream(value, signal, () => context.assertCurrent());
    streaming = retireWithResponse(response, signal, () => {
      active = false;
    });
    return response;
  } finally {
    if (!streaming) active = false;
  }
}

export function withoutPluginOwnerRequestContext<T>(run: () => Promise<T>): Promise<T> {
  return requests.exit(() => calls.exit(run));
}
