import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCatVoice } from '../src/config/cat-voices.js';
import { StreamingTtsChunker } from '../src/domains/cats/services/tts/StreamingTtsChunker.js';
import { VoiceBlockSynthesizer } from '../src/domains/cats/services/tts/VoiceBlockSynthesizer.js';
import { fixture } from './helpers/voice-selection-fixture.js';

type VoiceFixture = Awaited<ReturnType<typeof fixture>>;
type Entrance = 'export' | 'listen' | 'voice-block';
const headers = { 'x-cat-cafe-user': 'voice-test' };

async function invoke(f: VoiceFixture, entrance: Entrance, text = '排队时参考声音也不能换人。') {
  if (entrance === 'voice-block')
    return new VoiceBlockSynthesizer(f.registry, join(f.root, 'cache')).resynthesize(text, 'opus');
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/tts/synthesize',
    headers,
    payload: { catId: 'opus', text, ...(entrance === 'listen' ? { purpose: 'listen' } : {}) },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

for (const entrance of ['export', 'listen', 'voice-block'] as const) {
  test(
    `${entrance} preserves authorized reference bytes and publishes independent assets`,
    { timeout: 10000 },
    async () => {
      const f = await fixture(true);
      const source = resolveCatVoice('opus').config.refAudio;
      assert.ok(source);
      await writeFile(source, 'REFERENCE_A');
      let entered!: () => void;
      let release!: () => void;
      const queued = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      f.registry.getDefault().synthesize = async (request) => {
        calls++;
        assert.ok(request.refAudioData);
        const captured = Buffer.from(request.refAudioData.base64, 'base64');
        entered();
        await released;
        assert.ok(request.refAudio);
        return {
          audio: captured,
          referenceAudio: { status: 'used', sha256: createHash('sha256').update(captured).digest('hex') },
          format: 'wav',
          metadata: { provider: 'fixture', model: 'fixture-model', voice: request.voice },
        };
      };
      const pending = invoke(f, entrance);
      try {
        await Promise.race([
          queued,
          pending.then(() => {
            throw new Error('provider did not queue');
          }),
        ]);
        await writeFile(source, 'REFERENCE_B');
        release();
        const first = await pending;
        const audio = await f.app.inject({ url: first.audioUrl, headers });
        assert.equal(
          audio.rawPayload.toString(),
          'REFERENCE_A',
          'queued provider must read the same captured bytes as the cache key',
        );
        assert.equal(first.voiceSelection.effective.refAudio, source);
        await writeFile(source, 'REFERENCE_A');
        const replay = await invoke(f, entrance);
        assert.equal(replay.audioUrl, first.audioUrl);
        assert.equal(replay.voiceSelection.referenceStatus, 'verified_cache');
        assert.equal(calls, 1);
        await writeFile(source, 'REFERENCE_B');
        const changed = await invoke(f, entrance);
        assert.notEqual(changed.audioUrl, first.audioUrl);
        assert.equal((await f.app.inject({ url: changed.audioUrl, headers })).rawPayload.toString(), 'REFERENCE_B');
        assert.equal(calls, 2);
      } finally {
        release();
        await pending.catch(() => undefined);
        await f.app.close();
      }
    },
  );

  for (const reason of ['unreadable', 'empty']) {
    test(`${entrance} marks ${reason} references unavailable and continues explicit nonclone speech`, async () => {
      const f = await fixture(true, false);
      const source = resolveCatVoice('opus').config.refAudio;
      assert.ok(source);
      if (reason === 'unreadable') await chmod(source, 0);
      else await writeFile(source, '');
      try {
        if (reason === 'unreadable') await assert.rejects(access(source, constants.R_OK), { code: 'EACCES' });
        const voices = (await f.app.inject({ url: '/api/tts/voices', headers })).json().voices;
        const result = await invoke(f, entrance);
        assert.equal(
          voices.find((v: { sourceCatId: string }) => v.sourceCatId === 'opus').referenceAvailability,
          'unknown',
        );
        assert.equal(voices.find((v: { sourceCatId: string }) => v.sourceCatId === 'opus').available, true);
        assert.equal(result.voiceSelection.referenceStatus, 'unavailable');
        assert.equal(result.voiceSelection.effective.refAudio, undefined);
        assert.match(result.voiceSelection.warnings.join(' '), /参考音频/);
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].refAudio, undefined);
        assert.equal(f.requests[0].refText, undefined);
      } finally {
        await chmod(source, 0o600);
        await f.app.close();
      }
    });
  }
}

test('a live turn uses one captured reference across queued chunks after the original is replaced', async () => {
  const f = await fixture(true);
  const source = resolveCatVoice('opus').config.refAudio;
  assert.ok(source);
  await writeFile(source, 'REFERENCE_A');
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const heard: string[] = [];
  f.registry.getDefault().synthesize = async (request) => {
    assert.ok(request.refAudioData);
    const audio = Buffer.from(request.refAudioData.base64, 'base64');
    entered();
    await waiting;
    assert.ok(request.refAudio);
    heard.push(audio.toString());
    return {
      audio,
      format: 'wav',
      referenceAudio: { status: 'used', sha256: createHash('sha256').update(audio).digest('hex') },
      metadata: { provider: 'fixture', model: 'fixture-model', voice: request.voice },
    };
  };
  const chunker = new StreamingTtsChunker({
    catId: 'opus',
    invocationId: 'reference-queue',
    threadId: 'reference-queue',
    voiceResolution: resolveCatVoice('opus'),
    ttsRegistry: f.registry,
    broadcaster: { broadcastToRoom: () => {} },
  });
  try {
    chunker.feed('第一句。');
    await ready;
    await writeFile(source, 'REFERENCE_B');
    chunker.feed('第二句。');
    release();
    await chunker.flush();
    assert.deepEqual(heard, ['REFERENCE_A', 'REFERENCE_A']);
  } finally {
    release();
    await chunker.flush();
    await f.app.close();
  }
});
