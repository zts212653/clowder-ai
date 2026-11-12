import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTurnBridgeState,
  DSH_TURN_METHODS,
  promptMatches,
  textOf,
} from '../../../../scripts/dsh-turn-bridge.mjs';
import { DSH_TURN_METHODS as CLIENT_METHODS } from '../../dist/domains/cats/services/agents/providers/acp/dsh/dsh-turn-protocol.js';

function fixture({ prompt = '先只分析，不修改文件', turn = 7, sessionId = 'session-1' } = {}) {
  const events = [];
  const steered = [];
  const inbox = { nextStep: [], nextTurn: [] };
  const agent = {
    session: { id: sessionId, deriveMessages: () => [] },
    inbox,
    steer(message) {
      steered.push(message);
      const text = textOf(message.content);
      if (text === 'throw') throw new Error('provider refused');
    },
  };
  const state = createTurnBridgeState({ notify: (message) => events.push(message.params) });
  state.onAgent(agent);
  state.onPromptRequest(11, sessionId, [{ type: 'text', text: prompt }]);
  return { state, events, steered, agent, inbox, turn, sessionId };
}

function claim(state, agent, text, turn, { id = 'native-message', source = { kind: 'user' }, content } = {}) {
  return state.onInboxClaimed({
    agent,
    message: { role: 'user', source, id, content: content ?? { type: 'text', text } },
    turn,
  });
}

function userMessage(id, text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { role: 'user', source, id, content: { type: 'text', text } } };
}

test('the bridge protocol stays byte-identical with the client constants', () => {
  assert.deepEqual(DSH_TURN_METHODS, CLIENT_METHODS);
});

test('the prompt binds only on its exact native claim; internal/user-context claims never bind', () => {
  const { state, events, agent, turn } = fixture();
  assert.equal(claim(state, agent, 'an unrelated internal turn', turn), null);
  assert.equal(events.length, 0);
  // Common L0 prefix with a different task suffix must not bind.
  assert.equal(claim(state, agent, '先只分析，不修改文件，但是另一个任务', turn), null);
  // A runtime-context message with identical text is still not the prompt.
  assert.equal(claim(state, agent, '先只分析，不修改文件', turn, { source: { kind: 'runtime-context' } }), null);
  assert.equal(events.length, 0);
  assert.equal(claim(state, agent, '先只分析，不修改文件', turn), turn);
  assert.deepEqual(events, [{ sessionId: 'session-1', type: 'turn_started', nativeTurnId: turn }]);
  // A later internal claim never rebinds the prompt turn.
  assert.equal(claim(state, agent, '先只分析，不修改文件', 99), null);
});

test('steer is idempotent per delivery and rejects wrong turn/input explicitly', () => {
  const { state, steered, agent, turn } = fixture();
  claim(state, agent, '先只分析，不修改文件', turn);
  assert.deepEqual(state.steer({ sessionId: 'session-1', deliveryId: 'd1', text: '只分析', expectedTurn: turn }), {
    accepted: true,
    nativeTurnId: turn,
    deliveryId: 'd1',
  });
  assert.equal(steered.length, 1);
  assert.deepEqual(state.steer({ sessionId: 'session-1', deliveryId: 'd1', text: '只分析' }), {
    accepted: true,
    nativeTurnId: turn,
    deliveryId: 'd1',
  });
  assert.equal(steered.length, 1, 'a retried delivery never steers twice');
  assert.deepEqual(state.steer({ sessionId: 'session-1', deliveryId: 'd1', text: 'different' }), {
    accepted: false,
    reason: 'duplicate_delivery',
  });
  assert.deepEqual(state.steer({ sessionId: 'session-1', deliveryId: 'd2', text: '只分析', expectedTurn: turn + 1 }), {
    accepted: false,
    reason: 'turn_mismatch',
  });
  assert.deepEqual(state.steer({ sessionId: 'session-1', deliveryId: 'd3', text: '   ' }), {
    accepted: false,
    reason: 'invalid_input',
  });
  assert.deepEqual(state.steer({ sessionId: 'other', deliveryId: 'd4', text: 'x' }), {
    accepted: false,
    reason: 'no_active_turn',
  });
});

