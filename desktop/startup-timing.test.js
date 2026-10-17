const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createStartupTimeline } = require('./startup-timing');

test('records successful and failed phases without logging action results or errors', async () => {
  let now = 100;
  const entries = [];
  const timeline = createStartupTimeline({
    component: 'fixture',
    emit: (value) => entries.push(value),
    now: () => now,
  });
  const secret = new Error('private configuration');
  assert.equal(
    await timeline.runPhase('ready', async () => {
      now += 25;
      return 'private result';
    }),
    'private result',
  );
  await assert.rejects(
    timeline.runPhase('failed', async () => {
      now += 40;
      throw secret;
    }),
    (error) => error === secret,
  );
  const events = entries.map((entry) => JSON.parse(entry.slice('[desktop-startup] '.length)));
  assert.deepEqual(
    events.map(({ phase, state, durationMs }) => ({ phase, state, durationMs })),
    [
      { phase: 'ready', state: 'start', durationMs: undefined },
      { phase: 'ready', state: 'complete', durationMs: 25 },
      { phase: 'failed', state: 'start', durationMs: undefined },
      { phase: 'failed', state: 'failed', durationMs: 40 },
    ],
  );
  assert.equal(entries.join('').includes('private'), false);
});
