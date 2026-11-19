import { Readable } from 'node:stream';
import {
  type AnthropicUsage,
  type CatAgentSseFrame,
  type CatAgentStreamEvent,
  catAgentSseFrameSchema,
} from '@clowder-ai/agent-contract/catagent';
import { z } from 'zod';

const MAX_TOOL_INPUT_BYTES = 65_536;

const outputRequest = z.object({ source: z.instanceof(Readable), signal: z.instanceof(AbortSignal) });

export function projectCatAgentOutput(input: unknown) {
  const { source, signal } = outputRequest.parse(input);
  return projectCatAgentEvents(
    (async function* () {
      for await (const frame of source) {
        signal.throwIfAborted();
        yield catAgentSseFrameSchema.parse(frame);
      }
    })(),
  );
}

interface BlockAccumulator {
  index: number;
  type: 'text' | 'tool_use';
  text: string;
  toolId: string;
  toolName: string;
  toolInputJson: string;
  toolInputBytes: number;
}

/** Mutable context shared between the main loop and event handlers. */
interface StreamContext {
  blocks: Map<number, BlockAccumulator>;
  sawMessageStop: boolean;
  sawAnyEvent: boolean;
}

export async function* projectCatAgentEvents(
  source: AsyncIterable<CatAgentSseFrame>,
): AsyncIterable<CatAgentStreamEvent> {
  const ctx: StreamContext = { blocks: new Map(), sawMessageStop: false, sawAnyEvent: false };
  for await (const frame of source) {
    if (frame.kind === 'transport_error') {
      yield { type: 'stream_error', error: frame.error };
      return;
    }
    yield* handleSSEEvent(frame, ctx);
  }
  if (ctx.blocks.size > 0) {
    yield { type: 'stream_error', error: `Stream ended with ${ctx.blocks.size} unclosed content block(s)` };
  } else if (ctx.sawAnyEvent && !ctx.sawMessageStop) {
    yield { type: 'stream_error', error: 'Stream ended without message_stop' };
  }
}

function* handleSSEEvent(
  evt: Extract<CatAgentSseFrame, { kind: 'event' }>,
  ctx: StreamContext,
): Iterable<CatAgentStreamEvent> {
  if (evt.name === 'error') {
    yield { type: 'stream_error', error: evt.data };
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(evt.data);
  } catch {
    return;
  }

  if (!parsed || typeof parsed !== 'object') return;
  ctx.sawAnyEvent = true;
  const eventType = parsed.type as string;

  if (eventType === 'message_start') {
    const message = parsed.message as Record<string, unknown> | undefined;
    const usage = message?.usage as AnthropicUsage | undefined;
    if (usage) yield { type: 'usage_update', inputUsage: usage };
    return;
  }

  if (eventType === 'content_block_start') {
    const index = parsed.index as number;
    const cb = parsed.content_block as Record<string, unknown>;
    ctx.blocks.set(index, {
      index,
      type: cb?.type === 'tool_use' ? 'tool_use' : 'text',
      text: '',
      toolId: (cb?.id as string) ?? '',
      toolName: (cb?.name as string) ?? '',
      toolInputJson: '',
      toolInputBytes: 0,
    });
    return;
  }

  if (eventType === 'content_block_delta') {
    const index = parsed.index as number;
    const delta = parsed.delta as Record<string, unknown>;
    const block = ctx.blocks.get(index);
    if (!block) return;

    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      block.text += delta.text;
      yield { type: 'text_delta', text: delta.text, blockIndex: index };
    } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const chunk = delta.partial_json;
      block.toolInputBytes += Buffer.byteLength(chunk);
      if (block.toolInputBytes <= MAX_TOOL_INPUT_BYTES) {
        block.toolInputJson += chunk;
      }
    }
    return;
  }

  if (eventType === 'content_block_stop') {
    const index = parsed.index as number;
    const block = ctx.blocks.get(index);
    if (!block) return;
    ctx.blocks.delete(index);

    if (block.type === 'text') {
      yield { type: 'content_block_complete', block: { type: 'text', text: block.text }, blockIndex: index };
    } else {
      let input: Record<string, unknown> = {};
      if (block.toolInputBytes > MAX_TOOL_INPUT_BYTES) {
        input = { _error: 'Tool input exceeded size limit' };
      } else {
        try {
          input = JSON.parse(block.toolInputJson || '{}');
        } catch {
          input = { _error: 'Invalid tool input JSON' };
        }
      }
      yield {
        type: 'content_block_complete',
        block: { type: 'tool_use', id: block.toolId, name: block.toolName, input },
        blockIndex: index,
      };
    }
    return;
  }

  if (eventType === 'message_delta') {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    const usage = parsed.usage as Record<string, unknown> | undefined;
    const outputTokens = usage?.output_tokens as number | undefined;
    if (outputTokens !== undefined) yield { type: 'usage_update', outputTokens };
    const stopReason = delta?.stop_reason as string | null | undefined;
    if (stopReason !== undefined) yield { type: 'stop', stopReason };
    return;
  }

  if (eventType === 'message_stop') {
    ctx.sawMessageStop = true;
    return;
  }
}
