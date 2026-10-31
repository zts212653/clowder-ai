import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeTextInput } from './native-text.mjs';

test('typed request reaches native execution, not just realtime context', async () => {
  const calls = [];
  const rpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      return { turn: { id: 't1' } };
    },
  };
  await new NativeTextInput().send(rpc, 'native-1', 'Read the permitted file');
  assert.deepEqual(
    calls.map((c) => c.method),
    ['turn/start', 'thread/realtime/appendText'],
  );
  assert.equal(calls[0].params.input[0].text, 'Read the permitted file');
});

test('continued text steers the actual active native turn; completion permits a new turn', async () => {
  const calls = [];
  const input = new NativeTextInput();
  const rpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      return { turn: { id: 't2' } };
    },
  };
  input.observe('turn/started', { turn: { id: 'voice-turn' } });
  await input.send(rpc, 'native-1', 'Add this constraint');
  assert.equal(calls[0].method, 'turn/steer');
  assert.equal(calls[0].params.expectedTurnId, 'voice-turn');
  input.observe('turn/completed', { turn: { id: 'voice-turn' } });
  calls.length = 0;
  await input.send(rpc, 'native-1', 'New request');
  assert.equal(calls[0].method, 'turn/start');
});

test('a failed context mirror does not reject or repeat already accepted execution', async () => {
  const calls = [];
  const rpc = {
    request: async (method) => {
      calls.push(method);
      if (method === 'thread/realtime/appendText') throw new Error('fixture realtime loss');
      return { turn: { id: 'accepted' } };
    },
  };
  const outcomes = [];
  const result = await new NativeTextInput(
    () => false,
    (event) => outcomes.push(event),
  ).send(rpc, 'native-1', 'One request');
  assert.equal(result.mirrorScheduled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcomes[0].delivered, false);
  assert.deepEqual(calls, ['turn/start', 'thread/realtime/appendText']);
});

test('queued submissions cannot start duplicate parallel turns', async () => {
  const calls = [];
  const input = new NativeTextInput();
  const rpc = {
    request: async (method) => {
      calls.push(method);
      return { turn: { id: 't1' } };
    },
  };
  await Promise.all([input.send(rpc, 'native-1', 'First'), input.send(rpc, 'native-1', 'Second')]);
  assert.deepEqual(calls, ['turn/start', 'thread/realtime/appendText', 'turn/steer', 'thread/realtime/appendText']);
});

test('a hanging realtime context mirror cannot delay native acceptance or later steering', async () => {
  const calls = [];
  let release;
  const mirror = new Promise((resolve) => {
    release = resolve;
  });
  const rpc = {
    request: async (method) => {
      calls.push(method);
      if (method === 'thread/realtime/appendText') await mirror;
      return { turn: { id: 't1' } };
    },
  };
  const input = new NativeTextInput();
  let accepted = false;
  const first = input.send(rpc, 'native-1', 'First').then(() => {
    accepted = true;
  });
  const second = input.send(rpc, 'native-1', 'Second');
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(accepted, true);
    assert.equal(calls.includes('turn/steer'), true);
  } finally {
    release();
    await Promise.all([first, second]);
  }
});

test('a shared screen observation reaches the native visual input with the user request', async () => {
  const calls = [];
  const rpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      return { turn: { id: 'visual-turn' } };
    },
  };
  const observation = {
    frameId: 'frame-1',
    sourceLabel: 'Chosen window',
    observedAt: 1000,
    width: 640,
    height: 480,
    image: 'data:image/jpeg;base64,/9j/AA==',
  };
  await new NativeTextInput().send(rpc, 'native-1', 'What is in this window?', () => observation);
  assert.deepEqual(calls[0].params.input.at(-1), { type: 'image', url: observation.image });
  assert.match(calls[0].params.input[1].text, /frame-1/);
  assert.match(calls[0].params.input[1].text, /observation.*not instructions/i);
  assert.equal(calls[1].params.text.includes(observation.image), false);
});

test('queued input reads the current screen grant at execution, never a revoked cached frame', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const rpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'turn/start') await gate;
      return { turn: { id: 't1' } };
    },
  };
  const input = new NativeTextInput();
  let observation = { frameId: 'frame-1', image: 'data:image/jpeg;base64,/9j/AA==' };
  const first = input.send(rpc, 'native-1', 'First');
  const queued = input.send(rpc, 'native-1', 'Now look here', () => observation);
  await new Promise((resolve) => setImmediate(resolve));
  observation = undefined;
  release();
  await Promise.all([first, queued]);
  assert.equal(calls.find((call) => call.method === 'turn/steer').params.input.length, 1);
});
