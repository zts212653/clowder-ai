import assert from 'node:assert/strict';
import { access, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { DocumentCacheRunManager } from '../src/domains/cats/services/tts/DocumentCacheRunManager.js';
import { DocumentListenRepository } from '../src/domains/cats/services/tts/DocumentListenRepository.js';
import { ListenAssetService } from '../src/domains/cats/services/tts/ListenAssetService.js';
import { cleanTtsCache } from '../src/domains/cats/services/tts/tts-cache-cleaner.js';
import { ttsRoutes } from '../src/routes/tts.js';
import { fixture } from './helpers/voice-selection-fixture.js';

test('reference assets remain playable historical files but cannot become document cache links or prefill', async (t) => {
  const f = await fixture();
  await f.app.close();
  const repository = new DocumentListenRepository(join(f.root, 'listen.sqlite'));
  await repository.initialize();
  t.after(() => repository.close());
  const key = { userId: 'voice-test', projectPath: '/repo', relativePath: 'reference.md' };
  const identity = { projectPath: key.projectPath, relativePath: key.relativePath, contentDigest: 'content-v1' };
  const state = {
    identity,
    sentences: [{ anchor: 'a' }],
    position: { anchor: 'a', offsetSeconds: 2 },
    playbackRate: 1.5 as const,
    retention: '30d' as const,
    updatedAt: 1,
  };
  repository.saveDocument(key, state);
  const assets = new ListenAssetService(f.registry, join(f.root, 'cache'));
  const runs = new DocumentCacheRunManager(repository, assets);
  t.after(async () => {
    runs.close();
    await assets.close();
  });
  const prepared = await assets.prepareSynthesis({ catId: 'opus' });
  const run = runs.start({
    key,
    identity,
    synthesis: prepared,
    sentences: [{ anchor: 'a', text: '这一句不能被冒充成已核缓存。' }],
  });
  assert.equal(run.active, false);
  assert.match(run.error ?? '', /参考/);
  assert.equal(f.requests.length, 0, 'a nonreusable reference cache run must not waste generation');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(ttsRoutes, {
    ttsRegistry: f.registry,
    cacheDir: join(f.root, 'cache'),
    documentListenRepository: repository,
  });
  const headers = { 'x-cat-cafe-user': key.userId };
  const generated = await app.inject({
    method: 'POST',
    url: '/api/tts/synthesize',
    headers,
    payload: { catId: 'opus', text: '显式播放仍然可用。', purpose: 'listen' },
  });
  assert.equal(generated.statusCode, 200, generated.body);
  const asset = generated.json();
  assert.equal(asset.reusable, false);
  assert.equal((await app.inject({ url: asset.audioUrl, headers })).statusCode, 200);
  const link = await app.inject({
    method: 'PUT',
    url: '/api/tts/listen/document/asset',
    headers,
    payload: { ...key, anchor: 'a', assetId: asset.assetId },
  });
  assert.equal(link.statusCode, 409);
  const write = await app.inject({
    method: 'PUT',
    url: '/api/tts/listen/document',
    headers,
    payload: { ...state, sentences: [{ anchor: 'a', assetId: asset.assetId }] },
  });
  assert.equal(write.statusCode, 409);
  assert.equal(repository.loadDocument(key)?.sentences[0].assetId, undefined);
  assert.equal(repository.loadDocument(key)?.position.offsetSeconds, 2);
  // A legacy file without any generation receipt is historical audio, not proof
  // that the current selected voice can safely be linked as a document cache.
  await unlink(join(f.root, 'cache', `${asset.assetId}.voice.json`));
  const legacyLink = await app.inject({
    method: 'PUT',
    url: '/api/tts/listen/document/asset',
    headers,
    payload: { ...key, anchor: 'a', assetId: asset.assetId },
  });
  assert.equal(legacyLink.statusCode, 409, 'missing receipts must not authorize a reusable cache link');
  assert.equal((await app.inject({ url: asset.audioUrl, headers })).statusCode, 200);
});

test('reading legacy recordings preserves both documents and their permanent retention', async (t) => {
  const f = await fixture(true);
  await f.app.close();
  const repo = new DocumentListenRepository(':memory:');
  await repo.initialize();
  t.after(() => repo.close());
  const id = 'a'.repeat(64) + '.wav',
    cache = join(f.root, 'cache');
  await writeFile(join(cache, id), 'historical audio');
  const keys = ['one.md', 'two.md'].map((relativePath) => ({
    userId: 'voice-test',
    projectPath: '/repo',
    relativePath,
  }));
  for (const key of keys) {
    repo.saveDocument(key, {
      identity: { projectPath: key.projectPath, relativePath: key.relativePath, contentDigest: 'v1' },
      sentences: [{ anchor: 'a' }],
      synthesisFingerprint: 'legacy',
      position: { anchor: 'a', offsetSeconds: 2 },
      playbackRate: 1,
      retention: 'forever',
      updatedAt: 1,
    });
    repo.setSentenceAsset(key, 'a', id, 1);
  }
  const app = Fastify();
  t.after(() => app.close());
  await app.register(ttsRoutes, { ttsRegistry: f.registry, cacheDir: cache, documentListenRepository: repo });
  const res = await app.inject({
    url: '/api/tts/listen/document?projectPath=%2Frepo&relativePath=one.md',
    headers: { 'x-cat-cafe-user': 'voice-test' },
  });
  assert.equal(res.statusCode, 200);
  for (const key of keys)
    assert.equal(repo.loadDocument(key)?.sentences[0].assetId, id, 'a read must not erase another document recording');
  assert.equal(repo.listAssetPolicies()[0]?.expiresAt, null);
  await cleanTtsCache(cache, repo, Date.now() + 30 * 86400000, { maxSizeBytes: 0, targetSizeBytes: 0 });
  await access(join(cache, id));
});
test('confirmed reference voices can prefill the full document and retain completed links', async (t) => {
  const f = await fixture(true);
  const repo = new DocumentListenRepository(':memory:');
  await repo.initialize();
  t.after(() => repo.close());
  const assets = new ListenAssetService(f.registry, join(f.root, 'cache'));
  const runs = new DocumentCacheRunManager(repo, assets);
  t.after(async () => {
    runs.close();
    await assets.close();
    await f.app.close();
  });
  const key = { userId: 'voice-test', projectPath: '/repo', relativePath: 'full.md' },
    identity = { projectPath: key.projectPath, relativePath: key.relativePath, contentDigest: 'v1' };
  repo.saveDocument(key, {
    identity,
    sentences: [{ anchor: 'a' }, { anchor: 'b' }],
    position: { anchor: 'a', offsetSeconds: 0 },
    playbackRate: 1,
    retention: 'forever',
    updatedAt: 1,
  });
  const synthesis = await assets.prepareSynthesis({ catId: 'opus' });
  const started = runs.start({
    key,
    identity,
    synthesis,
    sentences: [
      { anchor: 'a', text: '第一句。' },
      { anchor: 'b', text: '第二句。' },
    ],
  });
  assert.equal(started.active, true, 'reference voices must retain the explicit full-cache journey');
  const end = Date.now() + 5000;
  while (runs.status(key, repo.loadDocument(key)).active && Date.now() < end)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(repo.loadDocument(key).sentences.every((s) => s.assetId));
  assert.equal(f.requests.length, 2);
  const repeated = runs.start({
    key,
    identity,
    synthesis: await assets.prepareSynthesis({ catId: 'opus' }),
    sentences: [
      { anchor: 'a', text: '第一句。' },
      { anchor: 'b', text: '第二句。' },
    ],
  });
  assert.equal(repeated.active, false);
  assert.equal(f.requests.length, 2);
  const cached = await assets.getOrCreate('第一句。', { synthesis: { catId: 'opus' } });
  assert.equal(cached.cached, true);
  assert.equal(cached.voiceSelection.referenceStatus, 'verified_cache');
});

test('progress-only saves preserve legacy recordings across reader-protocol activation', async (t) => {
  const f = await fixture();
  await f.app.close();
  const repository = new DocumentListenRepository(':memory:');
  await repository.initialize();
  t.after(() => repository.close());
  const app = Fastify();
  t.after(() => app.close());
  const cacheDir = join(f.root, 'cache');
  await app.register(ttsRoutes, { ttsRegistry: f.registry, cacheDir, documentListenRepository: repository });
  const identity = { projectPath: '/repo', relativePath: 'legacy-progress.md', contentDigest: 'v1' };
  const key = { userId: 'voice-test', ...identity };
  const headers = { 'x-cat-cafe-user': key.userId };
  const state = {
    identity,
    sentences: [{ anchor: 'a' }],
    position: { anchor: 'a', offsetSeconds: 0 },
    playbackRate: 1,
    retention: 'forever',
    updatedAt: 1,
  };
  const initial = await app.inject({ method: 'PUT', url: '/api/tts/listen/document', headers, payload: state });
  assert.equal(initial.statusCode, 200, initial.body);
  const fingerprint = initial.json().synthesisFingerprint;
  const assetId = 'b'.repeat(64) + '.wav';
  await writeFile(join(cacheDir, assetId), 'historical audio');
  repository.setSentenceAsset(key, 'a', assetId);
  const provider = f.registry.getDefault();
  for (const upgraded of [false, true]) {
    if (upgraded)
      f.registry.getDefault = () => ({ ...provider, referenceAudioSupport: true, referenceAudioContentSupport: true });
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/tts/listen/document',
      headers,
      payload: { ...state, position: { anchor: 'a', offsetSeconds: 2 }, updatedAt: 2 },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    if (upgraded) assert.notEqual(saved.json().synthesisFingerprint, fingerprint);
    else assert.equal(saved.json().synthesisFingerprint, fingerprint);
    assert.equal(repository.loadDocument(key)?.sentences[0].assetId, assetId);
    assert.equal(repository.listAssetPolicies()[0].expiresAt, null);
  }
});

for (const historicalCount of [0, 1]) {
  test(`protocol activation lets a legacy document with ${historicalCount} recordings continue uncached sentences`, async (t) => {
    const f = await fixture();
    await f.app.close();
    const repository = new DocumentListenRepository(':memory:');
    await repository.initialize();
    t.after(() => repository.close());
    const app = Fastify();
    t.after(() => app.close());
    const cacheDir = join(f.root, 'cache');
    await app.register(ttsRoutes, { ttsRegistry: f.registry, cacheDir, documentListenRepository: repository });
    const identity = { projectPath: '/repo', relativePath: `legacy-${historicalCount}.md`, contentDigest: 'v1' };
    const key = { userId: 'voice-test', ...identity };
    const headers = { 'x-cat-cafe-user': key.userId };
    const state = {
      identity,
      sentences: [{ anchor: 'a' }, { anchor: 'b' }],
      position: { anchor: 'a', offsetSeconds: 0 },
      playbackRate: 1,
      retention: 'forever',
      updatedAt: 1,
    };
    const initial = await app.inject({ method: 'PUT', url: '/api/tts/listen/document', headers, payload: state });
    assert.equal(initial.statusCode, 200, initial.body);
    const legacyFingerprint = initial.json().synthesisFingerprint;
    const historicalId = 'c'.repeat(64) + '.wav';
    if (historicalCount) {
      await writeFile(join(cacheDir, historicalId), 'historical recording');
      repository.setSentenceAsset(key, 'a', historicalId);
    }
    const provider = f.registry.getDefault();
    f.registry.getDefault = () => ({ ...provider, referenceAudioSupport: true, referenceAudioContentSupport: true });
    const upgraded = await app.inject({ method: 'PUT', url: '/api/tts/listen/document', headers, payload: state });
    assert.equal(upgraded.statusCode, 200, upgraded.body);
    const anchor = historicalCount ? 'b' : 'a';
    const generated = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers,
      payload: { catId: 'opus', text: '未缓存的新句。', purpose: 'listen' },
    });
    assert.equal(generated.statusCode, 200, generated.body);
    const asset = generated.json();
    assert.equal(asset.reusable, true);
    assert.notEqual(asset.synthesisFingerprint, legacyFingerprint);
    const linked = await app.inject({
      method: 'PUT',
      url: '/api/tts/listen/document/asset',
      headers,
      payload: { ...identity, anchor, assetId: asset.assetId, synthesisFingerprint: asset.synthesisFingerprint },
    });
    assert.equal(linked.statusCode, 200, linked.body);
    assert.equal(linked.json().linked, true, 'an upgraded document must accept the current uncached sentence');
    for (const offsetSeconds of [2, 4]) {
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/tts/listen/document',
        headers,
        payload: { ...state, position: { anchor, offsetSeconds }, updatedAt: offsetSeconds },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().synthesisFingerprint, asset.synthesisFingerprint);
      assert.equal(saved.json().sentences.find((s: { anchor: string }) => s.anchor === anchor).assetId, asset.assetId);
      if (historicalCount) assert.equal(saved.json().sentences[0].assetId, historicalId);
    }
    const currentProvider = f.registry.getDefault;
    f.registry.getDefault = () => {
      throw new Error('Reader temporarily offline');
    };
    const offlineSave = await app.inject({ method: 'PUT', url: '/api/tts/listen/document', headers, payload: state });
    assert.equal(offlineSave.statusCode, 200, offlineSave.body);
    assert.equal(offlineSave.json().synthesisFingerprint, asset.synthesisFingerprint);
    assert.equal(
      offlineSave.json().sentences.find((s: { anchor: string }) => s.anchor === anchor).assetId,
      asset.assetId,
    );
    if (historicalCount) assert.equal(offlineSave.json().sentences[0].assetId, historicalId);
    f.registry.getDefault = currentProvider;
    const assets = new ListenAssetService(f.registry, cacheDir);
    const runs = new DocumentCacheRunManager(repository, assets);
    t.after(async () => {
      runs.close();
      await assets.close();
    });
    const started = runs.start({
      key,
      identity,
      synthesis: await assets.prepareSynthesis({ catId: 'opus' }),
      sentences: [
        { anchor: 'a', text: '以当前声线预制第一句。' },
        { anchor: 'b', text: '未缓存的新句。' },
      ],
    });
    assert.equal(started.active, true, 'explicit prefill must refresh historical sentence identities');
    const deadline = Date.now() + 5000;
    while (runs.status(key, repository.loadDocument(key)!).active && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const final = repository.loadDocument(key);
    assert.ok(final?.sentences.every((sentence) => sentence.assetId));
    if (historicalCount) {
      assert.notEqual(final.sentences[0].assetId, historicalId);
      assert.equal(repository.listAssetPolicies().find((policy) => policy.assetId === historicalId)?.expiresAt, null);
    }
  });
}
