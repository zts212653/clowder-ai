import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { ListenRetention } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { DocumentCacheRunManager } from '../src/domains/cats/services/tts/DocumentCacheRunManager.js';
import { DocumentListenRepository } from '../src/domains/cats/services/tts/DocumentListenRepository.js';
import { ListenAssetService } from '../src/domains/cats/services/tts/ListenAssetService.js';
import { cleanTtsCache } from '../src/domains/cats/services/tts/tts-cache-cleaner.js';
import { ttsRoutes } from '../src/routes/tts.js';
import { fixture } from './helpers/voice-selection-fixture.js';

async function documents(t: TestContext, retention: ListenRetention = 'forever') {
  const f = await fixture(false);
  await f.app.close();
  const repo = new DocumentListenRepository(':memory:');
  await repo.initialize();
  const app = Fastify();
  await app.register(ttsRoutes, {
    ttsRegistry: f.registry,
    cacheDir: join(f.root, 'cache'),
    documentListenRepository: repo,
  });
  t.after(async () => {
    await app.close();
    repo.close();
  });
  const a = { userId: 'voice-test', projectPath: '/repo', relativePath: 'a.md' };
  const b = { ...a, relativePath: 'b.md' };
  for (const key of [a, b])
    repo.saveDocument(key, {
      identity: { ...key, contentDigest: 'v1' },
      sentences: [{ anchor: 'sentence' }],
      position: { anchor: 'sentence', offsetSeconds: 0 },
      playbackRate: 1,
      retention: key === a ? retention : 'forever',
      updatedAt: 1,
    });
  const assetId = `${'d'.repeat(64)}.wav`;
  const file = join(f.root, 'cache', assetId);
  repo.setSentenceAsset(a, 'sentence', assetId, 1);
  const publishB = () => {
    writeFileSync(file, 'new recorded audio');
    repo.setSentenceAsset(b, 'sentence', assetId);
  };
  const assertRetained = () => {
    assert.equal(
      repo.loadDocument(b)?.sentences[0].assetId,
      assetId,
      'a stale cleanup must not erase the new document link',
    );
    assert.equal(repo.listAssetPolicies().find((p) => p.assetId === assetId)?.expiresAt, null);
    assert.equal(existsSync(file), true, 'the newly retained recording must remain readable');
  };
  return {
    app,
    repo,
    a,
    b,
    file,
    assetId,
    publishB,
    assertRetained,
    cacheDir: join(f.root, 'cache'),
    registry: f.registry,
  };
}

