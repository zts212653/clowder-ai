import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  handleAudioCaptureStart,
  handleAudioCaptureStop,
  shutdownActiveAudioCapture,
} from '../dist/tools/audio-tools.js';

const originalFetch = globalThis.fetch;

afterEach(async () => {
  await shutdownActiveAudioCapture();
  globalThis.fetch = originalFetch;
});

describe('MCP audio controller lease', () => {
  it('keeps the sidecar lease token private and uses it to stop capture', async () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/start')) {
        return new Response(
          JSON.stringify({
            ok: true,
            lease_token: 'mcp-lease-secret',
            status: { source: 'mic', thread_id: 'thread-1' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, summary: { chunks: 0, duration_s: 0 } }), {
        status: 200,
      });
    };

    const started = await handleAudioCaptureStart({ source: 'mic', thread_id: 'thread-1' });
    assert.equal(started.isError, undefined);
    assert.doesNotMatch(started.content[0].text, /mcp-lease-secret/);

    const stopped = await handleAudioCaptureStop();
    assert.equal(stopped.isError, undefined);
    const stop = calls.find((call) => call.url.endsWith('/stop'));
    assert.deepEqual(stop.body, { lease_token: 'mcp-lease-secret', reason: 'controller-stop' });
  });

  it('lets an expired controller lease recover after the audio sidecar disappears', async () => {
    const originalNow = Date.now;
    let now = originalNow();
    let startCalls = 0;
    Date.now = () => now;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/start')) {
        startCalls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            lease_token: `mcp-lease-${startCalls}`,
            status: { source: 'mic', thread_id: `thread-${startCalls}` },
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/stop')) {
        return new Response(JSON.stringify({ ok: true, summary: { chunks: 0 } }), { status: 200 });
      }
      throw new Error('audio sidecar unavailable');
    };

    try {
      const first = await handleAudioCaptureStart({ source: 'mic', thread_id: 'thread-1' });
      assert.equal(first.isError, undefined);

      now += 20_000;
      const recovered = await handleAudioCaptureStart({ source: 'mic', thread_id: 'thread-2' });

      assert.equal(recovered.isError, undefined, recovered.content[0].text);
      assert.equal(startCalls, 2);
    } finally {
      Date.now = originalNow;
    }
  });

  it('does not send an expired controller token when stopping capture', async () => {
    const originalNow = Date.now;
    let now = originalNow();
    const calls = [];
    Date.now = () => now;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/start')) {
        return new Response(
          JSON.stringify({
            ok: true,
            lease_token: 'expired-mcp-lease',
            status: { source: 'mic', thread_id: 'thread-1' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, summary: { chunks: 0 } }), { status: 200 });
    };

    try {
      await handleAudioCaptureStart({ source: 'mic', thread_id: 'thread-1' });
      now += 20_000;

      const stopped = await handleAudioCaptureStop();

      assert.equal(stopped.isError, true);
      assert.match(stopped.content[0].text, /No audio capture lease/);
      assert.deepEqual(
        calls.filter((url) => url.endsWith('/stop')),
        [],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it('preserves ASR recovery actions in the tool error', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'ASR deep-health inference failed',
          code: 'asr-deep-health-failed',
          action: {
            service_id: 'whisper-stt',
            start_endpoint: '/api/services/whisper-stt/start',
            logs_endpoint: '/api/services/whisper-stt/logs',
          },
        }),
        { status: 503 },
      );

    const result = await handleAudioCaptureStart({ source: 'mic', thread_id: 'thread-1' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /\/api\/services\/whisper-stt\/start/);
    assert.match(result.content[0].text, /\/api\/services\/whisper-stt\/logs/);
  });

  it('finalizes an active capture on MCP runtime shutdown', async () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/start')) {
        return new Response(
          JSON.stringify({
            ok: true,
            lease_token: 'shutdown-secret',
            status: { source: 'mic', thread_id: 'thread-1' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, summary: { chunks: 0 } }), { status: 200 });
    };

    await handleAudioCaptureStart({ source: 'mic', thread_id: 'thread-1' });
    await shutdownActiveAudioCapture();

    const stop = calls.find((call) => call.url.endsWith('/stop'));
    assert.deepEqual(stop.body, {
      lease_token: 'shutdown-secret',
      reason: 'runtime-graceful-shutdown',
    });
  });
});
