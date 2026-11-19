import { Readable } from 'node:stream';
import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import {
  CAT_AGENT_MAX_TOOL_INPUT_BYTES,
  type CatAgentSseFrame,
  catAgentStreamEventSchema,
} from '@clowder-ai/agent-contract/catagent';
import { z } from 'zod';
import { readCatAgentSseFrames } from '../../cats/services/agents/providers/catagent/catagent-stream-parser.js';
import { sanitizeRawEvent, sanitizeStreamingDelta } from '../../cats/services/agents/providers/codex-audit-hooks.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

const payloadSchema = z
  .object({
    type: z.string(),
    index: z.number().int().nonnegative().optional(),
    delta: z
      .object({ type: z.string().optional(), text: z.string().optional(), partial_json: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

async function* withoutProviderCredentials(
  frames: AsyncIterable<CatAgentSseFrame>,
  credentials: readonly string[],
): AsyncGenerator<CatAgentSseFrame> {
  const tails = new Map<number, string>();
  const inputs = new Map<number, { text: string; size: number }>();
  const sanitize = (raw: unknown) => sanitizeRawEvent(sanitizeRawEvent(raw), credentials);
  for await (const frame of frames) {
    if (frame.kind === 'transport_error') {
      yield { ...frame, error: String(sanitize(frame.error)) };
      continue;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(frame.data);
    } catch {
      if (frame.name === 'error') yield { ...frame, data: String(sanitize(frame.data)) };
      continue;
    }
    const result = payloadSchema.safeParse(candidate);
    if (frame.name === 'error') {
      yield { name: String(sanitize(frame.name)), kind: 'event', data: JSON.stringify(sanitize(candidate)) };
      continue;
    }
    if (!result.success) continue;
    const payload = result.data;
    const { index, type, delta } = payload;
    if (
      index !== undefined &&
      type === 'content_block_delta' &&
      delta?.type === 'text_delta' &&
      delta.text !== undefined
    ) {
      const { text, tail } = sanitizeStreamingDelta((tails.get(index) ?? '') + delta.text, credentials);
      tails.set(index, tail);
      delta.text = text;
    } else if (
      index !== undefined &&
      type === 'content_block_delta' &&
      delta?.type === 'input_json_delta' &&
      delta.partial_json !== undefined
    ) {
      // JSON escaping can hide a credential until the complete set of arguments is decoded.
      const input = inputs.get(index) ?? { text: '', size: 0 };
      if (input.size <= CAT_AGENT_MAX_TOOL_INPUT_BYTES) {
        input.size += Buffer.byteLength(delta.partial_json);
        if (input.size <= CAT_AGENT_MAX_TOOL_INPUT_BYTES) input.text += delta.partial_json;
      }
      inputs.set(index, input);
      continue;
    } else if (index !== undefined && type === 'content_block_stop') {
      const tail = tails.get(index);
      const input = inputs.get(index);
      tails.delete(index);
      inputs.delete(index);
      if (tail || input) {
        let args: unknown;
        if (input && input.size <= CAT_AGENT_MAX_TOOL_INPUT_BYTES) {
          try {
            args = sanitize(JSON.parse(input.text || '{}'));
          } catch {
            args = { _error: 'Invalid tool input JSON' };
          }
        } else if (input) {
          args = { _error: 'Tool input exceeded size limit' };
        }
        yield {
          kind: 'event',
          name: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: input
              ? { type: 'input_json_delta', partial_json: JSON.stringify(args) }
              : { type: 'text_delta', text: tail },
          }),
        };
      }
    }
    yield { kind: 'event', name: String(sanitize(frame.name)), data: JSON.stringify(sanitize(payload)) };
  }
}

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
        const source = Readable.from(withoutProviderCredentials(readCatAgentSseFrames(body, signal), credentials), {
          objectMode: true,
          highWaterMark: 1,
        });
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
