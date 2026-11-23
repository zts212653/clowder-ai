import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { CatVoiceOption, ITtsProvider, TtsSynthesizeRequest } from '@cat-cafe/shared';
import { clearVoiceCache, resolveCatVoice } from '../src/config/cat-voices.js';
import { LISTEN_AUDIO_CACHE_VERSION } from '../src/domains/cats/services/tts/listen-audio-postprocess.js';
import { VoiceBlockSynthesizer } from '../src/domains/cats/services/tts/VoiceBlockSynthesizer.js';
import { fixture } from './helpers/voice-selection-fixture.js';

const headers = { 'x-cat-cafe-user': 'voice-test' };

// Frozen pre-provenance on-disk format: the adapter could drop a missing reference
// after this request was hashed. Such audio cannot prove that reference was used.
function legacyHash(provider: ITtsProvider, request: TtsSynthesizeRequest, listen: boolean) {
  const parts = [
    provider.id,
    provider.cacheIdentity ?? provider.model,
    request.voice,
    request.langCode ?? 'z',
    String(request.speed ?? 1),
    request.format ?? 'wav',
    request.text,
  ];
  if (request.refAudio) parts.push(request.refAudio);
  if (request.refText) parts.push(request.refText);
  if (request.instruct) parts.push(request.instruct);
  if (request.temperature != null) parts.push(String(request.temperature));
  const hash = createHash('sha256').update(parts.join('|')).digest('hex');
  return listen ? createHash('sha256').update(`${hash}\0variant:${LISTEN_AUDIO_CACHE_VERSION}`).digest('hex') : hash;
}

for (const entrance of ['export', 'listen', 'voice-block'] as const) {
  test(`${entrance} does not relabel a legacy default-voice cache as a verified reference after the file returns`, async () => {
    const { app, root, registry, requests } = await fixture(true);
    try {
      const voice = resolveCatVoice('opus').config;
      assert.ok(voice.refAudio);
      const original = await readFile(voice.refAudio);
      const request = { ...voice, text: '参考文件回来了。', format: 'wav', speed: voice.speed ?? 1 };
      const cacheDir = join(root, 'cache');
      await mkdir(cacheDir, { recursive: true });
      await rm(voice.refAudio);
      await writeFile(
        join(cacheDir, `${legacyHash(registry.getDefault(), request, entrance === 'listen')}.wav`),
        'LEGACY_DEFAULT_VOICE',
      );
      await writeFile(voice.refAudio, original);
      let audioUrl: string;
      if (entrance === 'voice-block') {
        audioUrl = (await new VoiceBlockSynthesizer(registry, cacheDir).resynthesize(request.text, 'opus')).audioUrl;
      } else {
        const response = await app.inject({
          method: 'POST',
          url: '/api/tts/synthesize',
          headers,
          payload: { text: request.text, catId: 'opus', ...(entrance === 'listen' ? { purpose: 'listen' } : {}) },
        });
        assert.equal(response.statusCode, 200, response.body);
        audioUrl = response.json().audioUrl;
        assert.equal(response.json().cached, false);
      }
      assert.equal(requests.length, 1, 'unproven legacy reference audio must be regenerated');
      assert.ok(requests[0].refAudio);
      assert.equal(requests[0].refAudio, voice.refAudio);
      assert.ok(requests[0].refAudioData);
      assert.deepEqual(Buffer.from(requests[0].refAudioData.base64, 'base64'), original);
      const audio = await app.inject({ url: audioUrl, headers });
      assert.notEqual(audio.rawPayload.toString(), 'LEGACY_DEFAULT_VOICE');
    } finally {
      await app.close();
    }
  });
}

test('a changed reference file produces a different asset even when its path and saved settings are unchanged', async () => {
  const { app, requests } = await fixture(true);
  try {
    const payload = { text: '同一个路径的新声线。', catId: 'opus' };
    const first = await app.inject({ method: 'POST', url: '/api/tts/synthesize', headers, payload });
    const reference = resolveCatVoice('opus').config.refAudio;
    assert.ok(reference);
    await writeFile(reference, 'different-reference-audio');
    const second = await app.inject({ method: 'POST', url: '/api/tts/synthesize', headers, payload });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.notEqual(first.json().audioUrl, second.json().audioUrl);
    assert.equal(requests.length, 2);
  } finally {
    await app.close();
  }
});

test('runtime and template variants with different voices remain uniquely selectable and save the chosen configuration', async () => {
  const { app, root, template } = await fixture(true);
  const runtime = structuredClone(template);
  const alternate = template.breeds.find((breed: { id: string }) => breed.id === 'maine-coon').variants[0].voiceConfig;
  runtime.breeds[0].variants[0].voiceConfig = alternate;
  const reference = join(root, alternate.refAudio);
  await mkdir(dirname(reference), { recursive: true });
  await writeFile(reference, 'alternate-reference');
  await mkdir(join(root, '.cat-cafe'), { recursive: true });
  await writeFile(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(runtime));
  clearVoiceCache();
  const { catsRoutes } = await import('../src/routes/cats.js');
  await app.register(catsRoutes);
  try {
    const choices: CatVoiceOption[] = (await app.inject({ url: '/api/tts/voices', headers })).json().voices;
    assert.equal(
      new Set(choices.map((choice) => choice.id)).size,
      choices.length,
      'every rendered option must have a unique selectable value',
    );
    const original = choices.find(
      (choice) =>
        choice.familyId === 'ragdoll' &&
        choice.voiceConfig.refAudio === template.breeds[0].variants[0].voiceConfig.refAudio,
    );
    const edited = choices.find(
      (choice) => choice.familyId === 'ragdoll' && choice.voiceConfig.refAudio === alternate.refAudio,
    );
    assert.ok(original?.available && edited?.available);
    assert.notEqual(original.id, edited.id);
    const cats = (await app.inject({ url: '/api/cats', headers })).json().cats;
    const member = cats.find((cat: { id: string }) => cat.id === 'opus');
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/cats/opus',
      headers,
      payload: {
        voiceConfig: choices.find((choice) => choice.id === original.id)?.voiceConfig,
        expectedRevision: member.configurationRevision,
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const reloaded = (await app.inject({ url: '/api/cats', headers })).json().cats;
    assert.deepEqual(reloaded.find((cat: { id: string }) => cat.id === 'opus').voiceConfig, original.voiceConfig);
  } finally {
    await app.close();
  }
});
