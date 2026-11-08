import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { DocumentCacheRunManager } from '../dist/domains/cats/services/tts/DocumentCacheRunManager.js';
import { ListenAssetService } from '../dist/domains/cats/services/tts/ListenAssetService.js';
import { MlxAudioTtsProvider } from '../dist/domains/cats/services/tts/MlxAudioTtsProvider.js';
import { TtsRegistry } from '../dist/domains/cats/services/tts/TtsRegistry.js';
import { VoiceBlockSynthesizer } from '../dist/domains/cats/services/tts/VoiceBlockSynthesizer.js';
import { setServiceConfig } from '../dist/domains/services/service-config.js';
import { ttsRoutes } from '../dist/routes/tts.js';

const breeze = 'mlx-community/Breeze-TTS-2-mlx';
const qwen = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';
const kokoro = 'mlx-community/Kokoro-82M-bf16';
const originalFetch = globalThis.fetch;
const originalConfig = process.env.CAT_CAFE_SERVICES_CONFIG;
const originalUrl = process.env.TTS_URL;
const originalModel = process.env.TTS_MODEL;
const roots = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [
    ['CAT_CAFE_SERVICES_CONFIG', originalConfig],
    ['TTS_URL', originalUrl],
    ['TTS_MODEL', originalModel],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(onSpeech = () => {}, protocol = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tts-model-snapshot-'));
  roots.push(root);
  process.env.CAT_CAFE_SERVICES_CONFIG = join(root, 'services.json');
  delete process.env.TTS_URL;
  setServiceConfig('mlx-tts', { enabled: true, installed: true, selectedModel: breeze, port: 19889 });
  const registry = new TtsRegistry();
  registry.register(new MlxAudioTtsProvider());
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const model = protocol.sameModel ?? (new URL(url).port === '19889' ? breeze : qwen);
    if (protocol.offline && String(url).endsWith('/health')) throw new TypeError('fetch failed: offline');
    if (String(url).endsWith('/health'))
      return Response.json({
        status: 'ok',
        model,
        backend: protocol.backend ?? 'qwen3-clone',
        capabilities: ['speech-stream-route-v1'],
        ...(protocol.profile ? { generation_profile: protocol.profile } : {}),
      });
    const body = JSON.parse(String(init.body));
    posts.push({ url: String(url), model: body.model });
    if (protocol.offline) throw new TypeError('speech attempted while offline');
    onSpeech(posts.length);
    if (protocol.profile && body.generation_profile !== undefined && body.generation_profile !== protocol.profile) {
      return new Response('generation profile changed', { status: 409 });
    }
    const headers = protocol.profile ? { 'x-tts-generation-profile': protocol.profile } : {};
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
    audio.writeInt16LE(protocol.profile ? 12000 : 8000, 44);
    if (String(url).endsWith('/stream'))
      return new Response(`${JSON.stringify({ type: 'final', audio_base64: audio.toString('base64') })}\n`, {
        headers,
      });
    return new Response(audio, { headers: { ...headers, 'x-audio-format': 'wav' } });
  };
  return { root, registry, posts };
}

