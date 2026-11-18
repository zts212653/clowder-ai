import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { resolveCatVoice } from '../src/config/cat-voices.js';
import { ListenAssetService } from '../src/domains/cats/services/tts/ListenAssetService.js';
import { MlxAudioTtsProvider } from '../src/domains/cats/services/tts/MlxAudioTtsProvider.js';
import { TtsRegistry } from '../src/domains/cats/services/tts/TtsRegistry.js';
import { ttsRoutes } from '../src/routes/tts.js';
import { fixture } from './helpers/voice-selection-fixture.js';

for (const receiptMode of ['legacy', 'valid', 'missing', 'mismatch', 'unavailable', 'path-only']) {
  for (const streaming of [false, true]) {
    test(`${receiptMode} reader ${streaming ? 'stream' : 'export'} preserves provenance without API snapshots`, async (t) => {
      const f = await fixture(true);
      await f.app.close();
      const source = resolveCatVoice('opus').config.refAudio;
      assert.ok(source);
      await chmod(dirname(source), 0o700);
      await chmod(source, 0o600);
      if (receiptMode === 'path-only') await chmod(source, 0);
      const previous = globalThis.fetch;
      t.after(() => {
        globalThis.fetch = previous;
      });
      let speechCalls = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/health'))
          return Response.json({
            status: 'ok',
            backend: 'qwen3-clone',
            model: 'mlx-community/Breeze-TTS-2-mlx',
            capabilities: [
              'speech-stream-route-v1',
              ...(receiptMode === 'legacy' ? [] : ['reference-audio-content-v1']),
            ],
          });
        speechCalls++;
        const input = JSON.parse(String(init?.body));
        if (receiptMode !== 'legacy' && receiptMode !== 'path-only') assert.ok(input.ref_audio_base64);
        if (receiptMode === 'path-only') assert.equal(input.ref_audio_base64, undefined);
        const digest = createHash('sha256')
          .update(
            input.ref_audio_base64
              ? Buffer.from(input.ref_audio_base64, 'base64')
              : Buffer.from('reference-audio-fixture'),
          )
          .digest('hex');
        // The reader's filesystem shares the configured library, not the API cache.
        return new Response(
          receiptMode === 'unavailable'
            ? 'REMOTE_DEFAULT'
            : input.ref_audio === source
              ? 'REMOTE_SELECTED_VOICE'
              : 'REMOTE_DEFAULT',
          {
            headers: {
              'x-audio-format': 'wav',
              ...(receiptMode === 'valid' || receiptMode === 'path-only'
                ? { 'x-tts-reference-status': 'used', 'x-tts-reference-sha256': digest }
                : {}),
              ...(receiptMode === 'mismatch'
                ? { 'x-tts-reference-status': 'used', 'x-tts-reference-sha256': '0'.repeat(64) }
                : {}),
              ...(receiptMode === 'unavailable' ? { 'x-tts-reference-status': 'unavailable' } : {}),
            },
          },
        );
      };
      const registry = new TtsRegistry();
      registry.register(
        new MlxAudioTtsProvider({ baseUrl: 'http://127.0.0.1:19889', model: 'mlx-community/Breeze-TTS-2-mlx' }),
      );
      const app = Fastify();
      t.after(() => app.close());
      await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: join(f.root, 'cache') });
      const headers = { 'x-cat-cafe-user': 'voice-test' };
      const expectedStatus =
        receiptMode === 'valid' ? 'sent' : receiptMode === 'unavailable' ? 'unavailable' : 'unverified';
      const expectedVoice = receiptMode === 'unavailable' ? 'REMOTE_DEFAULT' : 'REMOTE_SELECTED_VOICE';
      const outputs: string[] = [];
      for (let i = 0; i < 2; i++) {
        const response = await app.inject({
          method: 'POST',
          url: streaming ? '/api/tts/stream' : '/api/tts/synthesize',
          headers,
          payload: { catId: 'opus', text: '原路径由实际读取者处理。' },
        });
        assert.equal(response.statusCode, 200, response.body);
        if (streaming) {
          const chunk = response.body
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)))
            .find((event) => event.type === 'chunk');
          assert.equal(chunk.voiceSelection.referenceStatus, expectedStatus);
          assert.equal(chunk.voiceSelection.warnings.length > 0, receiptMode !== 'valid');
          assert.equal(Buffer.from(chunk.audioBase64, 'base64').toString(), expectedVoice);
        } else {
          const result = response.json();
          assert.equal(
            result.voiceSelection.referenceStatus,
            receiptMode === 'valid' && i === 1 ? 'verified_cache' : expectedStatus,
          );
          assert.equal(result.voiceSelection.warnings.length > 0, receiptMode !== 'valid');
          assert.equal(result.cached, receiptMode === 'valid' && i === 1);
          outputs.push(result.assetId);
          assert.equal((await app.inject({ url: result.audioUrl, headers })).rawPayload.toString(), expectedVoice);
        }
      }
      assert.equal(
        speechCalls,
        !streaming && receiptMode === 'valid' ? 1 : 2,
        'only confirmed current content may reuse an asset',
      );
      if (!streaming && receiptMode === 'valid') assert.equal(outputs[0], outputs[1]);
      else if (!streaming)
        assert.notEqual(outputs[0], outputs[1], 'unknown historical assets must never be overwritten');
      assert.equal(
        (await readdir(join(f.root, 'cache'))).some((name) => name.startsWith('.references')),
        false,
        'the API must not create persistent copies of private reference inputs',
      );
    });
  }
}

