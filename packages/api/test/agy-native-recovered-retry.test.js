import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  projectAgyNativeTurn,
  readAgyNativeTurn,
} from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';

// Sanitized projection of invocation 8ec3f911: error 70, successful work 71–92,
// matching final 93, then an ERROR envelope retaining the earlier API error.
const recorded = () =>
  readFileSync(new URL('./fixtures/agy-stream-json/recovered-retry-turn.ndjson', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
async function replay(events, { cancelled = false, compaction = false } = {}) {
  const observed = await readAgyNativeTurn(
    (async function* () {
      yield* events;
    })(),
    {
      agentName: 'fixture-agent',
      spawnCwd: '/fixture',
      model: 'gemini-4-argon-high',
    },
  );
  const metadata = {};
  const messages = projectAgyNativeTurn('gemini-argon', metadata, observed, cancelled, undefined, compaction);
  return { observed, metadata, messages };
}

for (const numTurns of [2, 1]) {
  test(`recovered retry finishes without a trailing failure (session turn ${numTurns})`, async () => {
    const events = recorded();
    events.at(-1).result.num_turns = numTurns;
    const { observed, metadata, messages } = await replay(events);
    assert.equal(observed.turn.upstreamStatus, 'ERROR');
    assert.equal(messages.at(-1).errorCode, undefined);
    assert.equal(
      messages.some((m) => m.type === 'error'),
      false,
    );
    assert.equal(messages.find((m) => m.type === 'text').content, 'Recovered review\n');
    assert.deepEqual(metadata.diagnostics.agyNative.recoveredErrorSteps, [70]);
    assert.match(metadata.diagnostics.agyNative.retainedSessionError, /attempt 1/);
    assert.equal(messages.filter((m) => m.type === 'tool_result').length, 16);
  });
}

for (const [label, mutate, options] of [
  [
    'new terminal error',
    (events) =>
      events.splice(-1, 0, {
        event: 'step_update',
        step_update: {
          conversation_id: 'recovered-retry-session',
          step_index: 94,
          step_type: 'error_message',
          state: 'DONE',
        },
      }),
  ],
  [
    'error index beyond final',
    (events) => {
      events.find((e) => e.step_update?.step_type === 'error_message').step_update.step_index = 94;
    },
  ],
  [
    'unfinished error',
    (events) => {
      events.find((e) => e.step_update?.step_type === 'error_message').step_update.state = 'ACTIVE';
    },
  ],
  [
    'unfinished response',
    (events) => {
      events.findLast((e) => e.step_update?.step_index === 93).step_update.state = 'ACTIVE';
    },
  ],
  [
    'mismatching final',
    (events) => {
      events.at(-1).result.response = 'different answer';
    },
  ],
  [
    'new unknown step',
    (events) => {
      events.find((e) => e.step_update?.step_type === 'error_message').step_update.step_type = 'future_error';
    },
  ],
  ['cancelled', () => {}, { cancelled: true }],
  [
    'transport exit',
    (events) => events.push({ __cliError: true, exitCode: 3, signal: null, message: 'CLI exited 3', command: 'agy' }),
  ],
  ['transport timeout', (events) => events.push({ __cliTimeout: true, message: 'CLI timed out', command: 'agy' })],
  [
    'first-turn terminal error without recovery',
    (events) => {
      events.at(-1).result.num_turns = 1;
      events.splice(
        events.findIndex((e) => e.step_update?.step_type === 'error_message'),
        1,
      );
    },
  ],
]) {
  test(`recovered retry does not hide ${label}`, async () => {
    const events = recorded();
    mutate(events);
    const { messages } = await replay(events, options);
    assert.ok(messages.at(-1).errorCode, label);
  });
}

test('first-turn compaction can recover an earlier error but cannot hide a later error or transport failure', async () => {
  const events = recorded().filter((e) => !e.step_update || e.step_update.step_index <= 70);
  events.at(-1).result.num_turns = 1;
  events.at(-1).result.response = '';
  events.splice(-1, 0, {
    event: 'step_update',
    step_update: { conversation_id: 'recovered-retry-session', step_index: 71, step_type: 'checkpoint', state: 'DONE' },
  });
  const { messages } = await replay(events, { compaction: true });
  assert.equal(messages.at(-1).errorCode, undefined);
  const retainedExit = [
    ...events,
    { __cliError: true, exitCode: 3, signal: null, message: 'CLI exited 3', command: 'agy' },
  ];
  assert.equal((await replay(retainedExit, { compaction: true })).messages.at(-1).errorCode, undefined);
  const laterError = structuredClone(events);
  laterError.splice(-1, 0, {
    event: 'step_update',
    step_update: {
      conversation_id: 'recovered-retry-session',
      step_index: 72,
      step_type: 'error_message',
      state: 'DONE',
    },
  });
  assert.ok((await replay(laterError, { compaction: true })).messages.at(-1).errorCode);
  events.push({ __cliError: true, exitCode: 1, signal: null, message: 'CLI exited 1', command: 'agy' });
  assert.ok((await replay(events, { compaction: true })).messages.at(-1).errorCode);
});
