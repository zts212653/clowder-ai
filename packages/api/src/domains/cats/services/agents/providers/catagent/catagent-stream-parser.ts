import { projectCatAgentEvents } from '@clowder-ai/agent-access/runtime/catagent-events';
import type { CatAgentSseFrame } from '@clowder-ai/agent-contract/catagent';

export type { CatAgentStreamEvent } from '@clowder-ai/agent-contract/catagent';

interface SSEParserState {
  eventType: string;
  dataLines: string[];
}

export function parseAnthropicSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return projectCatAgentEvents(readCatAgentSseFrames(body, signal));
}

/** Frame the HTTP transport before projecting the provider payload across the plugin boundary. */
export async function* readCatAgentSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<CatAgentSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  const sseState: SSEParserState = { eventType: '', dataLines: [] };
  try {
    while (true) {
      if (signal?.aborted) {
        yield { kind: 'transport_error', error: 'Request aborted' };
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) yield* processSSELine(line, sseState);
    }
    if (buffer.trim()) yield* processSSELine(buffer, sseState);
    const final = flushSSEState(sseState);
    if (final) yield final;
  } catch (error: unknown) {
    yield {
      kind: 'transport_error',
      error: `Stream read error: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    reader.releaseLock();
  }
}

function processSSELine(line: string, state: SSEParserState): Extract<CatAgentSseFrame, { kind: 'event' }>[] {
  const results: Extract<CatAgentSseFrame, { kind: 'event' }>[] = [];

  if (line === '') {
    // Empty line = event boundary
    const evt = flushSSEState(state);
    if (evt) results.push(evt);
    return results;
  }
  if (line.startsWith(':')) return results; // Comment/ping
  if (line.startsWith('event:')) {
    state.eventType = line.slice(6).trim();
  } else if (line.startsWith('data:')) {
    state.dataLines.push(line.slice(5).trimStart());
  }
  return results;
}

function flushSSEState(state: SSEParserState): Extract<CatAgentSseFrame, { kind: 'event' }> | null {
  if (state.dataLines.length === 0) {
    state.eventType = '';
    return null;
  }
  const evt: Extract<CatAgentSseFrame, { kind: 'event' }> = {
    kind: 'event',
    name: state.eventType || 'message',
    data: state.dataLines.join('\n'),
  };
  state.eventType = '';
  state.dataLines = [];
  return evt;
}
