import { Readable } from 'node:stream';
import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import { catAgentStreamEventSchema } from '@clowder-ai/agent-contract/catagent';
import { readCatAgentSseFrames } from '../../cats/services/agents/providers/catagent/catagent-stream-parser.js';
import { sanitizeRawEvent } from '../../cats/services/agents/providers/codex-audit-hooks.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export function createAgentAccessCatAgentOutput(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke' | 'nativeActions'>,
) {
  return async (userSignal: AbortSignal | undefined, credentials: readonly string[]) => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');
    const { pluginInstanceId } = instance;
    const lifetime = runtime.nativeActions.activationSignal(pluginInstanceId);
    const signal = userSignal ? AbortSignal.any([lifetime, userSignal]) : lifetime;
    signal.throwIfAborted();
    return {
      signal,
      async *read(body: ReadableStream<Uint8Array>) {
        signal.throwIfAborted();
        const sanitize = (raw: string) => String(sanitizeRawEvent(sanitizeRawEvent(raw), credentials));
        const source = Readable.from(
          (async function* () {
            for await (const frame of readCatAgentSseFrames(body, signal)) {
              yield frame.kind === 'event'
                ? { ...frame, data: sanitize(frame.data) }
                : { ...frame, error: sanitize(frame.error) };
            }
          })(),
          { objectMode: true, highWaterMark: 1 },
        );
        try {
          const output = await runtime.invoke(pluginInstanceId, 'projectCatAgentOutput', { source, signal });
          if (!output || typeof output !== 'object' || !(Symbol.asyncIterator in output))
            throw new Error('invalid_catagent_output_stream');
          for await (const event of output as AsyncIterable<unknown>) {
            signal.throwIfAborted();
            yield catAgentStreamEventSchema.parse(event);
          }
          signal.throwIfAborted();
        } finally {
          source.destroy();
        }
      },
    };
  };
}

export type AgentAccessCatAgentOutput = ReturnType<typeof createAgentAccessCatAgentOutput>;