for (const confirmed of [true, false]) {
  test(`native listen stream consumes ${confirmed ? 'confirmed' : 'missing'} reader receipt before its first chunk`, async (t) => {
    const f = await fixture(true);
    await f.app.close();
    const previous = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = previous;
    });
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/health'))
        return Response.json({
          status: 'ok',
          backend: 'qwen3-clone',
          model: 'mlx-community/Breeze-TTS-2-mlx',
          capabilities: ['speech-stream-route-v1', 'reference-audio-content-v1'],
        });
      assert.ok(String(url).endsWith('/stream'));
      const input = JSON.parse(String(init?.body));
      assert.ok(input.ref_audio_base64);
      const audio = Buffer.from('NATIVE_SELECTED_VOICE').toString('base64');
      return new Response(
        `${JSON.stringify({ type: 'chunk', final: true, audio_base64: audio })}\n${JSON.stringify({ type: 'final', audio_base64: audio })}\n`,
        {
          headers: confirmed
            ? { 'x-tts-reference-status': 'used', 'x-tts-reference-sha256': input.ref_audio_sha256 }
            : {},
        },
      );
    };
    const registry = new TtsRegistry();
    registry.register(
      new MlxAudioTtsProvider({ baseUrl: 'http://127.0.0.1:19889', model: 'mlx-community/Breeze-TTS-2-mlx' }),
    );
    const assets = new ListenAssetService(registry, join(f.root, 'cache'));
    t.after(() => assets.close());
    let chunks = 0;
    const asset = await assets.getOrCreate('原生流的确认必须先于播放。', {
      synthesis: { catId: 'opus' },
      onChunk: (event) => {
        chunks++;
        assert.equal(event.voiceSelection?.referenceStatus, confirmed ? 'sent' : 'unverified');
        assert.equal(!!event.voiceSelection?.warnings.length, !confirmed);
      },
    });
    assert.equal(chunks, 1);
    assert.equal(asset.reusable, confirmed);
    assert.equal(asset.voiceSelection?.referenceStatus, confirmed ? 'sent' : 'unverified');
  });
}

for (const kind of ['unconfigured', 'missing-transcript', 'edge-tts', 'mlx-audio']) {
  test(`listen fallback ${kind} uses ordinary speech instead of a clone-only stream`, async (t) => {
    const f = await fixture(true);
    await f.app.close();
    const oldFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = oldFetch;
    });
    const clone = kind === 'unconfigured' || kind === 'missing-transcript';
    const model = clone
      ? 'mlx-community/Breeze-TTS-2-mlx'
      : kind === 'edge-tts'
        ? 'edge-tts'
        : 'mlx-community/Kokoro-82M-bf16';
    if (kind === 'missing-transcript') {
      f.template.breeds[0].variants[0].voiceConfig.refText = undefined;
      await (await import('node:fs/promises')).writeFile(f.templatePath, JSON.stringify(f.template));
      (await import('../src/config/cat-voices.js')).clearVoiceCache();
    }
    const endpoints: string[] = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/health'))
        return Response.json({
          status: 'ok',
          model,
          backend: clone ? 'qwen3-clone' : kind,
          capabilities: ['speech-stream-route-v1', ...(clone ? ['reference-audio-content-v1'] : [])],
        });
      endpoints.push(new URL(String(url)).pathname);
      if (String(url).endsWith('/stream'))
        return new Response('ref_audio and ref_text are required for clone streaming', { status: clone ? 400 : 409 });
      const request = JSON.parse(String(init?.body));
      assert.equal(request.ref_audio, undefined);
      return new Response('RIFF-fallback-audio', { headers: { 'x-audio-format': 'wav' } });
    };
    const registry = new TtsRegistry();
    registry.register(new MlxAudioTtsProvider({ baseUrl: 'http://127.0.0.1:19889', model }));
    const assets = new ListenAssetService(registry, join(f.root, 'cache'));
    t.after(() => assets.close());
    const asset = await assets.getOrCreate('新猫或降级也应该能听。', {
      synthesis: { catId: kind === 'unconfigured' ? 'new-member' : 'opus' },
    });
    assert.deepEqual(endpoints, ['/v1/audio/speech']);
    assert.ok(asset.voiceSelection?.warnings.length);
    if (kind === 'missing-transcript') assert.equal(asset.voiceSelection?.referenceStatus, 'unavailable');
  });
}
