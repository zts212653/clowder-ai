import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearVoiceCache, resolveCatVoice } from '../src/config/cat-voices.js';
import { StreamingTtsChunker } from '../src/domains/cats/services/tts/StreamingTtsChunker.js';
import { fixture } from './helpers/voice-selection-fixture.js';

test('live voice exposes the same missing-config and unsupported-reference decisions before playback', async () => {
  const { app, registry, requests } = await fixture(false, false);
  try {
    for (const catId of ['new-member', 'opus']) {
      const events: { event: string; data: unknown }[] = [];
      const chunker = new StreamingTtsChunker({
        catId,
        invocationId: 'live-voice-proof',
        threadId: 'voice-proof',
        voiceResolution: resolveCatVoice(catId),
        ttsRegistry: registry,
        broadcaster: { broadcastToRoom: (_room: string, event: string, data: unknown) => events.push({ event, data }) },
      });
      chunker.feed('本人声线不能静默换人。');
      await chunker.flush();
      const start = events.find((event) => event.event === 'voice_stream_start')?.data as {
        voiceSelection?: { catId: string; warnings: string[]; referenceStatus: string };
      };
      assert.ok(start.voiceSelection, 'live playback must carry the actual voice/fallback before its first chunk');
      assert.equal(start.voiceSelection.catId, catId);
      assert.ok(start.voiceSelection.warnings.length);
      assert.equal(start.voiceSelection.referenceStatus, catId === 'opus' ? 'unsupported' : 'not_requested');
      assert.equal(requests.at(-1)?.refAudio, undefined);
      assert.equal(requests.at(-1)?.refText, undefined);
    }
  } finally {
    await app.close();
  }
});

const headers = { 'x-cat-cafe-user': 'voice-test' };
test('a new member with its own breed ID keeps speaking and exposes the global fallback on fresh and cached exports', async () => {
  const { app, requests } = await fixture(true);
  try {
    for (const cached of [false, true]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/tts/synthesize',
        headers,
        payload: { catId: 'new-member', text: '这是本人的声音吗？' },
      });
      assert.equal(response.statusCode, 200);
      const result = response.json();
      assert.equal(result.cached, cached);
      assert.equal(result.voiceSelection?.source, 'global_default');
      assert.equal(result.voiceSelection.catId, 'new-member');
      assert.equal(result.voiceSelection.breedId, 'new-member');
      assert.ok(result.voiceSelection.warnings.length > 0);
      assert.equal(result.voiceSelection.effective.refAudio, undefined);
      const audio = await app.inject({ url: result.audioUrl, headers });
      assert.equal(audio.statusCode, 200);
      assert.equal(audio.rawPayload.toString(), 'RIFF-audio-fixture');
    }
    assert.equal(requests.length, 1);
  } finally {
    await app.close();
  }
});

test('inherited defaults, missing reference files and unknown provider capabilities are explicit', async () => {
  const { app, root, template, requests } = await fixture();
  try {
    const synthesize = async (catId: string, text: string) =>
      (await app.inject({ method: 'POST', url: '/api/tts/synthesize', headers, payload: { catId, text } })).json()
        .voiceSelection;
    const inherited = await synthesize('inherited-voice', '沿用品种默认。');
    assert.equal(inherited.source, 'breed_default');
    assert.equal(inherited.referenceStatus, 'unverified');
    assert.ok(inherited.warnings.length >= 2);
    const reference = join(root, template.breeds[0].variants[0].voiceConfig.refAudio);
    await rm(reference);
    const missing = await synthesize('opus', '参考音频已丢失。');
    assert.equal(missing.source, 'cat_config');
    assert.equal(missing.referenceStatus, 'unavailable');
    assert.equal(missing.effective.refAudio, undefined);
    assert.equal(requests.at(-1)?.refText, undefined);
    assert.ok(missing.warnings.length > 0);
  } finally {
    await app.close();
  }
});

test('voice choices use real cat IDs, expose portable configurations, and do not assign a voice by family', async () => {
  const { app } = await fixture(true);
  try {
    assert.equal((await app.inject({ url: '/api/tts/voices' })).statusCode, 401);
    const response = await app.inject({ url: '/api/tts/voices?catId=new-member', headers });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    const wanderer = result.voices.find((voice: { sourceCatId: string }) => voice.sourceCatId === 'opus');
    assert.ok(wanderer, 'opus-default is a template variant, not the member ID');
    assert.equal(wanderer.familyId, 'ragdoll');
    assert.equal(wanderer.voiceConfig.refAudio, 'genshin/流浪者/vo_wanderer_dialog_greetingMorning.wav');
    assert.equal(wanderer.available, true);
    assert.equal(result.resolution.source, 'global_default');
  } finally {
    await app.close();
  }
});

test('configured reference parameters and provenance match the actual export, including listen assets', async () => {
  const { app, requests } = await fixture(true);
  try {
    for (const purpose of [undefined, 'listen']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/tts/synthesize',
        headers,
        payload: { catId: 'opus', text: '我选了流浪者。', purpose },
      });
      assert.equal(response.statusCode, 200);
      const selection = response.json().voiceSelection;
      assert.equal(selection?.source, 'cat_config');
      assert.equal(selection.referenceStatus, 'sent');
      assert.equal(selection.effective.refAudio, requests.at(-1)?.refAudio);
      assert.equal(selection.effective.refText, requests.at(-1)?.refText);
      assert.equal(selection.provider, 'fixture');
      assert.deepEqual(selection.warnings, []);
    }
  } finally {
    await app.close();
  }
});

