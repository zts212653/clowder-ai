import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { resolveCatVoice } from '../src/config/cat-voices.js';
import { MlxAudioTtsProvider } from '../src/domains/cats/services/tts/MlxAudioTtsProvider.js';
import { TtsRegistry } from '../src/domains/cats/services/tts/TtsRegistry.js';
import { setServiceConfig } from '../src/domains/services/service-config.js';
import { ttsRoutes } from '../src/routes/tts.js';
import { fixture } from './helpers/voice-selection-fixture.js';

function pcmFixture() {
  const audio = Buffer.alloc(52);
  audio.write('RIFF');
  audio.writeUInt32LE(44, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(8, 40);
  return audio;
}

for (const kind of ['mlx-audio', 'qwen3-clone', 'confirmed-qwen']) {
  const confirmed = kind === 'confirmed-qwen';
  const backend = confirmed ? 'qwen3-clone' : kind;
  test(`${kind} reuses only proved current content offline and preserves historical playback`, async (t) => {
    const { app: unused, root } = await fixture(true);
    await unused.close();
    const priorFetch = globalThis.fetch;
    const keys = ['CAT_CAFE_SERVICES_CONFIG', 'TTS_URL', 'TTS_MODEL'] as const;
    const prior = new Map(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
      globalThis.fetch = priorFetch;
      for (const key of keys) {
        const value = prior.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const model = backend === 'mlx-audio' ? 'mlx-community/Kokoro-82M-bf16' : 'mlx-community/Breeze-TTS-2-mlx';
    const endpoint = 'http://127.0.0.1:19889';
    const cacheDir = join(root, 'cache');
    await mkdir(cacheDir, { recursive: true });
    if (backend === 'mlx-audio') {
      // Exercise an existing identity database, rather than only a fresh schema.
      const db = new Database(join(cacheDir, '.tts-identities.sqlite'));
      db.exec(
        'CREATE TABLE endpoint_identity (endpoint_key TEXT PRIMARY KEY, model TEXT NOT NULL, generation_profile TEXT, revision TEXT NOT NULL, ambiguous INTEGER NOT NULL)',
      );
      db.prepare('INSERT INTO endpoint_identity VALUES (?, ?, NULL, ?, 0)').run(
        createHash('sha256').update(endpoint).digest('hex'),
        model,
        'legacy-receipt',
      );
      db.close();
    }
    process.env.CAT_CAFE_SERVICES_CONFIG = join(root, 'services.json');
    delete process.env.TTS_URL;
    delete process.env.TTS_MODEL;
    setServiceConfig('mlx-tts', { enabled: true, installed: true, selectedModel: model, port: 19889 });
    let offline = false;
    let speechCalls = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/health')) {
        if (offline) throw new TypeError('offline');
        return Response.json({
          status: 'ok',
          model,
          backend,
          capabilities: ['speech-stream-route-v1', ...(confirmed ? ['reference-audio-content-v1'] : [])],
        });
      }
      speechCalls++;
      if (offline) throw new Error('must not generate while offline');
      const input = JSON.parse(String(init?.body));
      return new Response(pcmFixture(), {
        headers: {
          'x-audio-format': 'wav',
          ...(confirmed ? { 'x-tts-reference-status': 'used', 'x-tts-reference-sha256': input.ref_audio_sha256 } : {}),
        },
      });
    };
    const createApp = async () => {
      const registry = new TtsRegistry();
      registry.register(new MlxAudioTtsProvider());
      const app = Fastify();
      await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir });
      t.after(() => app.close());
      return app;
    };
    const online = await createApp();
    const request = {
      method: 'POST' as const,
      url: '/api/tts/synthesize',
      headers: { 'x-cat-cafe-user': 'voice-test' },
      payload: { catId: 'opus', text: '离线后仍复用正确缓存。' },
    };
    const generated = await online.inject(request);
    assert.equal(generated.statusCode, 200, generated.body);
    assert.equal(speechCalls, 1);
    offline = true;
    const fresh = await createApp();
    const replay = await fresh.inject(request);
    if (backend === 'qwen3-clone' && !confirmed) {
      assert.equal(generated.json().voiceSelection.referenceStatus, 'unverified');
      assert.equal(replay.statusCode, 502, 'an offline path cannot establish the current reference version');
      assert.equal(
        (await fresh.inject({ url: generated.json().audioUrl, headers: request.headers })).statusCode,
        200,
        'historical files remain explicitly replayable',
      );
      assert.equal(speechCalls, 1);
      return;
    }
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().cached, true);
    assert.equal(replay.json().audioUrl, generated.json().audioUrl);
    assert.equal(
      replay.json().voiceSelection.referenceStatus,
      backend === 'mlx-audio' ? 'unsupported' : 'verified_cache',
    );
    assert.equal(speechCalls, 1);
    if (confirmed) {
      await writeFile(resolveCatVoice('opus').config.refAudio!, 'CHANGED_REFERENCE');
      const changed = await fresh.inject(request);
      assert.equal(changed.statusCode, 502, 'offline cache must not pretend A matches current B');
      assert.equal((await fresh.inject({ url: generated.json().audioUrl, headers: request.headers })).statusCode, 200);
    }
  });
}
