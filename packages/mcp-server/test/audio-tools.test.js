import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';
import {
  audioCaptureStartInputSchema,
  handleAudioCaptureStart,
  handleAudioCaptureStatus,
  handleAudioCaptureStop,
  handleAudioListSources,
  handleAudioReadTranscript,
  shutdownActiveAudioCapture,
} from '../dist/tools/audio-tools.js';

const originalFetch = globalThis.fetch;

afterEach(async () => {
  await shutdownActiveAudioCapture();
  globalThis.fetch = originalFetch;
});

describe('MCP audio client contract', () => {
  it('lists display names with the exact stable capture IDs', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          apps: [{ id: 'com.huawei.cloudlink', name: 'Huawei Cloud Meeting' }],
          mics: [],
        }),
        { status: 200 },
      );

    const result = await handleAudioListSources();

    assert.equal(result.isError, undefined, result.content[0].text);
    assert.match(result.content[0].text, /Huawei Cloud Meeting \[com\.huawei\.cloudlink\]/);
  });

  it('rejects additional input IDs that the canonical audio service rejects', () => {
    const schema = z.object(audioCaptureStartInputSchema);

    assert.equal(
      schema.safeParse({
        source: 'mic',
        thread_id: 'thread-1',
        additional_inputs: [{ id: '../escape', source: 'mic' }],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        source: 'mic',
        thread_id: 'thread-1',
        additional_inputs: [{ id: 'comment.mic-1', source: 'mic' }],
      }).success,
      true,
    );
  });

  it('uses the API-owned controller and expands the legacy primary source into inputs', async () => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), headers: init.headers, body });
      if (String(url).endsWith('/api/audio/start')) {
        return new Response(
          JSON.stringify({
            ok: true,
            status: {
              running: true,
              inputs: [
                { id: 'meeting', source: 'app', app_name: 'WeLink', state: 'running' },
                { id: 'comment', source: 'mic', state: 'running' },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          summary: {
            chunks: 0,
            recording_paths: { primary: '/tmp/primary.mp3', comment: '/tmp/comment.mp3' },
          },
        }),
        { status: 200 },
      );
    };

    const started = await handleAudioCaptureStart({
      source: 'app',
      app_name: 'WeLink',
      thread_id: 'thread-1',
      additional_inputs: [{ id: 'comment', source: 'mic', label: 'My mic' }],
    });
    assert.equal(started.isError, undefined, started.content[0].text);

    const start = calls[0];
    assert.match(start.url, /\/api\/audio\/start$/);
    assert.equal(start.headers['x-cat-cafe-user'], 'default-user');
    assert.deepEqual(start.body.inputs, [
      { id: 'primary', source: 'app', app_name: 'WeLink' },
      { id: 'comment', source: 'mic', label: 'My mic' },
    ]);
    assert.equal(Object.hasOwn(start.body, 'controller_id'), false);
    assert.equal(Object.hasOwn(start.body, 'lease_ttl_s'), false);

    const stopped = await handleAudioCaptureStop();
    assert.equal(stopped.isError, undefined, stopped.content[0].text);
    assert.match(calls.at(-1).url, /\/api\/audio\/stop$/);
    assert.deepEqual(calls.at(-1).body, {});
    assert.match(stopped.content[0].text, /Recording \(primary\): \/tmp\/primary\.mp3/);
    assert.match(stopped.content[0].text, /Recording \(comment\): \/tmp\/comment\.mp3/);
  });

  it('sends valid JSON to stop instead of an empty JSON request', async () => {
    globalThis.fetch = async (_url, init) => {
      if (init.headers['Content-Type'] === 'application/json' && !init.body) {
        return new Response(JSON.stringify({ message: 'Body cannot be empty when content-type is application/json' }), {
          status: 400,
        });
      }
      assert.deepEqual(JSON.parse(init.body), {});
      return new Response(JSON.stringify({ summary: { chunks: 0, duration_s: 1 } }));
    };
    const result = await handleAudioCaptureStop();
    assert.equal(result.isError, undefined, result.content[0].text);
  });

  for (const [body, reason] of [
    [
      { error: 'Bad Request', message: 'Body cannot be empty when content-type is application/json' },
      'Body cannot be empty',
    ],
    [{ error: 'No audio capture lease is owned by this runtime' }, 'No audio capture lease'],
    ['upstream gateway unavailable', 'upstream gateway unavailable'],
  ]) {
    it(`preserves the stop error: ${reason}`, async () => {
      globalThis.fetch = async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 400 });
      const result = await handleAudioCaptureStop();
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Stop failed: 400/);
      assert.ok(result.content[0].text.includes(reason), result.content[0].text);
      assert.doesNotMatch(result.content[0].text, /Cannot reach Clowder AI API/);
    });
  }

  it('does not stop capture when the MCP invocation shuts down', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          ok: true,
          lease_token: 'must-not-be-owned-by-mcp',
          status: { running: true, inputs: [{ id: 'mic', source: 'mic', state: 'running' }] },
        }),
        { status: 200 },
      );
    };

    const started = await handleAudioCaptureStart({ source: 'mic', thread_id: 'thread-1' });
    assert.equal(started.isError, undefined, started.content[0].text);
    await shutdownActiveAudioCapture();

    assert.deepEqual(
      calls.filter((url) => url.endsWith('/stop')),
      [],
    );
  });

  it('preserves ASR recovery actions returned by the API', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'ASR deep-health inference failed',
          action: {
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

  it('surfaces component health and every input degradation reason', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          running: true,
          duration_s: 12,
          chunk_count: 4,
          avg_asr_latency: 0.4,
          health: {
            asr: { state: 'ready' },
            speaker_separation: { state: 'degraded', reason: 'model unavailable' },
          },
          cluster_diagnostics: {
            confirmed: 2,
            provisional: 1,
            max_clusters: 8,
            confirmations_required: 2,
            birth_threshold: 0.65,
            assignment_threshold: 0.55,
            replacements: 0,
          },
          inputs: [
            { id: 'meeting', source: 'app', label: 'WeLink', state: 'running', chunk_count: 3 },
            { id: 'comment', source: 'mic', label: 'My mic', state: 'failed', reason: 'device unplugged' },
          ],
        }),
        { status: 200 },
      );

    const result = await handleAudioCaptureStatus();

    assert.equal(result.isError, undefined, result.content[0].text);
    assert.match(result.content[0].text, /speaker_separation=degraded \(model unavailable\)/);
    assert.match(result.content[0].text, /Speaker clusters: 2 confirmed; 1 learning/);
    assert.match(result.content[0].text, /My mic: failed.*device unplugged/);
  });

  it('shows silent PCM independently of ready models and a running input', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          running: true,
          duration_s: 55,
          chunk_count: 0,
          health: { asr: { state: 'ready' } },
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
    const result = await handleAudioCaptureStatus();
    assert.match(result.content[0].text, /signal=silent/);
    assert.match(result.content[0].text, /pcm=96000 bytes/);
    assert.match(result.content[0].text, /Only all-zero PCM received/);
  });

  it('keeps input source and speaker evidence in text and MeetingContextBlock output', async () => {
    const line = {
      ts: 1_787_600_000,
      elapsed_s: 2,
      chunk_num: 1,
      asr_latency: 0.3,
      text: '本地评论',
      speaker_label: 'You',
      speaker_confidence: 1,
      speaker_id: 'operator',
      speaker_identity_source: 'exclusive_source',
      input_id: 'comment',
      input_source: 'mic',
      input_label: 'My mic',
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/status')) {
        return new Response(JSON.stringify({ running: true, meeting_id: 'meeting-1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ lines: [line] }), { status: 200 });
    };

    const textResult = await handleAudioReadTranscript({});
    assert.match(textResult.content[0].text, /\[My mic\] You: 本地评论/);

    const blockResult = await handleAudioReadTranscript({ format: 'context_block' });
    const blocks = JSON.parse(blockResult.content[0].text);
    assert.equal(blocks[0].inputId, 'comment');
    assert.equal(blocks[0].inputSource, 'mic');
    assert.equal(blocks[0].speakerIdentitySource, 'exclusive_source');
  });
});
