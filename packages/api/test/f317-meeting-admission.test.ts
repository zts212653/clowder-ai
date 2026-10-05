import assert from 'node:assert/strict';
import { test } from 'node:test';
import { F317MeetingAdmission } from '../src/domains/concierge/meeting/f317-meeting-admission.js';

const call = {
  userId: 'owner-1',
  threadId: 'live-thread',
  catId: 'codex6-sol',
  callId: 'call-1',
  generation: 1,
  state: 'talking' as const,
};
const capture = {
  running: true,
  paused: false,
  threadId: 'meeting-thread',
  meetingId: 'mtg-1',
  startedAt: 100,
  inputs: [{ id: 'app-1', source: 'app' as const, label: 'Local test app', state: 'running' as const }],
};
const intent = {
  callId: call.callId,
  generation: call.generation,
  captureThreadId: capture.threadId,
  meetingId: capture.meetingId,
  captureStartedAt: capture.startedAt,
  inputId: capture.inputs[0].id,
  inputLabel: capture.inputs[0].label,
};
const observed = { actorUserId: 'owner-1', sourceThreadOwnerUserId: 'owner-1', call, capture, intent };

test('active F195 capture and home reads do not grant Live transcript sharing', () => {
  const admission = new F317MeetingAdmission();
  assert.equal(admission.authorize(call, capture), false);
  assert.equal(admission.current(), null);
});

test('one explicit owner action binds exact capture and call; duplicate click is idempotent', () => {
  const admission = new F317MeetingAdmission();
  const first = admission.admit(observed);
  const second = admission.admit(observed);
  assert.equal(first, second);
  assert.equal(first.meetingId, 'mtg-1');
  assert.equal(first.captureThreadId, 'meeting-thread');
  assert.equal(first.callId, 'call-1');
  assert.equal(first.catId, 'codex6-sol');
  assert.equal(first.liveThreadId, 'live-thread');
  assert.equal(admission.authorize(call, capture), true);
  admission.revoke();
  assert.equal(first.signal.aborted, true);
  assert.equal(admission.authorize(call, capture), false);
});

test('stale or foreign owner action cannot admit an observed meeting', () => {
  for (const attempted of [
    { ...observed, actorUserId: 'other-user' },
    { ...observed, sourceThreadOwnerUserId: 'other-user' },
    { ...observed, intent: { ...intent, generation: 0 } },
    { ...observed, intent: { ...intent, meetingId: 'other-meeting' } },
    { ...observed, intent: { ...intent, captureStartedAt: 99 } },
    { ...observed, intent: { ...intent, inputId: 'app-2' } },
    { ...observed, intent: { ...intent, inputLabel: 'Other App' } },
    { ...observed, call: { ...call, state: 'preparing' as const } },
    { ...observed, capture: { ...capture, running: false } },
    { ...observed, capture: { ...capture, paused: true } },
    { ...observed, capture: { ...capture, meetingId: '../escape' }, intent: { ...intent, meetingId: '../escape' } },
    {
      ...observed,
      capture: {
        ...capture,
        inputs: [{ id: 'mic-1', source: 'mic' as const, label: 'Mic', state: 'running' as const }],
      },
    },
    { ...observed, capture: { ...capture, inputs: [{ ...capture.inputs[0], state: 'failed' as const }] } },
  ]) {
    const admission = new F317MeetingAdmission();
    assert.throws(() => admission.admit(attempted), /meeting_share_not_admitted/);
    assert.equal(admission.current(), null);
  }
});

test('stop, call generation change, and same-ID recapture revoke before a late delivery', () => {
  for (const [nextCall, nextCapture] of [
    [call, { ...capture, running: false }],
    [call, { ...capture, paused: true }],
    [{ ...call, generation: 2 }, capture],
    [{ ...call, catId: 'other-cat' }, capture],
    [call, { ...capture, startedAt: 101 }],
    [
      call,
      {
        ...capture,
        inputs: [
          ...capture.inputs,
          { id: 'app-2', source: 'app' as const, label: 'Second app', state: 'running' as const },
        ],
      },
    ],
    [
      call,
      {
        ...capture,
        inputs: [...capture.inputs, { id: 'mic-1', source: 'mic' as const, label: 'Mic', state: 'running' as const }],
      },
    ],
  ] as const) {
    const admission = new F317MeetingAdmission();
    const grant = admission.admit(observed);
    assert.equal(admission.authorize(nextCall, nextCapture), false);
    assert.equal(grant.signal.aborted, true);
    assert.equal(admission.current(), null);
  }
});
