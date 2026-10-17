import { AsyncLocalStorage } from 'node:async_hooks';

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
  try {
    await authority.assertCurrent();
    return await calls.exit(() => requests.run(authority, run));
  } finally {
    active = false;
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
): Promise<T> {
  const request = requests.getStore();
  if (anonymous || !request) return withoutPluginOwnerRequestContext(run);
  if (request.pluginId !== pluginId || request.contributionId !== contributionId) expired();
  let active = true;
  const context: PluginOwnerRequestContext = Object.freeze({
    userId: request.userId,
    operation: request.operation,
    signal: request.signal,
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
      if (!active) expired();
      await request.assertCurrent();
      assertActivation();
    },
  });
  try {
    await context.assertCurrent();
    return await requests.exit(() => calls.run({ instanceId, context }, run));
  } finally {
    active = false;
  }
}

export function withoutPluginOwnerRequestContext<T>(run: () => Promise<T>): Promise<T> {
  return requests.exit(() => calls.exit(run));
}
