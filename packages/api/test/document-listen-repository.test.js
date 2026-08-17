import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DocumentListenRepository } from '../dist/domains/cats/services/tts/DocumentListenRepository.js';

const DAY = 24 * 60 * 60 * 1000;

describe('DocumentListenRepository', () => {
  let tempDir;
  let repository;

  before(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'listen-repository-'));
    repository = new DocumentListenRepository(path.join(tempDir, 'listen-mode.sqlite'));
    await repository.initialize();
  });

  after(async () => {
    repository.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists position, rate, retention, and reuses unchanged sentence assets after an edit', () => {
    const key = { userId: 'you', projectPath: '/repo', relativePath: 'paper.md' };
    repository.saveDocument(key, {
      identity: { projectPath: '/repo', relativePath: 'paper.md', contentDigest: 'v1' },
      sentences: [{ anchor: 'same' }, { anchor: 'changed' }],
      position: { anchor: 'same', offsetSeconds: 1.5 },
      playbackRate: 1.5,
      retention: '30d',
      updatedAt: 100,
    });
    repository.setSentenceAsset(key, 'same', 'a'.repeat(64), 200);
    repository.setSentenceAsset(key, 'changed', 'b'.repeat(64), 200);

    repository.saveDocument(key, {
      identity: { projectPath: '/repo', relativePath: 'paper.md', contentDigest: 'v2' },
      sentences: [{ anchor: 'inserted' }, { anchor: 'same' }],
      position: { anchor: 'same', offsetSeconds: 1.5 },
      playbackRate: 1.5,
      retention: '30d',
      updatedAt: 300,
    });

    assert.deepEqual(repository.loadDocument(key), {
      identity: { projectPath: '/repo', relativePath: 'paper.md', contentDigest: 'v2' },
      sentences: [{ anchor: 'inserted' }, { anchor: 'same', assetId: 'a'.repeat(64) }],
      position: { anchor: 'same', offsetSeconds: 1.5 },
      playbackRate: 1.5,
      retention: '30d',
      updatedAt: 300,
    });
  });

  it('does not orphan an asset while another document still references it', () => {
    const sharedAsset = 'c'.repeat(64);
    const first = { userId: 'you', projectPath: '/repo', relativePath: 'first.md' };
    const second = { userId: 'you', projectPath: '/repo', relativePath: 'second.md' };
    for (const key of [first, second]) {
      repository.saveDocument(key, {
        identity: { projectPath: key.projectPath, relativePath: key.relativePath, contentDigest: 'v1' },
        sentences: [{ anchor: 'shared' }],
        position: { anchor: null, offsetSeconds: 0 },
        playbackRate: 1,
        retention: '7d',
        updatedAt: 100,
      });
      repository.setSentenceAsset(key, 'shared', sharedAsset, 100);
    }

    assert.deepEqual(repository.clearDocumentAudio(first), []);
    assert.deepEqual(repository.clearDocumentAudio(second), [sharedAsset]);
    assert.equal(repository.loadDocument(first).position.anchor, null);
    assert.equal(repository.loadDocument(first).playbackRate, 1);
  });

  it('derives cleanup eligibility from last use and the strongest live retention', () => {
    const asset7d = 'd'.repeat(64);
    const assetForever = 'e'.repeat(64);
    const key7d = { userId: 'you', projectPath: '/repo', relativePath: '7d.md' };
    const keyForever = { userId: 'you', projectPath: '/repo', relativePath: 'forever.md' };
    const save = (key, retention, assetId) => {
      repository.saveDocument(key, {
        identity: { projectPath: key.projectPath, relativePath: key.relativePath, contentDigest: 'v1' },
        sentences: [{ anchor: 'sentence' }],
        position: { anchor: 'sentence', offsetSeconds: 0 },
        playbackRate: 1,
        retention,
        updatedAt: 100,
      });
      repository.setSentenceAsset(key, 'sentence', assetId, 100);
    };
    save(key7d, '7d', asset7d);
    save(keyForever, 'forever', assetForever);

    const policies = new Map(repository.listAssetPolicies().map((policy) => [policy.assetId, policy]));
    assert.equal(policies.get(asset7d).expiresAt, 100 + 7 * DAY);
    assert.equal(policies.get(assetForever).expiresAt, null);
  });

  it('keeps an asset-level forever policy after an edit removes its final sentence reference', () => {
    const assetId = 'f'.repeat(64);
    const key = { userId: 'you', projectPath: '/repo', relativePath: 'edited-forever.md' };
    repository.saveDocument(key, {
      identity: { projectPath: '/repo', relativePath: key.relativePath, contentDigest: 'v1' },
      sentences: [{ anchor: 'removed' }],
      position: { anchor: 'removed', offsetSeconds: 0 },
      playbackRate: 1,
      retention: 'forever',
      updatedAt: 100,
    });
    repository.setSentenceAsset(key, 'removed', assetId, 100);

    repository.saveDocument(key, {
      identity: { projectPath: '/repo', relativePath: key.relativePath, contentDigest: 'v2' },
      sentences: [{ anchor: 'replacement' }],
      position: { anchor: 'replacement', offsetSeconds: 0 },
      playbackRate: 1,
      retention: 'forever',
      updatedAt: 200,
    });

    const policy = repository.listAssetPolicies().find((candidate) => candidate.assetId === assetId);
    assert.equal(policy?.referenceCount, 0);
    assert.equal(policy?.expiresAt, null);
  });
});
