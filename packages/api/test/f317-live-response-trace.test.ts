import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveResponseTrace } from '../src/domains/concierge/live/live-response-trace.js';

test('reasoning, tools and draft deltas never become outward, visible or audible observations', () => {
  const events: string[] = [];
  const t = new LiveResponseTrace({ userId: 'owner', threadId: 'home', catId: 'cat', callId: 'call' }, () => ({
    addEvent(name) {
      events.push(name);
      return this;
    },
    end() {},
  }));
  t.protocol({ method: 'item/reasoning/textDelta', params: { delta: 'thinking' } });
  t.protocol({ method: 'item/agentMessage/delta', params: { turnId: 'turn', itemId: 'draft', delta: 'draft' } });
  t.mark('speech_submitted');
  assert.deepEqual(events, ['live.provider_text_delta', 'live.speech_submitted']);
  t.playback({ stage: 'first_audio_output', callId: 'foreign', eventId: 'e', observedAt: Date.now(), turnId: 'voice' });
  t.playback({ stage: 'first_audio_output', callId: 'call', eventId: 'old', observedAt: 1, turnId: 'voice' });
  const output = {
    stage: 'first_audio_output' as const,
    callId: 'call',
    eventId: 'now',
    observedAt: Date.now(),
    turnId: 'voice',
  };
  t.playback(output);
  t.playback(output);
  t.close();
  t.playback({ ...output, eventId: 'after-stop' });
  assert.deepEqual(events, ['live.provider_text_delta', 'live.speech_submitted', 'live.first_audio_output']);
});

test('child tool rejection is recorded separately and actual first child text is observed once per child turn', () => {
  const events: string[] = [];
  const t = new LiveResponseTrace({ userId: 'owner', threadId: 'home', catId: 'cat', callId: 'call' }, () => ({
    addEvent(name) {
      events.push(name);
      return this;
    },
    end() {},
  }));
  const child = {
    v: 1 as const,
    kind: 'subexecution' as const,
    id: 'e',
    stage: 'message' as const,
    rootExecutionId: 'root',
    rootTurnId: 'root-turn',
    parentExecutionId: 'root',
    parentTurnId: 'root-turn',
    subexecutionId: 'child',
    agentPath: '/root/reader',
    depth: 1,
    occurredAt: Date.now(),
    turnId: 'child-turn',
    messagePhase: 'unknown' as const,
    content: 'native_turn_admission_unavailable',
  };
  assert.equal(typeof t.child, 'function', 'the child adapter must distinguish a rejection from outward text');
  t.child({ ...child, id: 'subexecution:codex:tool-failed:trusted-coordinates' }, 'denial');
  t.child({ ...child, id: 'a', messagePhase: 'final_answer', content: 'Actual comparison' }, 'answer');
  t.child({ ...child, id: 'b', messagePhase: 'final_answer', content: 'More actual text' }, 'more');
  assert.deepEqual(events, ['live.child_tool_failed', 'live.child_first_output']);
  t.close();
});

test('Host preload submission keeps its own clock and client identity, distinct from API receipt and durable acceptance', () => {
  const events: Array<{ name: string; at?: number; client?: unknown }> = [];
  const t = new LiveResponseTrace({ userId: 'owner', threadId: 'home', catId: 'cat', callId: 'call' }, () => ({
    addEvent(name, attrs, at) {
      events.push({ name, at: at instanceof Date ? at.getTime() : undefined, client: attrs?.clientMessageId });
      return this;
    },
    end() {},
  }));
  const submittedAt = Date.now() - 100;
  const submission = { stage: 'client_text_sent' as const, observedAt: submittedAt, clientMessageId: 'client-request' };
  t.textSubmission(submission);
  t.textSubmission(submission);
  t.mark('typed_received', { clientMessageId: 'client-request' });
  t.mark('persistent_accept', { clientMessageId: 'client-request', messageId: 'durable-message' });
  t.textSubmission({ ...submission, clientMessageId: 'old', observedAt: 1 });
  assert.deepEqual(
    events.map((event) => event.name),
    ['live.client_text_sent', 'live.typed_received', 'live.persistent_accept'],
  );
  assert.equal(events[0].at, submittedAt);
  assert.ok(events[1].at! > events[0].at!);
  assert.ok(events.every((event) => event.client === 'client-request'));
  t.close();
});