test('multiplexed sessions keep independent prompts, deliveries and turn ends', () => {
  const events = [];
  const steered = { s1: [], s2: [] };
  const makeAgent = (id) => ({
    session: { id, deriveMessages: () => [] },
    inbox: { nextStep: [], nextTurn: [] },
    steer(message) {
      steered[id].push(message);
    },
  });
  const first = makeAgent('s1');
  const second = makeAgent('s2');
  const state = createTurnBridgeState({ notify: (message) => events.push(message.params) });
  state.onAgent(first);
  state.onAgent(second);
  state.onPromptRequest(1, 's1', [{ type: 'text', text: 'task one' }]);
  state.onPromptRequest(2, 's2', [{ type: 'text', text: 'task two' }]);
  assert.equal(claim(state, first, 'task one', 1), 1);
  assert.equal(claim(state, second, 'task two', 2), 2);

  assert.deepEqual(state.steer({ sessionId: 's1', deliveryId: 'a1', text: 'narrow one', expectedTurn: 1 }), {
    accepted: true,
    nativeTurnId: 1,
    deliveryId: 'a1',
  });
  assert.deepEqual(state.steer({ sessionId: 's2', deliveryId: 'b1', text: 'narrow two', expectedTurn: 2 }), {
    accepted: true,
    nativeTurnId: 2,
    deliveryId: 'b1',
  });
  assert.equal(steered.s1.length, 1);
  assert.equal(steered.s2.length, 1);

  // Ending s1 must not release or clear s2.
  assert.equal(
    state.onSessionEvent(
      { header: { id: 's1' } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ),
    'completed',
  );
  assert.deepEqual(state.steer({ sessionId: 's1', deliveryId: 'a2', text: 'late one' }), {
    accepted: false,
    reason: 'no_active_turn',
  });
  assert.deepEqual(state.steer({ sessionId: 's2', deliveryId: 'b2', text: 'still two', expectedTurn: 2 }), {
    accepted: true,
    nativeTurnId: 2,
    deliveryId: 'b2',
  });
  assert.deepEqual(
    events.filter((event) => event.sessionId === 's1').map((event) => [event.type, event.nativeTurnId]),
    [
      ['turn_started', 1],
      ['turn_ended', 1],
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.sessionId === 's2').map((event) => [event.type, event.nativeTurnId]),
    [['turn_started', 2]],
  );
});

test('the prompt message itself resolves the initial read receipt', () => {
  const { state, events, agent, turn } = fixture();
  claim(state, agent, '先只分析，不修改文件', turn);
  state.onSessionEvent({ header: { id: 'session-1' } }, userMessage('native-message', '先只分析，不修改文件'));
  assert.deepEqual(events.at(-1), {
    sessionId: 'session-1',
    type: 'input_read',
    deliveryId: 'native-message',
    nativeTurnId: turn,
  });
  // Runtime-context user/message is not a read fact even with a matching id.
  state.onSessionEvent(
    { header: { id: 'session-1' } },
    userMessage('runtime-context', 'context', { kind: 'runtime-context' }),
  );
  assert.equal(events.at(-1).type, 'input_read');
  assert.equal(events.at(-1).deliveryId, 'native-message');
});

test('a native user/message is the read fact; inbox/claimed alone only reports accepted', () => {
  const { state, events, agent, inbox, turn } = fixture();
  claim(state, agent, '先只分析，不修改文件', turn);
  state.steer({ sessionId: 'session-1', deliveryId: 'd1', text: '只分析' });
  // Parked in the native inbox, not yet committed to model history.
  inbox.nextStep.push({ id: 'd1' });
  assert.deepEqual(state.status({ sessionId: 'session-1', deliveryId: 'd1' }), {
    state: 'accepted',
    nativeTurnId: turn,
  });
  assert.deepEqual(state.status({ sessionId: 'session-1', deliveryId: 'missing' }), { state: 'unknown' });
  // Claim removal + no committed message: unknown, never "not accepted".
  inbox.nextStep.length = 0;
  assert.deepEqual(state.status({ sessionId: 'session-1', deliveryId: 'd1' }), { state: 'unknown' });

  state.onSessionEvent({ header: { id: 'session-1' } }, userMessage('d1', '只分析'));
  assert.deepEqual(events.at(-1), {
    sessionId: 'session-1',
    type: 'input_read',
    deliveryId: 'd1',
    nativeTurnId: turn,
  });
  assert.deepEqual(state.status({ sessionId: 'session-1', deliveryId: 'd1' }), {
    state: 'read',
    nativeTurnId: turn,
  });
});

test('native history also proves read when the read notification was missed', () => {
  const { state, agent, turn } = fixture();
  claim(state, agent, '先只分析，不修改文件', turn);
  agent.session.deriveMessages = () => [{ id: 'd1' }];
  state.steer({ sessionId: 'session-1', deliveryId: 'd1', text: '只分析' });
  assert.deepEqual(state.status({ sessionId: 'session-1', deliveryId: 'd1' }), {
    state: 'read',
    nativeTurnId: turn,
  });
});

test('turn/end ends the prompt turn and rejects later nudges', () => {
  const { state, events, agent, turn } = fixture();
  claim(state, agent, '先只分析，不修改文件', turn);
  state.steer({ sessionId: 'session-1', deliveryId: 'd1', text: '只分析' });
  assert.equal(
    state.onSessionEvent(
      { header: { id: 'session-1' } },
      {
        type: 'turn/end',
        data: { turn, reason: { kind: 'completed' } },
      },
    ),
    'completed',
  );
  assert.deepEqual(events.at(-1), {
    sessionId: 'session-1',
    type: 'turn_ended',
    nativeTurnId: turn,
    reason: 'completed',
  });
  assert.deepEqual(state.steer({ sessionId: 'session-1', deliveryId: 'd2', text: 'late' }), {
    accepted: false,
    reason: 'no_active_turn',
  });
});

test('a provider refusal is not remembered as accepted', () => {
  const { state, agent, turn } = fixture();
  claim(state, agent, '先只分析，不修改文件', turn);
  assert.deepEqual(state.steer({ sessionId: 'session-1', deliveryId: 'd1', text: 'throw' }), {
    accepted: false,
    reason: 'provider_rejected',
  });
  assert.deepEqual(state.status({ sessionId: 'session-1', deliveryId: 'd1' }), { state: 'not_accepted' });
});

test('prompt matching is exact after line-ending normalization only', () => {
  assert.equal(promptMatches('a\r\nb', { type: 'text', text: 'a\nb' }), true);
  assert.equal(promptMatches('L0 common\nTASK A', { type: 'text', text: 'L0 common\nTASK B' }), false);
  assert.equal(promptMatches('a  b', { type: 'text', text: 'a b' }), false);
  assert.equal(promptMatches('a b c', { type: 'text', text: 'a b c extra' }), false);
  assert.equal(promptMatches('', { type: 'text', text: '' }), false);
  assert.equal(textOf([{ type: 'text', text: 'x' }, { type: 'image' }]), 'x');
  assert.equal(textOf({ type: 'text', text: 'y' }), 'y');
});
