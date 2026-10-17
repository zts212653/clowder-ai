import assert from 'node:assert/strict';
import { it } from 'node:test';
import { projectCliToolEventRows } from '@cat-cafe/shared';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import {
  createAcpSessionState,
  transformAcpEvent,
} from '../../dist/domains/cats/services/agents/providers/acp/acp-event-transformer.js';
import { toStoredToolEvent } from '../../dist/domains/cats/services/agents/routing/route-helpers.js';
import { RedisMessageStore } from '../../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { safeParseToolEvents } from '../../dist/domains/cats/services/stores/redis/redis-message-parsers.js';

for (const initial of [undefined, { command: 'ech' }, { command: 'echo complete' }]) {
  it(`retains finalized input in visible cold history (initial=${JSON.stringify(initial)})`, () => {
    const state = createAcpSessionState();
    const transform = (update) =>
      transformAcpEvent({ sessionId: 'fixture', update }, 'dsh', { provider: 'acp', model: 'fixture' }, state);
    const use = transform({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'Bash',
      status: 'pending',
      ...(initial ? { rawInput: initial } : {}),
    });
    assert.equal(
      transform({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'in_progress',
        rawInput: { command: 'echo complete' },
      }),
      null,
    );
    const result = transform({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: 'complete',
    });
    assert.equal(use.type, 'tool_use');
    assert.equal(result.type, 'tool_result');
    const history = safeParseToolEvents(JSON.stringify([toStoredToolEvent(use), toStoredToolEvent(result)]));
    assert.equal(history.length, 2);
    assert.equal(history[1].inputDetail, '{"command":"echo complete"}');
    assert.deepEqual(projectCliToolEventRows(history), [
      { id: history[0].id, label: 'Bash echo complete', detail: 'complete', failed: false, settled: true },
    ]);
    assert.equal(transform({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }), null);
  });
}

it('preserves finalized input through the actual ACP service and RedisMessageStore write/read boundary', async () => {
  const input = { command: 'echo complete' };
  const client = {
    recentCapacitySignal: null,
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    async newSession() {
      return { sessionId: 'fixture-session', configOptions: [] };
    },
    async *promptStream(sessionId) {
      for (const update of [
        { sessionUpdate: 'tool_call', toolCallId: 'fixture-call', title: 'Bash', status: 'pending' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'fixture-call', status: 'in_progress', rawInput: input },
        { sessionUpdate: 'tool_call_update', toolCallId: 'fixture-call', status: 'completed', rawOutput: 'complete' },
      ])
        yield { sessionId, update };
    },
  };
  const service = new AcpAgentService({
    catId: 'dsh',
    providerName: 'dsh',
    modelName: 'fixture-profile',
    projectRoot: process.cwd(),
    poolKey: { projectPath: process.cwd(), providerProfile: 'fixture' },
    pool: {
      async acquire() {
        return { client, release() {} };
      },
    },
    mcpSupport: false,
  });
  const tools = [];
  for await (const msg of service.invoke('Deterministic transport fixture')) {
    assert.notEqual(msg.type, 'error');
    const stored = toStoredToolEvent(msg);
    if (stored) tools.push(stored);
  }
  let hash;
  // Capture the actual serializer's Lua hash; no Redis server or user storage is accessed.
  const redis = {
    options: {},
    async eval(...args) {
      if (args.length === 6) return 0;
      const start = 2 + Number(args[1]);
      const countIndex = start + 9 + Number(args[start + 8]);
      const pairs = args.slice(countIndex + 1, countIndex + 1 + Number(args[countIndex]) * 2);
      hash = Object.fromEntries(
        Array.from({ length: pairs.length / 2 }, (_, index) => [pairs[index * 2], pairs[index * 2 + 1]]),
      );
      return 1;
    },
    async hgetall() {
      return hash;
    },
  };
  const store = new RedisMessageStore(redis);
  const written = await store.append({
    threadId: 'fixture-thread',
    userId: 'fixture',
    from: { kind: 'agent', catId: 'dsh' },
    content: '',
    mentions: [],
    timestamp: 1,
    toolEvents: tools,
  });
  const coldStore = new RedisMessageStore(redis);
  const recovered = await coldStore.getById(written.id);
  assert.equal(recovered.toolEvents.length, 2);
  assert.equal(projectCliToolEventRows(recovered.toolEvents)[0].label, 'Bash echo complete');
  assert.equal(recovered.toolEvents[1].detail, 'complete');
});
