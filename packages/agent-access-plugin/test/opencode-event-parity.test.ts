import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeOpenCodeEvent } from '../src/runtime/opencode-event-parser.ts';
import { transformOpenCodeEvent } from '../../api/src/domains/cats/services/agents/providers/opencode-event-transform.ts';

/**
 * The event reading moved from the Host transformer into this package. Until the
 * Host is rewired to consume the wire event, both implementations exist, and the
 * only safe claim is that they agree.
 *
 * These cases compare the new extraction against the Host function it must
 * replace. They are deliberately raw-shape driven: if the CLI changes, the
 * disagreement shows up here rather than as a silent output drop.
 */
const CAT = 'opencode';

/** Project a wire event onto the Host message it must become, for comparison. */
function projectToHostShape(wire: ReturnType<typeof normalizeOpenCodeEvent>) {
  switch (wire.kind) {
    case 'ignored':
      return null;
    case 'session_init':
      return { type: 'session_init', sessionId: wire.sessionId, timestamp: wire.timestamp };
    case 'text':
      return { type: 'text', content: wire.text, timestamp: wire.timestamp };
    case 'thinking':
      return {
        type: 'system_info',
        content: JSON.stringify({ type: 'thinking', text: wire.text }),
        timestamp: wire.timestamp,
      };
    case 'tool':
      return {
        type: 'tool_use',
        toolName: wire.name,
        ...(wire.input ? { toolInput: wire.input } : {}),
        timestamp: wire.timestamp,
      };
    case 'usage':
      return { type: 'agent_loop', usage: wire.usage, timestamp: wire.timestamp };
    case 'error':
      return { type: 'error', error: wire.message, timestamp: wire.timestamp };
  }
}

/** Compare only the fields the transformer owned (it also stamps catId, which we ignore). */
function comparableHostShape(message: ReturnType<typeof transformOpenCodeEvent>) {
  if (!message) return null;
  const { catId: _catId, ...rest } = message as Record<string, unknown>;
  if (rest.type === 'agent_loop') {
    const metadata = rest.metadata as { usage?: Record<string, unknown> } | undefined;
    return { type: 'agent_loop', usage: metadata?.usage, timestamp: rest.timestamp };
  }
  if (rest.type === 'error') {
    // The Host sanitises/truncates error text; the wire event carries the raw
    // declared message. Compare presence, not the sanitised body.
    return { type: 'error', hasError: typeof rest.error === 'string' && rest.error.length > 0 };
  }
  return rest;
}

function comparableWireShape(wire: ReturnType<typeof normalizeOpenCodeEvent>) {
  const projected = projectToHostShape(wire);
  if (!projected) return null;
  if (projected.type === 'error') return { type: 'error', hasError: (projected.error ?? '').length > 0 };
  return projected;
}

const RAW_CASES: Array<{ name: string; event: unknown }> = [
  { name: 'step_start', event: { type: 'step_start', sessionID: 'ses_1', timestamp: 1 } },
  { name: 'text', event: { type: 'text', part: { type: 'text', text: 'hello' }, timestamp: 2 } },
  { name: 'text as reasoning', event: { type: 'text', part: { type: 'reasoning', text: 'why' }, timestamp: 3 } },
  { name: 'reasoning', event: { type: 'reasoning', part: { text: 'hmm' }, timestamp: 4 } },
  {
    name: 'tool_use with input',
    event: { type: 'tool_use', part: { tool: 'bash', state: { input: { cmd: 'ls' } } }, timestamp: 5 },
  },
  { name: 'tool_use bare', event: { type: 'tool_use', part: {}, timestamp: 6 } },
  {
    name: 'step_finish with cache',
    event: { type: 'step_finish', part: { tokens: { input: 10, output: 2, cache: { read: 100 } } }, timestamp: 7 },
  },
  { name: 'step_finish empty', event: { type: 'step_finish', part: {}, timestamp: 8 } },
  { name: 'error', event: { type: 'error', error: { name: 'E', data: { message: 'boom' } }, timestamp: 9 } },
  { name: 'unknown', event: { type: 'mystery', timestamp: 10 } },
  { name: 'empty text', event: { type: 'text', part: { text: '' }, timestamp: 11 } },
];

describe('OpenCode event parity between the package and the Host transformer', () => {
  for (const { name, event } of RAW_CASES) {
    test(`${name} reads the same on both sides`, () => {
      const host = transformOpenCodeEvent(event, CAT);
      const wire = normalizeOpenCodeEvent(event);

      assert.deepEqual(comparableWireShape(wire), comparableHostShape(host), `divergence on: ${name}`);
    });
  }
});
