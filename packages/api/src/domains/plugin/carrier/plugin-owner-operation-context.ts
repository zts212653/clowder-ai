import { AsyncLocalStorage } from 'node:async_hooks';

export interface PluginOwnerOperationContext {
  readonly kind: 'owner-operation';
  readonly userId: string;
  readonly pluginInstanceId: string;
  readonly operationKey: string;
  readonly actionId: string;
  readonly requestId: string;
  /** Host-authenticated confirmation marker for the exact declared action. */
  readonly confirmed?: boolean;
  readonly signal: AbortSignal;
  /** Request/session/activation fence with no inventory I/O; safe while inventory is transaction-locked. */
  assertWriteCurrent(): void;
  assertCurrent(): Promise<void>;
}

export class PluginOwnerOperationExpiredError extends Error {
  constructor() {
    super('Plugin owner operation expired or is no longer current');
  }
}

export interface OwnerOperationRequest {
  /** Explicit confirmation from the authenticated browser carrier, never plugin input. */
  readonly confirmed?: boolean;
  readonly pluginId: string;
  readonly operationKey: string;
  readonly actionId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  bindActivation?(assertCurrent: () => void, signal?: AbortSignal): void;
}
interface Invocation {
  readonly request: OwnerOperationRequest;
  readonly instanceId: string;
  readonly method: string;
  readonly assertCurrent: () => Promise<void>;
  consumed: boolean;
}
const requests = new AsyncLocalStorage<OwnerOperationRequest>();
const invocations = new AsyncLocalStorage<Invocation>();
const activeCalls = new AsyncLocalStorage<PluginOwnerOperationContext>();

export function withOwnerOperationRequest<T>(request: OwnerOperationRequest, run: () => Promise<T>): Promise<T> {
  return withoutOwnerOperationContext(() => requests.run(request, run));
}
export function currentOwnerOperationRequest(): OwnerOperationRequest | undefined {
  return requests.getStore();
}
export function currentOwnerOperation(instanceId: string): PluginOwnerOperationContext | undefined {
  const context = activeCalls.getStore();
  return context?.pluginInstanceId === instanceId ? context : undefined;
}
export function withCurrentOwnerOperation<T>(context: PluginOwnerOperationContext, run: () => Promise<T>): Promise<T> {
  return activeCalls.run(context, run);
}
export function withoutOwnerOperationContext<T>(run: () => Promise<T>): Promise<T> {
  return requests.exit(() => invocations.exit(() => activeCalls.exit(run)));
}

/** A Host-only, single-use capability; params and package code cannot issue it. */
export async function withOwnerOperationInvocation<T>(
  request: OwnerOperationRequest,
  instanceId: string,
  method: string,
  assertCurrent: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  request.assertCurrent();
  const invocation = { request, instanceId, method, assertCurrent, consumed: false };
  const result = await requests.exit(() => invocations.run(invocation, run));
  if (!invocation.consumed) throw new Error('Carrier did not consume owner operation authority');
  return result;
}

/** Called only by the actual module carrier immediately before invoking its own action table. */
export async function consumeOwnerOperationInvocation<T>(
  instanceId: string,
  method: string,
  activationSignal: AbortSignal | undefined,
  assertActivation: () => void,
  run: (context: PluginOwnerOperationContext | undefined) => Promise<T>,
): Promise<T> {
  const issued = invocations.getStore();
  if (!issued) return withoutOwnerOperationContext(() => run(undefined));
  if (issued.consumed || issued.instanceId !== instanceId || issued.method !== method)
    throw new PluginOwnerOperationExpiredError();
  issued.consumed = true;
  issued.request.bindActivation?.(assertActivation, activationSignal);
  const call = new AbortController();
  const signal = AbortSignal.any([call.signal, issued.request.signal, ...(activationSignal ? [activationSignal] : [])]);
  const assertWriteCurrent = () => {
    try {
      if (signal.aborted) throw new PluginOwnerOperationExpiredError();
      issued.request.assertCurrent();
      assertActivation();
      if (signal.aborted) throw new PluginOwnerOperationExpiredError();
    } catch (error) {
      call.abort();
      throw error;
    }
  };
  const assertCurrent = async () => {
    try {
      assertWriteCurrent();
      await issued.assertCurrent();
      assertWriteCurrent();
    } catch (error) {
      call.abort();
      throw error;
    }
  };
  const context: PluginOwnerOperationContext = Object.freeze({
    kind: 'owner-operation',
    userId: issued.request.userId,
    pluginInstanceId: instanceId,
    operationKey: issued.request.operationKey,
    actionId: issued.request.actionId,
    requestId: issued.request.requestId,
    confirmed: issued.request.confirmed === true,
    signal,
    assertWriteCurrent,
    assertCurrent,
  });
  try {
    await assertCurrent();
    return await requests.exit(() => invocations.exit(() => activeCalls.run(context, () => run(context))));
  } finally {
    call.abort();
  }
}
