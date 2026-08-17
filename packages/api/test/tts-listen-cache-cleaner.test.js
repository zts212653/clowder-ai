import assert from 'node:assert/strict';
import { access, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DocumentListenRepository } from '../dist/domains/cats/services/tts/DocumentListenRepository.js';
import { cleanTtsCache } from '../dist/domains/cats/services/tts/tts-cache-cleaner.js';

const DAY = 24 * 60 * 60 * 1000;

describe('F279 retention-aware TTS cleaner', () => {
  let tempDir;
  let repository;

  before(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tts-listen-cleaner-'));
    repository = new DocumentListenRepository(path.join(tempDir, 'listen-mode.sqlite'));
    await repository.initialize();
  });

  after(async () => {
    repository.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('expires 7d audio by last use while retaining forever audio and durable state', async () => {
    const now = Date.now();
    const expired = `${'a'.repeat(64)}.wav`;
    const forever = `${'b'.repeat(64)}.wav`;
    const save = (relativePath, retention, assetId) => {
      const key = { userId: 'you', projectPath: '/repo', relativePath };
      repository.saveDocument(key, {
        identity: { projectPath: '/repo', relativePath, contentDigest: 'v1' },
        sentences: [{ anchor: 'sentence' }],
        position: { anchor: 'sentence', offsetSeconds: 3 },
        playbackRate: 2,
        retention,
        updatedAt: now,
      });
      repository.setSentenceAsset(key, 'sentence', assetId, now - 8 * DAY);
      return key;
    };
    const expiredKey = save('expired.md', '7d', expired);
    save('forever.md', 'forever', forever);
    for (const filename of [expired, forever]) {
      const filePath = path.join(tempDir, filename);
      await writeFile(filePath, 'audio');
      await utimes(filePath, new Date(now), new Date(now));
    }

    const result = await cleanTtsCache(tempDir, repository, now);

    assert.equal(result.deleted, 1);
    await assert.rejects(access(path.join(tempDir, expired)));
    await access(path.join(tempDir, forever));
    const state = repository.loadDocument(expiredKey);
    assert.equal(state.position.anchor, 'sentence');
    assert.equal(state.playbackRate, 2);
    assert.deepEqual(state.sentences, [{ anchor: 'sentence' }]);
  });

  it('evicts only legacy files under size pressure while honoring live listen retention', async () => {
    const now = Date.now();
    const sizeDir = await mkdtemp(path.join(tempDir, 'size-cap-'));
    const legacy = `${'c'.repeat(64)}.wav`;
    const retained7d = `${'d'.repeat(64)}.wav`;
    const retained30d = `${'e'.repeat(64)}.wav`;
    const retainedForever = `${'f'.repeat(64)}.wav`;
    const save = (relativePath, retention, assetId) => {
      const key = { userId: 'you', projectPath: '/repo', relativePath };
      repository.saveDocument(key, {
        identity: { projectPath: '/repo', relativePath, contentDigest: 'v1' },
        sentences: [{ anchor: 'sentence' }],
        position: { anchor: 'sentence', offsetSeconds: 0 },
        playbackRate: 1,
        retention,
        updatedAt: now,
      });
      repository.setSentenceAsset(key, 'sentence', assetId, now);
    };
    save('size-7d.md', '7d', retained7d);
    save('size-30d.md', '30d', retained30d);
    save('size-forever.md', 'forever', retainedForever);
    for (const filename of [legacy, retained7d, retained30d, retainedForever]) {
      await writeFile(path.join(sizeDir, filename), 'audio');
    }
    await utimes(path.join(sizeDir, legacy), new Date(now - DAY), new Date(now - DAY));

    const result = await cleanTtsCache(sizeDir, repository, now, { maxSizeBytes: 10, targetSizeBytes: 5 });

    assert.equal(result.deleted, 1);
    await assert.rejects(access(path.join(sizeDir, legacy)));
    await access(path.join(sizeDir, retained7d));
    await access(path.join(sizeDir, retained30d));
    await access(path.join(sizeDir, retainedForever));
  });

  it('fails closed when durable listen policy is unavailable', async () => {
    const now = Date.now();
    const unavailableDir = await mkdtemp(path.join(tempDir, 'policy-unavailable-'));
    const assetId = `${'9'.repeat(64)}.wav`;
    const filePath = path.join(unavailableDir, assetId);
    await writeFile(filePath, 'audio');
    await utimes(filePath, new Date(now - 8 * DAY), new Date(now - 8 * DAY));

    await assert.rejects(cleanTtsCache(unavailableDir, undefined, now), /repository is required/i);
    await access(filePath);
  });
});
