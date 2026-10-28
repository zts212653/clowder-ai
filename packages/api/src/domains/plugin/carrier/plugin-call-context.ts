import { AsyncLocalStorage } from 'node:async_hooks';
import type { OwnerAuthProvenance } from '../../cats/services/agents/invocation/owner-auth-provenance.js';
import type { ToolExecutionPolicy } from '../../cats/services/types.js';
import { withoutOwnerOperationContext } from './plugin-owner-operation-context.js';
import { withoutPluginOwnerRequestContext } from './plugin-owner-request-context.js';

export { currentPluginOwnerRequestContext } from './plugin-owner-request-context.js';

/** Host-verified caller metadata, separate from the package's business input. */
export interface PluginCallContext {
  readonly catId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly invocationId: string;
  /** Set only inside the Host's admitted project-output dispatcher. */
  readonly outputOperation?: { readonly id: string };
  /** Host-only authenticated lookup; never serialized into package identity or action input. */
  /** Authenticated facts, not permission inferred from a matching userId. */
  readonly ownerAuthProvenance?: OwnerAuthProvenance;
  readonly toolExecutionPolicy?: ToolExecutionPolicy;
  /** Exact authenticated invocation origin; never substituted with a typed-wait source. */
  readonly originTriggerMessageId?: string;
  readonly source?: {
    readonly kind: 'primary' | 'adopted_hold';
    readonly sourceMessageId: string;
    readonly holdTaskId?: string;
  };
  /** Recheck the local activation and invoking turn after asynchronous provider work. */
  assertCurrent(): Promise<void>;
  /** Host-only turn/activation fence; never reads inventory or crosses the package ABI. */
  assertInvocationCurrent?(): Promise<void>;
}

const calls = new AsyncLocalStorage<{ instanceId: string; context: PluginCallContext }>();
export function currentPluginCallContext(instanceId: string | undefined): PluginCallContext | undefined {
  const call = calls.getStore();
  return call?.instanceId === instanceId ? call?.context : undefined;
}
export function withPluginCallContext<T>(
  instanceId: string,
  context: PluginCallContext,
  run: () => Promise<T>,
): Promise<T> {
  return withoutOwnerOperationContext(() =>
    withoutPluginOwnerRequestContext(() => calls.run({ instanceId, context }, run)),
  );
}

/** A verifier never inherits native or HTTP business authority. */
export function withoutPluginCallContext<T>(run: () => Promise<T>): Promise<T> {
  return withoutOwnerOperationContext(() => withoutPluginOwnerRequestContext(() => calls.exit(run)));
}