test('listen cache probe and generation keep one model and endpoint when configuration changes during I/O', async () => {
  const { root, registry, posts } = fixture();
  const assets = new ListenAssetService(registry, root);
  try {
    const pending = assets.getOrCreate('缓存探测期间切换配置。');
    setServiceConfig('mlx-tts', { selectedModel: qwen, port: 19890 });
    const first = await pending;
    assert.equal(posts.length, 1);
    assert.equal(posts[0].model, breeze);
    assert.match(posts[0].url, /:19889\//);
    setServiceConfig('mlx-tts', { selectedModel: breeze, port: 19889 });
    const cached = await assets.getOrCreate('缓存探测期间切换配置。');
    assert.equal(cached.cached, true);
    assert.equal(cached.assetId, first.assetId);
    assert.equal(posts.length, 1);
  } finally {
    await assets.close();
  }
});

test('a multi-part voice block keeps one identity when settings change after the first segment', async () => {
  const { root, registry, posts } = fixture((n) => {
    if (n === 1) setServiceConfig('mlx-tts', { selectedModel: qwen, port: 19890 });
  });
  await new VoiceBlockSynthesizer(registry, root).resynthesize('这是一段足够长的配置切换验证。'.repeat(130), 'opus');
  assert.ok(posts.length > 1, 'exercise actual segmentation');
  assert.deepEqual([...new Set(posts.map((p) => p.model))], [breeze]);
  assert.ok(posts.every((p) => p.url.includes(':19889/')));
});

test('a document cache job keeps its prepared identity for every sentence', async () => {
  const { root, registry, posts } = fixture((n) => {
    if (n === 1) setServiceConfig('mlx-tts', { selectedModel: qwen, port: 19890 });
  });
  const assets = new ListenAssetService(registry, root);
  const synthesis = await assets.prepareSynthesis({ catId: 'opus' });
  const state = {
    identity: { contentDigest: 'document-v1' },
    synthesisFingerprint: synthesis.fingerprint,
    sentences: [{ anchor: 'a' }, { anchor: 'b' }],
  };
  const repository = {
    prepareCacheRun() {},
    loadDocument: () => state,
    setSentenceAssetIfCurrent(_key, input) {
      assert.equal(input.synthesisFingerprint, synthesis.fingerprint);
      state.sentences.find((s) => s.anchor === input.anchor).assetId = input.assetId;
      return true;
    },
  };
  const manager = new DocumentCacheRunManager(repository, assets);
  const key = { userId: 'fixture-user', projectPath: '/fixture', relativePath: 'note.md' };
  try {
    manager.start({
      key,
      identity: state.identity,
      synthesis,
      sentences: [
        { anchor: 'a', text: '第一句配置切换。' },
        { anchor: 'b', text: '第二句保持声线。' },
      ],
    });
    const deadline = Date.now() + 5000;
    while (manager.status(key, state).active && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal(manager.status(key, state).active, false);
    assert.equal(posts.length, 2);
    assert.ok(posts.every((p) => p.model === breeze && p.url.includes(':19889/')));
    assert.ok(state.sentences.every((s) => s.assetId));
  } finally {
    manager.close();
    await assets.close();
  }
});

test('an endpoint override running a different model is rejected before synthesis', async () => {
  const { registry, posts } = fixture();
  process.env.TTS_URL = 'http://127.0.0.1:19890';
  await assert.rejects(registry.getDefault().synthesize({ text: '模型身份冲突', voice: 'S0' }), /model|selected/i);
  assert.equal(posts.length, 0);
});

test('the cache identity distinguishes endpoints and a provider snapshot stays immutable', async () => {
  const { registry } = fixture(() => {}, { sameModel: breeze });
  const first = await registry.getDefault().snapshot();
  const identity = first.cacheIdentity;
  setServiceConfig('mlx-tts', { port: 19890 });
  const second = await registry.getDefault().snapshot();
  assert.notEqual(identity, second.cacheIdentity);
  assert.equal(first.cacheIdentity, identity);
  assert.equal(first.model, breeze);
});

const policy = 'breeze-repetition-1.06-v1';
for (const kind of ['sentence', 'static']) {
  test(`${kind} cache follows the live generation policy across same-model upgrade`, async () => {
    const protocol = {};
    const { root, registry, posts } = fixture(() => {}, protocol);
    const assets = new ListenAssetService(registry, root);
    const synth = new VoiceBlockSynthesizer(registry, root);
    const get = () =>
      kind === 'sentence' ? assets.getOrCreate('这句话必须读完整。') : synth.resynthesize('这句话必须读完整。', 'opus');
    try {
      const old = await get();
      protocol.profile = policy;
      const upgraded = await get();
      if (kind === 'sentence') assert.equal(upgraded.cached, false);
      assert.notEqual(upgraded.audioUrl, old.audioUrl);
      const reused = await get();
      if (kind === 'sentence') assert.equal(reused.cached, true);
      assert.equal(reused.audioUrl, upgraded.audioUrl);
      assert.equal(posts.length, 2);
      protocol.profile = undefined;
      assert.equal((await get()).audioUrl, old.audioUrl, 'legacy audio remains available in its namespace');
    } finally {
      await assets.close();
    }
  });
  for (const direction of ['old-to-new', 'new-to-old']) {
    test(`${kind} rejects ${direction} swap after health before speech POST`, async () => {
      const protocol = { profile: direction === 'new-to-old' ? policy : undefined };
      const { root, registry } = fixture(() => {
        protocol.profile = direction === 'new-to-old' ? undefined : policy;
      }, protocol);
      const assets = new ListenAssetService(registry, root);
      try {
        const pending =
          kind === 'sentence'
            ? assets.getOrCreate('不能写错缓存。')
            : new VoiceBlockSynthesizer(registry, root).resynthesize('不能写错缓存。', 'opus');
        await assert.rejects(pending, /generation profile/i);
      } finally {
        await assets.close();
      }
    });
  }
}
test('prepared document synthesis keeps its policy and rejects mixed-generation sentences', async () => {
  const protocol = {};
  const { root, registry } = fixture(() => {}, protocol);
  const assets = new ListenAssetService(registry, root);
  try {
    const old = await assets.prepareSynthesis();
    await assets.getOrCreate('第一句。', { preparedSynthesis: old });
    protocol.profile = policy;
    await assert.rejects(assets.getOrCreate('第二句。', { preparedSynthesis: old }), /generation profile/i);
    const next = await assets.prepareSynthesis();
    assert.notEqual(next.fingerprint, old.fingerprint);
    await assets.getOrCreate('第二句。', { preparedSynthesis: next });
  } finally {
    await assets.close();
  }
});
test('legacy Qwen retains its original cache identity without a generation profile', async () => {
  const { registry } = fixture();
  setServiceConfig('mlx-tts', { selectedModel: qwen, port: 19890 });
  const snapshot = await registry.getDefault().snapshot();
  assert.equal(snapshot.cacheIdentity, JSON.stringify(['http://127.0.0.1:19890', qwen]));
  assert.equal((await snapshot.synthesize({ text: '保持兼容。', voice: 'S0' })).format, 'wav');
});

test('document cache run cannot publish a second sentence from a replacement generation policy', async () => {
  const protocol = {};
  const { root, registry, posts } = fixture(() => {}, protocol);
  const assets = new ListenAssetService(registry, root);
  const synthesis = await assets.prepareSynthesis();
  const state = {
    identity: { contentDigest: 'same-document' },
    synthesisFingerprint: synthesis.fingerprint,
    sentences: [{ anchor: 'a' }, { anchor: 'b' }],
  };
  const repository = {
    prepareCacheRun() {},
    loadDocument: () => state,
    setSentenceAssetIfCurrent(_key, input) {
      assert.equal(input.synthesisFingerprint, state.synthesisFingerprint);
      state.sentences.find((s) => s.anchor === input.anchor).assetId = input.assetId;
      protocol.profile = policy;
      return true;
    },
  };
  const manager = new DocumentCacheRunManager(repository, assets);
  const key = { userId: 'fixture-user', projectPath: '/fixture', relativePath: 'note.md' };
  try {
    manager.start({
      key,
      identity: state.identity,
      synthesis,
      sentences: [
        { anchor: 'a', text: '首句。' },
        { anchor: 'b', text: '次句。' },
      ],
    });
    const deadline = Date.now() + 5000;
    while (manager.status(key, state).active && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal(manager.status(key, state).active, false);
    assert.equal(posts.length, 1, 'new policy is rejected before generating the next sentence');
    assert.ok(state.sentences[0].assetId);
    assert.equal(state.sentences[1].assetId, undefined);
    const next = await assets.prepareSynthesis();
    assert.notEqual(next.fingerprint, state.synthesisFingerprint);
  } finally {
    manager.close();
    await assets.close();
  }
});

for (const selected of [qwen, breeze, kokoro]) {
  test(`real listen/static entrances reuse ${selected} caches offline after provider restart`, async () => {
    const protocol = {
      profile: selected === breeze ? policy : undefined,
      ...(selected === kokoro ? { sameModel: selected, backend: 'mlx-audio' } : {}),
    };
    const { root, registry, posts } = fixture(() => {}, protocol);
    if (selected !== breeze)
      setServiceConfig('mlx-tts', { selectedModel: selected, port: selected === qwen ? 19890 : 19889 });
    let app = Fastify();
    await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: root });
    const headers = { 'x-cat-cafe-user': 'operator' };
    const streamRequest = {
      method: 'POST',
      url: '/api/tts/listen/stream',
      headers,
      payload: { text: '离线也要能够播放。' },
    };
    const staticRequest = { ...streamRequest, url: '/api/tts/synthesize', payload: { text: '已生成的静态配音。' } };
    const events = (body) =>
      body
        .split('\n\n')
        .filter((x) => x.startsWith('data: '))
        .map((x) => JSON.parse(x.slice(6)));
    try {
      const first = await app.inject(streamRequest);
      assert.equal(first.statusCode, 200);
      const asset = events(first.body).find((x) => x.type === 'asset');
      assert.ok(asset);
      const originalStatic = (await app.inject(staticRequest)).json();
      await app.close();
      if (selected !== breeze) {
        // Known legacy Qwen/Kokoro caches predate identity receipts.
        unlinkSync(join(root, '.tts-identities.sqlite'));
      }
      const fresh = new TtsRegistry();
      fresh.register(new MlxAudioTtsProvider());
      app = Fastify();
      await app.register(ttsRoutes, { ttsRegistry: fresh, cacheDir: root });
      protocol.offline = true;
      const before = posts.length;
      const cached = await app.inject(streamRequest);
      assert.equal(cached.statusCode, 200, cached.body);
      const replay = events(cached.body);
      assert.deepEqual(
        replay.map((x) => x.type),
        ['asset'],
      );
      assert.equal(replay[0].cached, true);
      assert.equal(replay[0].assetId, asset.assetId);
      const staticReplay = await app.inject(staticRequest);
      assert.equal(staticReplay.statusCode, 200, staticReplay.body);
      assert.equal(staticReplay.json().cached, true);
      assert.equal(staticReplay.json().assetId, originalStatic.assetId);
      const uncached = await app.inject({ ...streamRequest, payload: { text: '没有缓存的新句。' } });
      assert.ok(uncached.statusCode !== 200 || events(uncached.body).some((x) => x.type === 'error'));
      assert.equal(posts.length, before, 'offline cache misses cannot start generation');
      setServiceConfig('mlx-tts', { port: 19891 });
      const wrongEndpoint = await app.inject(streamRequest);
      assert.ok(wrongEndpoint.statusCode !== 200 || !events(wrongEndpoint.body).some((x) => x.type === 'asset'));
      assert.equal(posts.length, before);
    } finally {
      await app.close();
    }
  });
}

for (const selected of [qwen, breeze]) {
  test(`VoiceBlockSynthesizer reuses ${selected} verified cache offline`, async () => {
    const protocol = { profile: selected === breeze ? policy : undefined };
    const { root, registry, posts } = fixture(() => {}, protocol);
    if (selected === qwen) setServiceConfig('mlx-tts', { selectedModel: qwen, port: 19890 });
    const old = await new VoiceBlockSynthesizer(registry, root).resynthesize('静态语音离线缓存。', 'opus');
    protocol.offline = true;
    const fresh = new TtsRegistry();
    fresh.register(new MlxAudioTtsProvider());
    const synth = new VoiceBlockSynthesizer(fresh, root);
    const replay = await synth.resynthesize('静态语音离线缓存。', 'opus');
    assert.equal(replay.audioUrl, old.audioUrl);
    await assert.rejects(synth.resynthesize('没有缓存。', 'opus'), /offline/i);
    assert.equal(posts.length, 1);
  });
}
test('a delayed conflicting observation requires a live reconfirmation before offline playback', async () => {
  const { root, registry } = fixture();
  let release;
  let observed;
  const firstHealth = new Promise((resolve) => {
    observed = resolve;
  });
  let healthCalls = 0;
  globalThis.fetch = async () => {
    healthCalls++;
    const details = { status: 'ok', model: breeze, backend: 'qwen3-clone', capabilities: ['speech-stream-route-v1'] };
    if (healthCalls === 1) {
      await new Promise((resolve) => {
        release = resolve;
        observed();
      });
      return Response.json(details);
    }
    return Response.json({ ...details, generation_profile: policy });
  };
  const provider = registry.getDefault();
  const old = provider.snapshot({ cacheDir: root });
  await firstHealth;
  const current = await provider.snapshot({ cacheDir: root });
  release();
  await old;
  globalThis.fetch = async () => {
    throw new TypeError('offline');
  };
  await assert.rejects(new MlxAudioTtsProvider().snapshot({ cacheDir: root }), /ambiguous/i);
  globalThis.fetch = async () =>
    Response.json({
      status: 'ok',
      model: breeze,
      backend: 'qwen3-clone',
      capabilities: ['speech-stream-route-v1'],
      generation_profile: policy,
    });
  await provider.snapshot({ cacheDir: root });
  globalThis.fetch = async () => {
    throw new TypeError('offline');
  };
  const cached = await new MlxAudioTtsProvider().snapshot({ cacheDir: root });
  assert.equal(cached.cacheIdentity, current.cacheIdentity);
  await assert.rejects(cached.synthesize({ text: '缓存缺失。', voice: 'S0' }), /offline/i);
});

test('offline auto discovery uses recorded identity and never invents a model without provenance', async () => {
  const protocol = { profile: policy };
  const { root, registry, posts } = fixture(() => {}, protocol);
  setServiceConfig('mlx-tts', { selectedModel: undefined });
  delete process.env.TTS_MODEL;
  const assets = new ListenAssetService(registry, root);
  const text = '旧安装也保留真实身份。';
  try {
    const online = await assets.getOrCreate(text);
    protocol.offline = true;
    const fresh = new TtsRegistry();
    fresh.register(new MlxAudioTtsProvider());
    const replay = new ListenAssetService(fresh, root);
    const missing = new ListenAssetService(fresh, join(root, 'never-observed'));
    try {
      const cached = await replay.getOrCreate(text);
      assert.equal(cached.assetId, online.assetId);
      assert.equal(cached.cached, true);
      await assert.rejects(missing.getOrCreate(text), /identity.*discovered/i);
      assert.equal(posts.length, 1);
    } finally {
      await replay.close();
      await missing.close();
    }
  } finally {
    await assets.close();
  }
});

test('unreadable profile provenance blocks offline guessing and is repaired by verified live health', async () => {
  const protocol = { profile: policy };
  const { root, registry, posts } = fixture(() => {}, protocol);
  const assets = new ListenAssetService(registry, root);
  try {
    const old = await assets.getOrCreate('只信已核实的缓存。');
    const db = new Database(join(root, '.tts-identities.sqlite'));
    try {
      db.prepare('UPDATE endpoint_identity SET generation_profile = ?').run('x'.repeat(65));
    } finally {
      db.close();
    }
    protocol.offline = true;
    await assert.rejects(assets.getOrCreate('只信已核实的缓存。'));
    protocol.offline = false;
    const repaired = await assets.getOrCreate('只信已核实的缓存。');
    assert.equal(repaired.cached, true);
    assert.equal(repaired.assetId, old.assetId);
    assert.equal(posts.length, 1);
  } finally {
    await assets.close();
  }
});

test('last-verified Breeze identity is not a claim about an unobserved offline switch', async () => {
  const protocol = {};
  const { root, registry, posts } = fixture(() => {}, protocol);
  const assets = new ListenAssetService(registry, root);
  try {
    const old = await assets.getOrCreate('上次验证过的语音。');
    protocol.profile = policy;
    protocol.offline = true;
    const cached = await assets.getOrCreate('上次验证过的语音。');
    assert.equal(cached.cached, true);
    assert.equal(cached.assetId, old.assetId, 'unobserved service changes cannot be discovered offline');
    unlinkSync(join(root, '.tts-identities.sqlite'));
    await assert.rejects(assets.getOrCreate('上次验证过的语音。'), /policy is unknown/i);
    assert.equal(posts.length, 1, 'missing metadata cannot guess legacy Breeze or infer audio');
  } finally {
    await assets.close();
  }
});

test('real listen/static entrances explain uncertain Breeze provenance without choosing cached audio', async () => {
  const protocol = { profile: policy };
  const { root, registry, posts } = fixture(() => {}, protocol);
  const app = Fastify();
  await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: root });
  const requests = ['/api/tts/listen/stream', '/api/tts/synthesize'].map((url) => ({
    method: 'POST',
    url,
    headers: { 'x-cat-cafe-user': 'operator' },
    payload: { text: '策略不确定时不要假装确定。' },
  }));
  try {
    for (const request of requests) assert.equal((await app.inject(request)).statusCode, 200);
    const db = new Database(join(root, '.tts-identities.sqlite'));
    try {
      db.prepare('UPDATE endpoint_identity SET ambiguous = 1').run();
    } finally {
      db.close();
    }
    protocol.offline = true;
    for (const request of requests) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().code, 'TTS_CACHE_IDENTITY_AMBIGUOUS');
    }
    protocol.offline = false;
    for (const request of requests) assert.equal((await app.inject(request)).statusCode, 200);
    protocol.offline = true;
    for (const request of requests) assert.equal((await app.inject(request)).statusCode, 200);
    unlinkSync(join(root, '.tts-identities.sqlite'));
    for (const request of requests) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().code, 'TTS_CACHE_IDENTITY_UNKNOWN');
    }
    assert.equal(posts.length, 2, 'uncertain or unknown metadata never generates; confirmation reuses caches');
  } finally {
    await app.close();
  }
});

