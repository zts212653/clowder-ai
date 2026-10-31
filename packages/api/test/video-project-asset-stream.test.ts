import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { VideoProjectAssetIndex } from '../src/domains/video-studio/project/asset-index.js';

test('the existing asset index opens a stable bounded stream beyond its legacy Buffer cap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f326-asset-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(2 * 1024 * 1024, 31);
  await writeFile(join(root, 'voice.wav'), bytes);
  const version = {
    id: 'release-voice',
    mediaType: 'audio/wav',
    byteLength: bytes.length,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
    locator: { kind: 'workspace' as const, rootId: 'root', path: 'voice.wav' },
    recordedAt: '2026-10-20T00:00:00.000Z',
    origin: { kind: 'imported' as const, actor: null, at: '2026-10-20T00:00:00.000Z', refs: ['actual-release'] },
  };
  let allowed = true;
  const index = new VideoProjectAssetIndex({
    maxBytes: 1024 * 1024,
    resolveRoot: async () => {
      if (!allowed) throw new Error('root revoked');
      return { root, canonicalWorktreeId: 'root' };
    },
  });
  await assert.rejects(index.read(version), /bounded/);
  const frozen = await index.open(version);
  assert.notEqual(frozen.path, join(root, 'voice.wav'));
  try {
    await writeFile(join(root, 'voice.wav'), 'new source');
    const head = Buffer.alloc(64);
    assert.equal((await frozen.handle.read(head, 0, 64, 1_000_000)).bytesRead, 64);
    assert.deepEqual(head, bytes.subarray(1_000_000, 1_000_064));
    assert.equal((await readFile(join(root, 'voice.wav'))).toString(), 'new source');
  } finally {
    await frozen.handle.close();
    await frozen.cleanup();
  }
  await assert.rejects(access(frozen.path));
  allowed = false;
  await assert.rejects(index.open(version), /revoked/);
});
