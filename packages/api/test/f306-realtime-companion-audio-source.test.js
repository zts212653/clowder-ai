import assert from 'node:assert/strict';
import { test } from 'node:test';

const audioSourceModule = import('../dist/routes/realtime-companion-audio-source.js');

function sseResponse(frames) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        const wire = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
        const midpoint = Math.floor(wire.length / 2);
        controller.enqueue(encoder.encode(wire.slice(0, midpoint)));
        controller.enqueue(encoder.encode(wire.slice(midpoint)));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function keepaliveResponse() {
  const encoder = new TextEncoder();
  let timer;
  return new Response(
    new ReadableStream({
      start(controller) {
        timer = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 2);
      },
      cancel() {
        clearInterval(timer);
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

test('audio source only observes the existing F195 session and projects bounded transcript SSE', async () => {
  const { createRealtimeCompanionAudioSource } = await audioSourceModule;
  const calls = [];
  const source = createRealtimeCompanionAudioSource({
    url: 'http://audio.test',
    fetchFn: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET' });
      if (url.endsWith('/status')) {
        return new Response(JSON.stringify({ running: true, thread_id: 'thread-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return sseResponse([
        {
          type: 'transcript',
          ts: 1_788_000_000,
          text: '这段也太神人了',
          input_id: 'browser',
          input_source: 'app',
          input_label: 'Bilibili',
          speaker_label: 'Speaker 1',
        },
        { type: 'transcript', ts: 1_788_000_001, text: '[ASR error: unavailable]', asr_error: {} },
        { type: 'status', status: 'stopped' },
      ]);
    },
  });

  assert.deepEqual(await source.inspect('thread-1'), { state: 'ready' });
  const transcripts = [];
  let stopped = 0;
  const subscription = await source.subscribe('thread-1', {
    onTranscript: (line) => transcripts.push(line),
    onStopped: () => {
      stopped += 1;
    },
  });
  await subscription.closed;
  assert.deepEqual(transcripts, [
    {
      text: '这段也太神人了',
      observedAt: 1_788_000_000_000,
      inputId: 'browser',
      inputSource: 'app',
      inputLabel: 'Bilibili',
      speakerLabel: 'Speaker 1',
    },
  ]);
  assert.equal(stopped, 1);
  assert.deepEqual(calls, [
    { url: 'http://audio.test/status', method: 'GET' },
    { url: 'http://audio.test/events', method: 'GET' },
  ]);
});

test('audio source rejects a capture bound to another Clowder AI thread', async () => {
  const { createRealtimeCompanionAudioSource } = await audioSourceModule;
  const source = createRealtimeCompanionAudioSource({
    url: 'http://audio.test',
    fetchFn: async () =>
      new Response(JSON.stringify({ running: true, thread_id: 'thread-other' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  assert.deepEqual(await source.inspect('thread-1'), {
    state: 'thread_mismatch',
    activeThreadId: 'thread-other',
  });
});

test('audio source rotates a keepalive-only listener and revalidates the exact capture thread', async () => {
  const { createRealtimeCompanionAudioSource } = await audioSourceModule;
  let eventRequests = 0;
  const source = createRealtimeCompanionAudioSource({
    url: 'http://audio.test',
    rotationIntervalMs: 10,
    fetchFn: async (url) => {
      if (url.endsWith('/status')) {
        return new Response(JSON.stringify({ running: true, thread_id: 'thread-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      eventRequests += 1;
      return eventRequests === 1
        ? keepaliveResponse()
        : sseResponse([
            { type: 'transcript', ts: 1_788_000_002, text: 'listener recovered' },
            { type: 'status', status: 'stopped' },
          ]);
    },
  });
  const transcripts = [];
  let stopped = 0;
  const subscription = await source.subscribe('thread-1', {
    onTranscript: (line) => transcripts.push(line.text),
    onStopped: () => {
      stopped += 1;
    },
  });
  try {
    await Promise.race([
      subscription.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('listener did not rotate')), 150)),
    ]);
    assert.equal(eventRequests, 2);
    assert.deepEqual(transcripts, ['listener recovered']);
    assert.equal(stopped, 1);
  } finally {
    subscription.close();
  }
});

for (const terminalState of ['not_running', 'unavailable']) {
  test(`audio source closes a rotated listener when capture becomes ${terminalState}`, async () => {
    const { createRealtimeCompanionAudioSource } = await audioSourceModule;
    let eventRequests = 0;
    const source = createRealtimeCompanionAudioSource({
      url: 'http://audio.test',
      rotationIntervalMs: 10,
      fetchFn: async (url) => {
        if (url.endsWith('/status')) {
          if (terminalState === 'unavailable') throw new Error('status unavailable');
          return new Response(JSON.stringify({ running: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        eventRequests += 1;
        return keepaliveResponse();
      },
    });
    let stopped = 0;
    let errors = 0;
    const subscription = await source.subscribe('thread-1', {
      onTranscript: () => {},
      onStopped: () => {
        stopped += 1;
      },
      onError: () => {
        errors += 1;
      },
    });
    try {
      await Promise.race([
        subscription.closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('listener did not close')), 150)),
      ]);
      assert.equal(eventRequests, 1);
      assert.equal(stopped, terminalState === 'not_running' ? 1 : 0);
      assert.equal(errors, terminalState === 'unavailable' ? 1 : 0);
    } finally {
      subscription.close();
    }
  });
}
