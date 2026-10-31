import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectAssetIndex } from '../src/domains/video-studio/project/asset-index.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as human, projectDocumentFixture } from './helpers/video-project-fixture.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'f326-assets-'));
  await writeFile(join(root, 'image.png'), 'original');
  const assets = new VideoProjectAssetIndex({
    resolveRoot: async (rootId) => {
      assert.equal(rootId, 'allowed-root');
      return { canonicalWorktreeId: rootId, root };
    },
  });
  const locator = { kind: 'workspace' as const, rootId: 'allowed-root', path: 'image.png' };
  const version = {
    id: 'picture-v1',
    mediaType: 'image/png',
    ...(await assets.inspect(locator)),
    origin: projectDocumentFixture.origin,
    recordedAt: '2026-10-08T00:00:00.000Z',
  };
  return { root, assets, version };
}

test('indexed bytes are verified by digest; changed/missing do not masquerade as the old version', async () => {
  const { root, assets, version } = await fixture();
  try {
    const read = await assets.read(version);
    assert.equal(read.state, 'available');
    if (read.state === 'available') assert.equal(read.bytes.toString(), 'original');
    await writeFile(join(root, 'image.png'), 'modified');
    assert.deepEqual(await assets.read(version), { state: 'changed' });
    await rm(join(root, 'image.png'));
    assert.deepEqual(await assets.read(version), { state: 'missing' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('asset resolver rejects traversal spelling and symlink escape within a registered root', async () => {
  const { root, assets, version } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'f326-outside-'));
  try {
    await mkdir(join(root, 'nested'));
    await assert.rejects(assets.inspect({ ...version.locator, path: 'nested/../image.png' }));
    await writeFile(join(outside, 'private.png'), 'private');
    await symlink(join(outside, 'private.png'), join(root, 'escape.png'));
    await assert.rejects(assets.inspect({ ...version.locator, path: 'escape.png' }));
    await assert.rejects(assets.inspect({ ...version.locator, rootId: 'unknown-root' }));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('an identical project create retry remains idempotent after an indexed source changes', async () => {
  const { root, assets, version } = await fixture();
  try {
    const owner = new ProjectContentOwnerService({ dataDir: join(root, 'data') });
    const projects = new VideoProjectService({ owner, ownerUserId: 'operator', assets });
    const document = {
      ...structuredClone(projectDocumentFixture),
      assets: [{ id: 'picture', name: 'Picture', kind: 'image', versions: [version] }],
    };
    const input = { principal: human, document, operationId: 'create-with-asset' };
    const receipt = await projects.create(input);
    await writeFile(join(root, 'image.png'), 'modified');
    assert.deepEqual(await projects.create(input), receipt);
    assert.deepEqual(
      await projects.readAsset({ principal: human, contentRef: receipt.contentRef, assetVersionRef: version.id }),
      { state: 'changed' },
    );
    assert.equal((await owner.listOutbox(receipt.contentRef)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
