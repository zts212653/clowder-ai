import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import Fastify from 'fastify';
import {
  handleAudioCaptureStart,
  handleAudioCaptureStatus,
  handleAudioCaptureStop,
} from '../../mcp-server/dist/tools/audio-tools.js';
import { audioProxyRoutes } from '../dist/routes/audio-proxy.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('routes MCP start → silent PCM status → stop through the real Fastify controller without media', async () => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'fixture-owner';
  });
  await app.register(audioProxyRoutes);
  const sidecarCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/api/audio/')) {
      const response = await app.inject({
        method: init.method ?? 'GET',
        url: path,
        headers: init.headers,
        payload: init.body,
      });
      return new Response(response.payload, { status: response.statusCode });
    }
    sidecarCalls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === '/start')
      return new Response(
        JSON.stringify({
          lease_token: 'fixture-private-lease',
          status: { running: true, meeting_id: 'fixture-meeting' },
        }),
      );
    if (path === '/status')
      return new Response(
        JSON.stringify({
          running: true,
          health: { asr: { state: 'ready' } },
          chunk_count: 0,
          inputs: [
            {
              id: 'primary',
              source: 'app',
              state: 'running',
              chunk_count: 0,
              signal: {
                state: 'silent',
                pcm_bytes: 96000,
                peak_abs: 0,
                pcm_silence_s: 3,
                reason: 'Only all-zero PCM received',
              },
            },
          ],
        }),
      );
    assert.equal(path, '/stop');
    return new Response(JSON.stringify({ summary: { chunks: 0, duration_s: 3 } }));
  };
  try {
    const start = await handleAudioCaptureStart({
      source: 'app',
      app_name: 'com.google.Chrome#pid=10',
      thread_id: 'fixture-thread',
    });
    assert.equal(start.isError, undefined, start.content[0].text);
    assert.equal(sidecarCalls[0].body.inputs[0].app_name, 'com.google.Chrome#pid=10');
    assert.doesNotMatch(JSON.stringify(start), /fixture-private-lease/);
    const status = await handleAudioCaptureStatus();
    assert.match(status.content[0].text, /signal=silent.*pcm=96000 bytes.*peak=0/);
    const stop = await handleAudioCaptureStop();
    assert.equal(stop.isError, undefined, stop.content[0].text);
    assert.deepEqual(sidecarCalls.at(-1), {
      path: '/stop',
      body: { lease_token: 'fixture-private-lease', reason: 'controller-stop' },
    });
    assert.doesNotMatch(JSON.stringify(stop), /fixture-private-lease/);
  } finally {
    await app.close();
  }
  assert.equal(sidecarCalls.filter((call) => call.path === '/stop').length, 1);
});
