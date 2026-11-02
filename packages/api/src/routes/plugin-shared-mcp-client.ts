import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { NativePluginActionError } from '../domains/plugin/declared/native-plugin-actions.js';
import type { SharedMcpActionClient } from '../domains/plugin/declared/shared-mcp-factory.js';
import { captureTypedWaitSource } from './callback-typed-wait-source.js';
import type { captureNativeCallbackCurrentness } from './plugin-native-action-currentness.js';
import type { PluginNativeActionRouteOptions } from './plugin-native-action-routes.js';

/** Same native action owner, source capture, fencing and redaction as the stdio client's HTTP route. */
export function createSharedPluginActionClient(input: {
  record: InvocationRecord;
  token: string;
  fence: ReturnType<typeof captureNativeCallbackCurrentness>;
  assertCurrent(): Promise<void>;
  signal: AbortSignal;
  options: PluginNativeActionRouteOptions;
}): SharedMcpActionClient {
  return Object.freeze({
    async invoke(
      method: string,
      args: unknown,
      call: { readonly signal?: AbortSignal; readonly _meta?: unknown } = {},
    ) {
      const signal = AbortSignal.any([
        input.signal,
        ...(call.signal ? [call.signal] : []),
        AbortSignal.timeout(30_000),
      ]);
      let rejectAbort: ((reason: Error) => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => {
        input.fence.close();
        rejectAbort?.(new Error('Plugin action was cancelled; result may be unknown'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        signal.throwIfAborted();
        const execute = async () => {
          await input.assertCurrent();
          const source = await captureTypedWaitSource(input.record, input.options.sources);
          return input.options.actions.call(input.token, method, args, {
            ...input.fence.identity,
            ...(source ? { source: Object.freeze(source) } : {}),
            assertCurrent: input.assertCurrent,
            // Preserve the inventory-free fence used inside native output commits.
            assertInvocationCurrent: input.fence.assertInvocationCurrent,
          });
        };
        return await Promise.race([execute(), aborted]);
      } catch (error) {
        if (signal.aborted) throw new Error('Plugin action was cancelled; result may be unknown');
        const status = error instanceof NativePluginActionError ? error.statusCode : 502;
        throw new Error(`Plugin action failed (HTTP ${status}); result may be unknown`);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  });
}
