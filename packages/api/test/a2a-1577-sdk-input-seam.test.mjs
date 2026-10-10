import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.ts';
import {
  ClaudeSdkTurnInputState,
  createSdkUserMessage,
} from '../src/domains/cats/services/agents/providers/claude-sdk-turn-input-state.ts';

test('auxiliary notice cannot promise a hidden provider turn or consume an accepted Append', async () => {
  const state = new ClaudeSdkTurnInputState();
  const input = state.input[Symbol.asyncIterator]();
  state.push(createSdkUserMessage('primary', 's', 'primary'));
  await input.next();
  assert.equal(state.pushNotice('notice', 's', 'notice'), 'notice');
  state.push(createSdkUserMessage('append', 's', 'append'));
  await input.next();
  await input.next();
  state.settleResult({ user_message_uuids: ['primary', 'notice'], queued_turn_count: 0 });
  assert.equal(state.isAccepting, true, 'an older notice/result cannot settle later Append');
  state.settleResult({ user_message_uuids: ['append'], queued_turn_count: 0 });
  assert.equal(state.isAccepting, false);
  assert.equal((await input.next()).done, true);
});

test('withdrawing a locally queued notice preserves ordinary inputs and final primary closure', async () => {
  const state = new ClaudeSdkTurnInputState();
  const input = state.input[Symbol.asyncIterator]();
  state.push(createSdkUserMessage('primary', 's', 'primary'));
  await input.next();
  state.pushNotice('notice', 's', 'notice');
  state.withdrawNotice('notice');
  state.push(createSdkUserMessage('append', 's', 'append'));
  assert.equal((await input.next()).value.uuid, 'append');
  state.settleResult({ user_message_uuids: ['primary', 'append'] });
  assert.equal((await input.next()).done, true);
});

test(
  'real SDK carrier settles native notice without dropping accepted Append or repeating a query',
  { timeout: 5000 },
  async () => {
    const calls = [];
    let dispatch;
    let appendReceipt;
    let launches = 0;
    let prepared = false;
    const service = new ClaudeSdkAgentService({
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
          const notice = (await input.next()).value;
          appendReceipt = await dispatch({ text: 'ordinary Append' }, { expectedInvocationId: 'i', force: false });
          assert.equal(appendReceipt.accepted, true);
          const append = (await input.next()).value;
          yield {
            type: 'result',
            subtype: 'success',
            terminal_reason: 'completed',
            user_message_uuids: [first.uuid, notice.uuid],
            queued_turn_count: 0,
          };
          yield {
            type: 'result',
            subtype: 'success',
            terminal_reason: 'completed',
            user_message_uuids: [append.uuid],
            queued_turn_count: 0,
          };
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
    assert.equal((await appendReceipt.consumption).consumed, true);
    assert.deepEqual(calls, ['delivered', 'close', 'release', 'completed']);
    assert.equal(output.filter((e) => e.type === 'error').length, 0);
  },
);