test('a provider that cannot clone reports and omits reference parameters without blocking speech', async () => {
  const { app, requests } = await fixture(false);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers,
      payload: { catId: 'opus', text: '降级也要讲清楚。' },
    });
    assert.equal(response.statusCode, 200);
    const selection = response.json().voiceSelection;
    assert.equal(selection?.referenceStatus, 'unsupported');
    assert.match(selection.requested.refAudio, /流浪者/);
    assert.equal(selection.effective.refAudio, undefined);
    assert.equal(requests[0].refAudio, undefined);
    assert.ok(selection.warnings.length > 0);
  } finally {
    await app.close();
  }
});

test('a member saves its chosen candidate through the existing revision contract, reloads it and exports with its own ID', async () => {
  const { app, root, template, requests } = await fixture(true);
  await mkdir(join(root, '.cat-cafe'), { recursive: true });
  await writeFile(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(template));
  const { catsRoutes } = await import('../src/routes/cats.js');
  await app.register(catsRoutes);
  const ownHeaders = { 'x-cat-cafe-user': 'new-member' };
  try {
    const before = (await app.inject({ url: '/api/cats', headers: ownHeaders })).json().cats;
    const member = before.find((cat: { id: string }) => cat.id === 'new-member');
    const other = before.find((cat: { id: string }) => cat.id === 'opus');
    const choices = (await app.inject({ url: '/api/tts/voices', headers: ownHeaders })).json().voices;
    const chosen = choices.find((voice: { sourceCatId: string }) => voice.sourceCatId === 'opus');
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/cats/new-member',
      headers: ownHeaders,
      payload: { voiceConfig: chosen.voiceConfig, expectedRevision: member.configurationRevision },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().updatedBy, 'new-member');
    const stale = await app.inject({
      method: 'PATCH',
      url: '/api/cats/new-member',
      headers: ownHeaders,
      payload: { voiceConfig: null, expectedRevision: member.configurationRevision },
    });
    assert.equal(stale.statusCode, 409);
    clearVoiceCache();
    const after = (await app.inject({ url: '/api/cats', headers: ownHeaders })).json().cats;
    assert.deepEqual(after.find((cat: { id: string }) => cat.id === 'new-member').voiceConfig, chosen.voiceConfig);
    assert.deepEqual(after.find((cat: { id: string }) => cat.id === 'opus').voiceConfig, other.voiceConfig);
    const result = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: ownHeaders,
      payload: { catId: 'new-member', text: '这是我自己选的声线。' },
    });
    assert.equal(result.statusCode, 200, result.body);
    const audio = result.json();
    assert.equal(audio.voiceSelection.catId, 'new-member');
    assert.equal(audio.voiceSelection.source, 'cat_config');
    assert.equal(audio.voiceSelection.referenceStatus, 'sent');
    assert.equal(audio.voiceSelection.effective.refAudio, requests.at(-1)?.refAudio);
    assert.equal(
      (await app.inject({ url: audio.audioUrl, headers: ownHeaders })).rawPayload.toString(),
      'RIFF-audio-fixture',
    );
  } finally {
    await app.close();
  }
});

for (const cloned of [false, true]) {
  test(`a shared listen flight keeps each caller identity and notices (clone=${cloned})`, async () => {
    const f = await fixture(cloned);
    const { app, requests } = f;
    if (cloned) {
      f.template.breeds.at(-1).variants[0].voiceConfig = structuredClone(f.template.breeds[0].variants[0].voiceConfig);
      await writeFile(f.templatePath, JSON.stringify(f.template));
      clearVoiceCache();
    }
    try {
      const results = await Promise.all(
        ['opus', 'new-member'].map(async (catId) =>
          (
            await app.inject({
              method: 'POST',
              url: '/api/tts/synthesize',
              headers,
              payload: { catId, text: '共享音频不串身份。', purpose: 'listen' },
            })
          ).json(),
        ),
      );
      assert.equal(results[0].assetId, results[1].assetId);
      assert.equal(requests.length, 1);
      assert.equal(results[0].voiceSelection.catId, 'opus');
      assert.equal(results[0].voiceSelection.referenceStatus, cloned ? 'sent' : 'unsupported');
      assert.equal(results[1].voiceSelection.catId, 'new-member');
      assert.equal(results[1].voiceSelection.source, cloned ? 'cat_config' : 'global_default');
    } finally {
      await app.close();
    }
  });
}

test('a configured preset ID does not masquerade as a chosen voice when the actual adapter ignores voice IDs', async () => {
  const { app, template, templatePath, requests } = await fixture(true, false);
  template.breeds.at(-1).variants[0].voiceConfig = { voice: 'chosen-preset', langCode: 'zh' };
  await writeFile(templatePath, JSON.stringify(template));
  clearVoiceCache();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers,
      payload: { catId: 'new-member', text: '配了声音ID也要知道它是否生效。' },
    });
    assert.equal(response.statusCode, 200);
    const selection = response.json().voiceSelection;
    assert.equal(selection.source, 'cat_config');
    assert.equal(selection.referenceStatus, 'not_requested');
    assert.ok(selection.warnings.some((warning: string) => warning.includes('不按声音 ID 选音色')));
    assert.equal(requests[0].voice, 'chosen-preset');
  } finally {
    await app.close();
  }
});

test('confirmed voice-cache identities distinguish complete parameter tuples containing separators', async () => {
  const f = await fixture(true, false);
  try {
    for (const [voice, text] of [
      ['v', 'x|zh|1|wav|hello'],
      ['v|zh|1|wav|x', 'hello'],
    ]) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/tts/synthesize',
        headers,
        payload: { catId: 'opus', voice, langCode: 'zh', text },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().cached, false, 'different text/voice tuples cannot reuse the same audio');
    }
    assert.equal(f.requests.length, 2);
  } finally {
    await f.app.close();
  }
});