test('a delayed ENOENT cannot forget a rebuilt shared recording or its forever policy', async (t) => {
  const f = await documents(t);
  const original = promises.stat;
  let rebuilt = false;
  const late = t.mock.method(promises, 'stat', async (...args: Parameters<typeof original>) => {
    try {
      return await original(...args);
    } catch (error) {
      if (!rebuilt && String(args[0]) === f.file && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        rebuilt = true;
        f.publishB(); // Actual file/database publication after the old stat result.
      }
      throw error;
    }
  });
  syncBuiltinESMExports();
  try {
    const response = await f.app.inject({
      url: '/api/tts/listen/document?projectPath=%2Frepo&relativePath=a.md',
      headers: { 'x-cat-cafe-user': 'voice-test' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(rebuilt, true);
  } finally {
    late.mock.restore();
    syncBuiltinESMExports();
  }
  f.assertRetained();
});

test('an orphan candidate cannot delete a recording another document has just retained', async (t) => {
  const f = await documents(t);
  writeFileSync(f.file, 'previous recording');
  const clear = f.repo.clearDocumentAudio.bind(f.repo);
  t.mock.method(f.repo, 'clearDocumentAudio', (key) => {
    const candidates = clear(key);
    f.publishB(); // Another committed document after the orphan-list snapshot.
    return candidates;
  });
  const response = await f.app.inject({
    method: 'DELETE',
    url: '/api/tts/listen/document/audio',
    headers: { 'x-cat-cafe-user': 'voice-test' },
    payload: { projectPath: '/repo', relativePath: 'a.md' },
  });
  assert.equal(response.statusCode, 200, response.body);
  f.assertRetained();
});

test('an expired-policy snapshot cannot delete a concurrently renewed forever recording', async (t) => {
  const f = await documents(t, '7d');
  writeFileSync(f.file, 'previous recording');
  const policies = f.repo.listAssetPolicies.bind(f.repo);
  let renewed = false;
  t.mock.method(f.repo, 'listAssetPolicies', () => {
    const old = policies();
    if (!renewed) {
      renewed = true;
      f.publishB();
    }
    return old;
  });
  const result = await cleanTtsCache(f.cacheDir, f.repo, Date.now());
  assert.equal(result.deleted, 0);
  f.assertRetained();
});

test('a cache listing cannot remove an atomically replaced audio file', async (t) => {
  const f = await documents(t, '7d');
  writeFileSync(f.file, 'old recording');
  const policies = f.repo.listAssetPolicies.bind(f.repo);
  t.mock.method(f.repo, 'listAssetPolicies', () => {
    const old = policies();
    writeFileSync(`${f.file}.replacement`, 'newly generated recording');
    renameSync(`${f.file}.replacement`, f.file);
    return old;
  });
  const result = await cleanTtsCache(f.cacheDir, f.repo, Date.now());
  assert.equal(result.deleted, 0);
  assert.equal(readFileSync(f.file, 'utf8'), 'newly generated recording');
});

for (const method of ['saveDocument', 'setSentenceAsset', 'setSentenceAssetIfCurrent'] as const) {
  test(`a file disappearing before ${method} cannot become a new retained recording`, async (t) => {
    const f = await documents(t);
    const headers = { 'x-cat-cafe-user': 'voice-test' };
    const generated = await f.app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers,
      payload: { catId: 'opus', purpose: 'listen', text: '待挂载的已生成句子。' },
    });
    assert.equal(generated.statusCode, 200, generated.body);
    const asset = generated.json();
    const state = { ...f.repo.loadDocument(f.b)!, synthesisFingerprint: asset.synthesisFingerprint };
    f.repo.saveDocument(f.b, state);
    const original = f.repo[method];
    t.mock.method(f.repo, method, (...args: unknown[]) => {
      unlinkSync(join(f.cacheDir, asset.assetId));
      return Reflect.apply(original, f.repo, args);
    });
    const response = await f.app.inject({
      method: 'PUT',
      url: method === 'saveDocument' ? '/api/tts/listen/document' : '/api/tts/listen/document/asset',
      headers,
      payload:
        method === 'saveDocument'
          ? { ...state, sentences: [{ anchor: 'sentence', assetId: asset.assetId }] }
          : {
              projectPath: '/repo',
              relativePath: 'b.md',
              anchor: 'sentence',
              assetId: asset.assetId,
              ...(method === 'setSentenceAssetIfCurrent'
                ? { contentDigest: 'v1', synthesisFingerprint: asset.synthesisFingerprint }
                : {}),
            },
    });
    assert.equal(response.statusCode, 409, 'the link must be rejected after its file disappears');
    assert.equal(f.repo.loadDocument(f.b)?.sentences[0].assetId, undefined);
  });
}

test('full-document prefill cannot retain a file removed before publication', async (t) => {
  const f = await documents(t);
  const assets = new ListenAssetService(f.registry, f.cacheDir);
  const runs = new DocumentCacheRunManager(f.repo, assets);
  t.after(async () => {
    runs.close();
    await assets.close();
  });
  const generate = assets.getOrCreate.bind(assets);
  t.mock.method(assets, 'getOrCreate', async (...args: Parameters<typeof generate>) => {
    const asset = await generate(...args);
    unlinkSync(join(f.cacheDir, asset.assetId));
    return asset;
  });
  const identity = { projectPath: '/repo', relativePath: 'b.md', contentDigest: 'v1' };
  runs.start({
    key: f.b,
    identity,
    synthesis: await assets.prepareSynthesis({ catId: 'opus' }),
    sentences: [{ anchor: 'sentence', text: '预制录音仍需在挂载时存在。' }],
  });
  const deadline = Date.now() + 5000;
  while (runs.status(f.b, f.repo.loadDocument(f.b)!).active && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.repo.loadDocument(f.b)?.sentences[0].assetId, undefined);
  assert.match(runs.status(f.b, f.repo.loadDocument(f.b)!).error ?? '', /失效/);
});
