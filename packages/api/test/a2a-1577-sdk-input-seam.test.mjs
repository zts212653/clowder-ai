import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.ts';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';

test('real SDK carrier preserves accepted Append with freshness fully retired', { timeout: 5000 }, async () => {
  const calls = [];
  let dispatch;
  let appendReceipt;
  let appendRead = false;
  let launches = 0;
  let prepared = false;
  const service = new ClaudeSdkAgentService({
    runtimeResolver: claudeSdkRuntimeFixture,
    model: 'claude-opus-4-6',
    mcpServerPath: '',
    l0CompilerFn: async () => 'identity',
    queryFn: ({ prompt }) => ({
      close() {
        calls.push('close');
      },
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        launches++;
        const input = prompt[Symbol.asyncIterator]();
        const first = (await input.next()).value;
        yield { type: 'system', subtype: 'init', session_id: 's' };
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] } };
        appendReceipt = await dispatch(
          {
            text: 'ordinary Append',
            onInputRead: async () => {
              appendRead = true;
            },
          },
          { expectedInvocationId: 'i', force: false },
        );
        assert.equal(appendReceipt.accepted, true);
        const append = (await input.next()).value;
        yield {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'completed',
          user_message_uuids: [first.uuid],
          queued_turn_count: 0,
        };
        yield {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'completed',
          user_message_uuids: [append.uuid],
          queued_turn_count: 0,
        };
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
      },
    }),
  });
  const output = [];
  for await (const event of service.invoke('primary', {
    invocationId: 'i',
    activeRunDispatch: {
      invocationId: 'i',
      register(registration) {
        dispatch = registration.dispatch;
        return () => calls.push('release');
      },
    },
    activeInvocationFreshness: {
      async prepare(boundary) {
        if (prepared) return null;
        prepared = true;
        return {
          noticeId: 'n',
          expectedTurnId: boundary.turnId,
          boundary,
          text: 'content-free notice',
          frontier: 'm',
          correlationMessageIds: ['m'],
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
      async markTurnCompleted() {
        calls.push('completed');
      },
    },
  }))
    output.push(event);
  assert.equal(launches, 1);
  assert.equal('consumption' in appendReceipt, false, 'dispatch acceptance is independent of optional read evidence');
  assert.equal(appendRead, true);
  assert.deepEqual(calls, ['close', 'release']);
  assert.equal(output.filter((e) => e.type === 'error').length, 0);
});
