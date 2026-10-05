import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';

const completed = {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'done' }] },
};
const started = {
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'sleep 1' } }] },
};

async function run(
  consumed = true,
  crash = false,
  bookkeepingFailure?: 'delivered' | 'missed' | 'completed' | 'query_close',
) {
  const calls: string[] = [];
  let input: AsyncIterator<unknown>;
  let first: { uuid: string };
  let notice: { uuid: string; priority?: string; origin?: unknown };
  const queryFn = ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    input = prompt[Symbol.asyncIterator]();
    return {
      async *[Symbol.asyncIterator]() {
        first = (await input.next()).value as typeof first;
        yield { type: 'system', subtype: 'init', session_id: 'session' };
        yield started;
        yield completed;
        notice = (await input.next()).value as typeof notice;
        if (crash) throw new Error('provider failed after tool effect');
        yield {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'completed',
          session_id: 'session',
          user_message_uuids: consumed ? [first.uuid, notice.uuid] : [first.uuid],
          queued_turn_count: 0,
        };
      },
      close() {
        calls.push('close');
        if (bookkeepingFailure === 'query_close') throw new Error('query_cleanup_unavailable');
      },
    };
  };
  let prepared = false;
  const controller = {
    async prepare(boundary: { turnId: string }) {
      calls.push('prepare');
      if (prepared) return null;
      prepared = true;
      return {
        noticeId: 'notice',
        expectedTurnId: boundary.turnId,
        text: 'content-free freshness notice',
        boundary,
        frontier: 'm1',
        correlationMessageIds: ['m1'],
        provider: 'anthropic',
        carrier: 'claude_agent_sdk',
        deliverySemantics: 'queued_internal_turn',
      };
    },
    async commitDelivered(_notice: unknown, result: { acceptedTurnId: string }) {
      assert.equal(result.acceptedTurnId, first.uuid);
      calls.push('delivered');
      if (bookkeepingFailure === 'delivered') throw new Error('owner_delivered_unavailable');
    },
    async markMissed(_notice: unknown, reason: string) {
      calls.push(`missed:${reason}`);
      if (bookkeepingFailure === 'missed') throw new Error('owner_missed_unavailable');
    },
    async markTurnCompleted() {
      calls.push('completed');
      if (bookkeepingFailure === 'completed') throw new Error('owner_completed_unavailable');
    },
  };
  const service = new ClaudeSdkAgentService({
    catId: createCatId('opus'),
    model: 'claude-opus-4-6',
    queryFn,
    l0CompilerFn: async () => 'identity',
    mcpServerPath: '',
  });
  const output = [];
  for await (const event of service.invoke('develop', {
    activeInvocationFreshness: controller,
    workingDirectory: '/tmp',
  }))
    output.push(event);
  assert.equal(notice?.priority, undefined);
  assert.equal(notice?.origin, undefined);
  return { calls, output, service };
}

test('SDK notice reaches ordinary native tool chain; input enqueue alone is not delivered', async () => {
  const { calls, service } = await run();
  assert.equal(calls.filter((c) => c === 'delivered').length, 1);
  assert.equal(calls.filter((c) => c.startsWith('missed')).length, 0);
  assert.deepEqual(service.freshnessCarrierCapability(), {
    provider: 'anthropic',
    carrier: 'claude_agent_sdk',
    deliverySemantics: 'queued_internal_turn',
  });
});

test('tail race preserves missed responsibility even when queued_turn_count is zero', async () => {
  const { calls } = await run(false);
  assert.ok(calls.includes('missed:turn_completed'));
  assert.ok(!calls.includes('delivered'));
});

test('failure after acceptance is surfaced once and never replays tools', async () => {
  const { calls, output } = await run(true, true);
  assert.ok(calls.includes('missed:transport_failed'));
  const errors = output.filter((e) => e.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.metadata?.cliDiagnostics?.excerptSource, 'unknown_raw');
  assert.equal(output.filter((e) => e.type === 'done').length, 1);
});

test('local launch validation remains visible without blaming Claude or starting the SDK', async () => {
  for (const options of [
    { cliConfigArgs: ['unexpected-positional'] },
    {
      spawnCliOverride: () => {
        throw new Error('must not spawn');
      },
    },
  ]) {
    let launches = 0;
    const service = new ClaudeSdkAgentService({
      model: 'claude-opus-4-6',
      mcpServerPath: '',
      l0CompilerFn: async () => 'identity',
      queryFn: () => {
        launches++;
        throw new Error('must not query');
      },
    });
    const output = [];
    for await (const event of service.invoke('develop', options)) output.push(event);
    const errors = output.filter((event) => event.type === 'error');
    assert.equal(launches, 0);
    assert.equal(errors.length, 1);
    const diagnostics = errors[0]?.metadata?.cliDiagnostics;
    assert.equal(diagnostics?.excerptSource, 'unknown_raw');
    assert.ok(diagnostics?.safeExcerpt);
    assert.ok(errors[0]?.error);
    assert.doesNotMatch(diagnostics?.publicHint ?? '', /不是猫咖问题/);
    assert.equal(output.find((event) => event.type === 'done')?.errorCode, 'claude_sdk_failed');
  }
});

for (const operation of ['delivered', 'missed', 'completed'] as const) {
  test(`successful SDK work survives ${operation} bookkeeping rejection`, async () => {
    const { calls, output } = await run(operation !== 'missed', false, operation);
    assert.equal(output.filter((event) => event.type === 'error').length, 0);
    const done = output.filter((event) => event.type === 'done');
    assert.equal(done.length, 1);
    assert.equal(done[0]?.errorCode, undefined);
    assert.equal(calls.filter((call) => call === 'close').length, 1);
    assert.equal(calls.filter((call) => call === 'completed').length, 1);
    if (operation !== 'completed') {
      assert.ok(
        output.some(
          (event) => event.type === 'system_info' && event.content?.includes('claude_sdk_notice_unconfirmed'),
        ),
      );
    }
  });
}

