import type { RuntimeInteractionResponse } from '@cat-cafe/shared';
import type { ActiveRuntimeInteractionWaiter } from './RuntimeInteractionServiceContract.js';
import { deferred } from './RuntimeProviderInteractionModel.js';

export class RuntimeInteractionWaiterRegistry {
  private readonly waiters = new Map<string, ActiveRuntimeInteractionWaiter>();

  register(
    interactionId: string,
    signal: AbortSignal | undefined,
    onAbort: () => void,
  ): { responsePromise: Promise<RuntimeInteractionResponse>; waiter: ActiveRuntimeInteractionWaiter } {
    const response = deferred<RuntimeInteractionResponse>();
    void response.promise.catch(() => {});
    const waiter: ActiveRuntimeInteractionWaiter = {
      resolve: response.resolve,
      reject: response.reject,
      cleanup: () => signal?.removeEventListener('abort', onAbort),
    };
    this.waiters.set(interactionId, waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    return { responsePromise: response.promise, waiter };
  }

  get(interactionId: string): ActiveRuntimeInteractionWaiter | undefined {
    return this.waiters.get(interactionId);
  }

  delete(interactionId: string): boolean {
    return this.waiters.delete(interactionId);
  }

  discard(interactionId: string, waiter: ActiveRuntimeInteractionWaiter): void {
    if (this.waiters.get(interactionId) !== waiter) return;
    this.waiters.delete(interactionId);
    waiter.cleanup();
  }
}