for (const selected of ['/tmp/tts-models/Breeze-TTS-2-mlx', 'custom-owner/voice-model']) {
  test(`custom model ${selected} cannot guess an unprofiled offline namespace`, async () => {
    const protocol = { sameModel: selected };
    const { root, registry, posts } = fixture(() => {}, protocol);
    setServiceConfig('mlx-tts', { selectedModel: selected });
    const app = Fastify();
    await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: root });
    const requests = ['/api/tts/listen/stream', '/api/tts/synthesize'].map((url) => ({
      method: 'POST',
      url,
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { text: '自定义模型也不能猜策略。' },
    }));
    const assetId = (response, url) =>
      url.endsWith('/stream')
        ? JSON.parse(
            response.body
              .split('\n\n')
              .find((line) => line.startsWith('data: ') && line.includes('"type":"asset"'))
              .slice(6),
          ).assetId
        : response.json().assetId;
    try {
      const old = [];
      for (const request of requests) {
        const response = await app.inject(request);
        assert.equal(response.statusCode, 200, response.body);
        old.push(assetId(response, request.url));
      }
      protocol.profile = policy;
      for (const [index, request] of requests.entries()) {
        const response = await app.inject(request);
        assert.equal(response.statusCode, 200, response.body);
        assert.notEqual(assetId(response, request.url), old[index]);
      }
      unlinkSync(join(root, '.tts-identities.sqlite'));
      protocol.offline = true;
      for (const request of requests) {
        const response = await app.inject(request);
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.json().code, 'TTS_CACHE_IDENTITY_UNKNOWN');
      }
      assert.equal(posts.length, 4);
    } finally {
      await app.close();
    }
  });
}
