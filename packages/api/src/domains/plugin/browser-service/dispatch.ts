import { randomUUID } from 'node:crypto';
import type { BrowserServiceContribution, BrowserServiceDispatchResult } from '@clowder-ai/plugin-contract';
import {
  currentPluginCallContext,
  currentPluginOwnerRequestContext,
  withoutPluginCallContext,
} from '../carrier/plugin-call-context.js';
import { currentOwnerOperation } from '../carrier/plugin-owner-operation-context.js';
import { currentPluginTransportPurpose, withPluginTransportPurpose } from '../carrier/plugin-transport-context.js';
import type {
  PluginBrowserServiceBinding,
  PluginBrowserServiceHandler,
} from '../host-surface/plugin-browser-service-host.js';
import {
  admitBrowserServiceRequest,
  admitBrowserServiceResponse,
  BROWSER_SERVICE_LIMITS,
  BrowserServiceTransportError,
  type TransportCode,
} from './transport-policy.js';

function refuse(code: TransportCode): never {
  throw new BrowserServiceTransportError(code);
}
function failure(code: TransportCode, entered: boolean): BrowserServiceDispatchResult {
  return { kind: 'transport-error', code, effect: entered ? 'unknown' : 'not_started', automaticRetry: false };
}
/** Shared by every browser service of one Host; a timeout never releases an unsettled handler's slot. */
export class BrowserServiceDispatchBudget {
  readonly #instances = new Set<string>();
  acquire(instanceId: string): () => void {
    if (this.#instances.has(instanceId) || this.#instances.size >= 2) refuse('BROWSER_SERVICE_BUSY');
    this.#instances.add(instanceId);
    return () => this.#instances.delete(instanceId);
  }
}
interface Dependencies {
  readonly instanceId: string;
  readonly contribution: BrowserServiceContribution;
  readonly binding: PluginBrowserServiceBinding;
  readonly activationSignal: AbortSignal;
  readonly budget: BrowserServiceDispatchBudget;
  /** Current published handler only; reserved sessions return undefined. */
  handler(): PluginBrowserServiceHandler | undefined;
}
export class BrowserServiceDispatcher {
  constructor(private readonly deps: Dependencies) {}

  async dispatch(
    lane: 'browser' | 'local',
    input: unknown,
    signal?: AbortSignal,
  ): Promise<BrowserServiceDispatchResult> {
    // Do not erase this marker when clearing authority. Even expired async children stay ineligible.
    if (lane === 'local' && currentPluginTransportPurpose() !== undefined)
      return failure('BROWSER_SERVICE_INVALID_REQUEST', false);
    const { binding, contribution, activationSignal, instanceId } = this.deps;
    const owner = lane === 'local' ? currentOwnerOperation(instanceId) : undefined;
    const webhook = lane === 'local' ? currentPluginOwnerRequestContext(instanceId) : undefined;
    const native = lane === 'local' ? currentPluginCallContext(instanceId) : undefined;
    const life = new AbortController();
    const combined = AbortSignal.any([
      life.signal,
      activationSignal,
      ...(signal ? [signal] : []),
      ...(owner ? [owner.signal] : []),
      ...(webhook ? [webhook.signal] : []),
    ]);
    let entered = false,
      finished = false,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      life.abort();
    }, BROWSER_SERVICE_LIMITS.timeoutMs);
    timer.unref();
    const assertCurrent = async () => {
      if (finished || combined.aborted) refuse(timedOut ? 'BROWSER_SERVICE_TIMEOUT' : 'BROWSER_SERVICE_REVOKED');
      await binding.assertCurrent();
      await owner?.assertCurrent();
      await webhook?.assertCurrent();
      await native?.assertCurrent();
      if (finished || combined.aborted) refuse(timedOut ? 'BROWSER_SERVICE_TIMEOUT' : 'BROWSER_SERVICE_REVOKED');
    };
    let removeAbort = () => {};
    try {
      const request = admitBrowserServiceRequest(input, lane, contribution, binding);
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () =>
          reject(new BrowserServiceTransportError(timedOut ? 'BROWSER_SERVICE_TIMEOUT' : 'BROWSER_SERVICE_REVOKED'));
        combined.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => combined.removeEventListener('abort', onAbort);
        if (combined.aborted) onAbort();
      });
      const work = (async () => {
        await assertCurrent();
        const handler = this.deps.handler();
        if (!handler) refuse('BROWSER_SERVICE_UNAVAILABLE');
        const release = this.deps.budget.acquire(instanceId);
        try {
          combined.throwIfAborted();
          const context = Object.freeze({
            kind: 'http' as const,
            lane,
            contributionId: contribution.id,
            requestId: randomUUID(),
            signal: combined,
            assertCurrent,
          });
          // Only this line enters plugin code. No owner/native/predicate metadata survives.
          entered = true;
          const raw = await withoutPluginCallContext(() =>
            withPluginTransportPurpose(lane, () => handler({ request }, undefined, context)),
          );
          await assertCurrent();
          return admitBrowserServiceResponse(raw, contribution, binding.origin);
        } finally {
          release();
        }
      })();
      const response = await Promise.race([work, aborted]);
      return { kind: 'response', response };
    } catch (error) {
      const code = timedOut
        ? 'BROWSER_SERVICE_TIMEOUT'
        : combined.aborted
          ? 'BROWSER_SERVICE_REVOKED'
          : error instanceof BrowserServiceTransportError
            ? error.code
            : entered
              ? 'BROWSER_SERVICE_INVALID_RESPONSE'
              : 'BROWSER_SERVICE_REVOKED';
      return failure(code, entered);
    } finally {
      finished = true;
      clearTimeout(timer);
      removeAbort();
      life.abort();
    }
  }
}
