import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import type { PreparedProviderRequestV1 } from '../src/domains/cats/services/types.js';
import { CodexStartupWire } from './helpers/codex-startup-wire.js';

const key = 'cat-cafe.active-work';
const sourceId = 'original-source-message';

class CompactionWire extends CodexStartupWire {
  restored = false;
  compactionCompleted = false;
  constructor(readonly foreign?: 'thread' | 'turn') {
    super();
  }
  override async *read() {
    for await (const value of super.read()) {
      const event = value as { method?: string; params?: { item?: { type?: string } } };
      if (event.method === 'item/completed' && event.params?.item?.type === 'contextCompaction') {
        this.compactionCompleted = true;
      }
      yield value;
    }
  }
  override async write(message: Record<string, unknown>) {
    if (message.method === 'turn/steer') {
      this.writes.push(message);
      this.restored = true;
      this.push({ id: message.id, result: { turnId: 'same-turn' } });
      return;
    }
    if (message.method !== 'turn/start') return super.write(message);
    this.writes.push(message);
    this.push({ id: message.id, result: { turn: { id: 'same-turn', status: 'inProgress' } } });
    for (const method of ['item/started', 'item/completed', 'item/completed'])
      this.push({
        method,
        params: {
          threadId: this.foreign === 'thread' ? 'another-thread' : 'same-native-thread',
          turnId: this.foreign === 'turn' ? 'another-turn' : 'same-turn',
          item: { id: 'native-window-change', type: 'contextCompaction' },
        },
      });
    setImmediate(() => {
      this.push({
        method: 'item/completed',
        params: {
          threadId: 'same-native-thread',
          turnId: 'same-turn',
          item: {
            id: 'answer',
            type: 'agentMessage',
            phase: 'final_answer',
            text: this.restored ? 'The original request continued.' : 'Repository ready. Give me a task.',
          },
        },
      });
      this.push({
        method: 'turn/completed',
        params: {
          threadId: 'same-native-thread',
          turn: { id: 'same-turn', status: 'completed' },
        },
      });
    });
  }
}

async function run(wire: CodexStartupWire, record?: (request: PreparedProviderRequestV1) => void) {
  const anchor = { threadId: 'cafe-thread', invocationId: 'cafe-invocation', promptMessageIds: [] as string[] };
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    model: 'gpt-test',
    l0CompilerFn: async () => 'IDENTITY_ONLY',
  });
  const events = [];
  for await (const event of service.invokeWithContinuityPreflight(
    {
      settle: async () => {
        anchor.promptMessageIds.push(sourceId);
        return { prompt: 'TASK_BODY_MUST_REMAIN_USER_INPUT' };
      },
    },
    {
      invocationId: anchor.invocationId,
      recoveryAnchor: anchor,
      agentCarrierSessionFactory: async () => wire,
      beforeProviderLaunch: async (request) => {
        record?.(request);
        return { requestGenerationId: 'generation', generationOrdinal: 1, sessionId: 'session' };
      },
    },
  ))
    events.push(event);
  return events;
}

test('native new_context restores the same accepted task once, after compaction completes', async () => {
  const wire = new CompactionWire();
  const prepared: PreparedProviderRequestV1[] = [];
  const events = await run(wire, (request) => {
    if (prepared.length > 0) {
      assert.equal(wire.compactionCompleted, true, 'startup or compaction-start context would be discarded');
      assert.equal(
        wire.writes.some((message) => message.method === 'turn/steer'),
        false,
      );
    }
    prepared.push(request);
  });
  const steers = wire.writes.filter((message) => message.method === 'turn/steer');
  assert.equal(steers.length, 1, 'a completed compaction restores work once, including replayed events');
  const params = steers[0].params as Record<string, unknown>;
  assert.equal(params.threadId, 'same-native-thread');
  assert.equal(params.expectedTurnId, 'same-turn');
  const active = (params.additionalContext as Record<string, { kind: string; value: string }>)[key];
  assert.equal(active.kind, 'application');
  assert.match(active.value, /original-source-message/);
  assert.match(active.value, /cafe-thread/);
  assert.match(active.value, /cafe-invocation/);
  assert.doesNotMatch(active.value, /TASK_BODY_MUST_REMAIN_USER_INPUT|IDENTITY_ONLY/);
  assert.equal(prepared.length, 2);
  assert.deepEqual(params.input, [{ type: 'text', text: prepared[1].message.body }]);
  assert.equal(prepared[1].boundaryReason, 'provider_continuation');
  assert.equal(prepared[1].nativeInstructions[0].body, active.value);
  assert.deepEqual(prepared[1].nativeInstructions[0].sourceRefs, [
    { owner: 'message', ref: 'cafe-thread:original-source-message' },
  ]);
  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 1, 'do not replay the task');
  assert.ok(events.some((event) => event.type === 'text' && event.content?.includes('original request continued')));
  const initialize = wire.writes.find((message) => message.method === 'initialize');
  assert.equal(
    (initialize?.params as { capabilities: { experimentalApi?: boolean } }).capabilities.experimentalApi,
    true,
  );
});

for (const foreign of ['thread', 'turn'] as const) {
  test(`another native ${foreign} cannot trigger continuation of this request`, async () => {
    const wire = new CompactionWire(foreign);
    await run(wire);
    assert.equal(
      wire.writes.some((message) => message.method === 'turn/steer'),
      false,
    );
  });
}

test('an invocation without authoritative source coordinates does not invent an active task', async () => {
  const wire = new CompactionWire();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    model: 'gpt-test',
    l0CompilerFn: async () => 'IDENTITY_ONLY',
  });
  for await (const _ of service.invoke('ordinary conversation', { agentCarrierSessionFactory: async () => wire })) {
    // No Task/authority may be inferred from prose.
  }
  const params = wire.writes.find((message) => message.method === 'turn/start')?.params as Record<string, unknown>;
  assert.equal((params.additionalContext as Record<string, unknown> | undefined)?.[key], undefined);
  assert.equal(
    wire.writes.some((message) => message.method === 'turn/steer'),
    false,
  );
});
