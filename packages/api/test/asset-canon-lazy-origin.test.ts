import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssetCanonItem, AssetCanonUpdate, WorkReference, WorkVideoContext } from '@cat-cafe/shared';
import { canonCat, canonFixture, canonHuman } from './helpers/asset-canon-fixture.js';

const original = { ...canonCat, actor: { kind: 'cat' as const, actorId: 'original-author' } };
const later = { ...canonCat, actor: { kind: 'cat' as const, actorId: 'second-author' } };
const firstWork = { contentRef: 'work:private-original-film', ownerRevision: 1 };
const laterWork = { contentRef: 'work:later-film', ownerRevision: 1 };

async function sharedContexts(f: Awaited<ReturnType<typeof canonFixture>>) {
  const bytes = 'same exact shared image';
  await writeFile(join(f.root, 'shared.png'), bytes);
  const at = new Date().toISOString();
  const version = {
    id: 'shared',
    mediaType: 'image/png',
    byteLength: Buffer.byteLength(bytes),
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    recordedAt: at,
    locator: { kind: 'workspace' as const, rootId: 'root', path: 'shared.png' },
    origin: { kind: 'created' as const, actor: original.actor, at, refs: [] },
  };
  for (const [reference, principal] of [
    [firstWork, original],
    [laterWork, later],
  ] as const) {
    const context: WorkVideoContext = {
      format: 'video',
      extractorVersion: 'test',
      story: [],
      provenance: [
        { ref: reference === firstWork ? 'private-original-path' : 'visible-later-path', digest: version.sha256 },
      ],
      assets: [
        {
          asset: {
            id: 'shared',
            name: reference === firstWork ? 'private-original-title' : 'shared.png',
            kind: 'image',
            versions: [version],
          },
          versionId: version.id,
          uses: ['全片'],
        },
      ],
    };
    await f.contexts.save(
      { action: 'set-context', reference, context, operationId: reference.contentRef, expectedMetadataRevision: 0 },
      principal,
    );
  }
}

for (const firstOpened of [firstWork, laterWork]) {
  test(`lazy used indexing retains the original creator when ${firstOpened.contentRef} opens first`, async (t) => {
    const f = await canonFixture();
    t.after(f.cleanup);
    await sharedContexts(f);
    const view = (reference: WorkReference) =>
      f.service.run({ action: 'list-assets', purpose: 'used', reference, verifyFiles: false }, canonHuman) as Promise<{
        items: AssetCanonItem[];
      }>;
    const item = (await view(firstOpened)).items[0]!;
    await view(firstOpened === firstWork ? laterWork : firstWork);
    const stored = f.store.works.assets.get('owner', item.record.indexedVersionRef)!;
    assert.deepEqual(stored.creator, original.actor);
    assert.equal(stored.source.kind, 'work');
    if (stored.source.kind === 'work') assert.deepEqual(stored.source.reference, firstWork);
    await assert.rejects(
      f.service.run(
        {
          action: 'set-asset-status',
          indexedVersionRef: stored.indexedVersionRef,
          expectedRevision: 0,
          operationId: 'borrow-work-write',
          status: 'failed',
          reason: 'Only my own Work was entrusted',
          context: { reference: laterWork, metadataRevision: 1 },
        },
        later,
      ),
      /access_denied/,
    );
    assert.equal(f.store.works.assets.get('owner', stored.indexedVersionRef)!.status, null);
  });
}

for (const verifyFiles of [false, true]) {
  test(`a later Work remains readable without disclosing its hidden original context (verifyFiles=${verifyFiles})`, async (t) => {
    const f = await canonFixture();
    t.after(f.cleanup);
    await sharedContexts(f);
    f.denied.add(firstWork.contentRef);
    const command = { action: 'list-assets', purpose: 'used', reference: laterWork, verifyFiles };
    const result = (await f.service.run(command, later)) as { items: AssetCanonItem[] };
    assert.equal(result.items.length, 1);
    const item = result.items[0]!;
    assert.deepEqual(item.record.creator, original.actor);
    assert.equal(item.canWrite, false);
    assert.equal(item.fileState, verifyFiles ? 'available' : 'unverified');
    assert.equal(item.record.name, 'shared.png');
    assert.doesNotMatch(JSON.stringify(result), /private-original/);
    const stored = f.store.works.assets.get('owner', item.record.indexedVersionRef)!;
    assert.equal(stored.source.kind, 'work');
    if (stored.source.kind === 'work') assert.deepEqual(stored.source.reference, firstWork);
    await assert.rejects(
      f.service.run(
        {
          action: 'set-asset-status',
          indexedVersionRef: stored.indexedVersionRef,
          expectedRevision: 0,
          operationId: 'hidden-original-write',
          status: 'failed',
          reason: 'I can read my own Work',
        },
        later,
      ),
      /access_denied/,
    );
    f.denied.add(laterWork.contentRef);
    await assert.rejects(f.service.run(command, later), /access_denied/);
  });
}

test('used status and update reads keep the hidden origin private without widening writer access', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  await sharedContexts(f);
  const command = { action: 'list-assets', purpose: 'used', reference: laterWork };
  const initial = (await f.service.run(command, canonHuman)) as { items: AssetCanonItem[] };
  const ref = initial.items[0]!.record.indexedVersionRef;
  await f.service.run(
    {
      action: 'set-asset-status',
      indexedVersionRef: ref,
      expectedRevision: 0,
      operationId: 'original-judgment',
      status: 'failed',
      reason: 'private-original-reason',
    },
    original,
  );
  f.denied.add(firstWork.contentRef);
  const listed = (await f.service.run(command, later)) as { items: AssetCanonItem[] };
  assert.equal(listed.items[0]!.record.status, 'failed');
  assert.equal(listed.items[0]!.record.judgment, null);
  assert.equal(listed.items[0]!.canWrite, false);
  const updates = (await f.service.run({ action: 'check-asset-updates', reference: laterWork }, later)) as {
    items: AssetCanonItem[];
    updates: AssetCanonUpdate[];
  };
  assert.equal(updates.items.length, 1);
  assert.doesNotMatch(JSON.stringify({ listed, updates }), /private-original/);
  await assert.rejects(f.service.run({ action: 'read-asset-history', indexedVersionRef: ref }, later), /access_denied/);
  f.denied.add('root');
  await assert.rejects(f.service.run(command, later), /access_denied/);
});