test('missed bookkeeping rejection preserves the original provider failure and completes owner lifecycle', async () => {
  const { calls, output } = await run(false, true, 'missed');
  const errors = output.filter((event) => event.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.error, 'provider failed after tool effect');
  assert.equal(calls.filter((call) => call === 'completed').length, 1);
  assert.equal(output.filter((event) => event.type === 'done').length, 1);
});

test('SDK query cleanup failure cannot replace the successful primary result or skip owner completion', async () => {
  const { calls, output } = await run(true, false, 'query_close');
  assert.equal(output.filter((event) => event.type === 'error').length, 0);
  const done = output.filter((event) => event.type === 'done');
  assert.equal(done.length, 1);
  assert.equal(done[0]?.errorCode, undefined);
  assert.equal(calls.filter((call) => call === 'completed').length, 1);
});

test('SDK cancellation closes streaming input, yields done, and does not restart', async () => {
  const abort = new AbortController();
  let launches = 0;
  const service = new ClaudeSdkAgentService({
    model: 'claude-opus-4-6',
    mcpServerPath: '',
    l0CompilerFn: async () => 'identity',
    queryFn: ({ prompt }) => {
      launches++;
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          const iterator = prompt[Symbol.asyncIterator]();
          await iterator.next();
          yield { type: 'system', subtype: 'init', session_id: 's' };
          abort.abort();
          assert.equal((await iterator.next()).done, true);
          yield { type: 'result', subtype: 'success' };
        },
      };
    },
  });
  const output = [];
  for await (const item of service.invoke('develop', { signal: abort.signal })) output.push(item);
  assert.equal(launches, 1);
  assert.equal(output.filter((item) => item.type === 'done').length, 1);
  assert.ok(!output.some((item) => item.type === 'error'));
});

test('one upstream API failure emitted as assistant and result surfaces one terminal error', async () => {
  for (const text of ['API Error: 400 version too old', 'Provider refused this development request']) {
    const service = new ClaudeSdkAgentService({
      model: 'claude-opus-4-6',
      mcpServerPath: '',
      l0CompilerFn: async () => 'identity',
      queryFn: ({ prompt }) => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          const first = (await prompt[Symbol.asyncIterator]().next()).value;
          yield {
            type: 'assistant',
            error: 'invalid_request',
            is_api_error_message: true,
            message: { model: '<synthetic>', content: [{ type: 'text', text }] },
          };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: true,
            terminal_reason: 'api_error',
            result: text,
            user_message_uuids: [first?.uuid],
          };
        },
      }),
    });
    const output = [];
    for await (const item of service.invoke('develop')) output.push(item);
    const errors = output.filter((item) => item.type === 'error');
    assert.equal(errors.length, 1);
    if (text.startsWith('Provider')) assert.equal(errors[0]?.metadata?.cliDiagnostics?.excerptSource, 'cc_structured');
  }
});

test('long silent native tool receives notice through the SDK input timer', async () => {
  const calls: string[] = [];
  let pending = false;
  const service = new ClaudeSdkAgentService({
    model: 'claude-opus-4-6',
    mcpServerPath: '',
    l0CompilerFn: async () => 'identity',
    queryFn: ({ prompt }) => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        const iterator = prompt[Symbol.asyncIterator]();
        const first = (await iterator.next()).value;
        yield { type: 'system', subtype: 'init', session_id: 's' };
        yield started;
        const notice = (await iterator.next()).value;
        assert.ok(!calls.includes('delivered'), 'dequeue alone is not provider result evidence');
        yield {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'completed',
          user_message_uuids: [first?.uuid, notice?.uuid],
        };
      },
    }),
  });
  const output = [];
  for await (const item of service.invoke('develop', {
    activeInvocationFreshness: {
      async prepare(boundary) {
        if (pending) return null;
        pending = true;
        return {
          noticeId: 'n',
          frontier: 'm',
          correlationMessageIds: ['m'],
          expectedTurnId: boundary.turnId,
          boundary,
          text: 'content-free notice',
          provider: 'anthropic',
          carrier: 'claude_agent_sdk',
          deliverySemantics: 'queued_internal_turn',
        };
      },
      async commitDelivered() {
        calls.push('delivered');
      },
      async markMissed() {
        calls.push('missed');
      },
      async markTurnCompleted() {},
    },
  }))
    output.push(item);
  assert.deepEqual(calls, ['delivered']);
});

test('carrier factory opts in explicitly and preserves default and unknown selection', async () => {
  const { createClaudeAgentServiceForCanary } = await import(
    '../src/domains/cats/services/agents/providers/claude-carrier-factory.js'
  );
  const previous = process.env.CAT_OPUS_MODEL;
  process.env.CAT_OPUS_MODEL = 'claude-opus-4-6';
  try {
    assert.ok(
      createClaudeAgentServiceForCanary(createCatId('opus'), { CAT_CAFE_CLAUDE_CARRIER: 'agent_sdk' }) instanceof
        ClaudeSdkAgentService,
    );
    assert.equal(
      createClaudeAgentServiceForCanary(createCatId('opus'), {}).freshnessCarrierCapability?.().carrier,
      'claude_print_sdk',
    );
    assert.equal(
      createClaudeAgentServiceForCanary(createCatId('opus'), {
        CAT_CAFE_CLAUDE_CARRIER: 'unknown',
      }).freshnessCarrierCapability?.().carrier,
      'claude_print_sdk',
    );
  } finally {
    if (previous === undefined) delete process.env.CAT_OPUS_MODEL;
    else process.env.CAT_OPUS_MODEL = previous;
  }
});
