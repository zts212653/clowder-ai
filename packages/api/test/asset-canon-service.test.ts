import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssetCanonItem, AssetCanonUpdate } from '@cat-cafe/shared';
import { canonCat, canonFixture, canonHuman, canonReference } from './helpers/asset-canon-fixture.js';

type Listing = { items: AssetCanonItem[]; updates: AssetCanonUpdate[]; kept: AssetCanonUpdate[]; nextAfter?: number };

test('selection requires available canon; used lists retain failed, missing and changed exact versions', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.image('a.png');
  const b = await f.image('b.png');
  assert.equal(((await f.service.run({ action: 'list-assets' }, canonCat)) as Listing).items.length, 0);
  await f.use([a, b]);
  await f.mark(a, 'failed');
  await f.mark(b);
  assert.deepEqual(
    ((await f.service.run({ action: 'list-assets' }, canonCat)) as Listing).items.map((i) => i.record.name),
    ['b.png'],
  );
  await writeFile(join(f.root, 'b.png'), 'changed');
  const used = (await f.service.run(
    { action: 'list-assets', purpose: 'used', reference: canonReference },
    canonCat,
  )) as Listing;
  assert.equal(used.items.length, 2);
  assert.equal(used.items[0]!.record.status, 'failed');
  assert.equal(used.items[1]!.fileState, 'source_changed');
  assert.equal(((await f.service.run({ action: 'list-assets' }, canonCat)) as Listing).items.length, 0);
  await unlink(join(f.root, 'a.png'));
  assert.equal(
    ((await f.service.run({ action: 'list-assets', purpose: 'used', reference: canonReference }, canonCat)) as Listing)
      .items[0]!.fileState,
    'source_missing',
  );
});

test('creator stays immutable and a Work grant never grants another cat a global judgment', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.image('a.png');
  const foreign = { ...canonCat, actor: { kind: 'cat' as const, actorId: 'other' }, contentTaskId: 'work-only-grant' };
  const indexed = (await f.service.run(
    { action: 'index-asset', operationId: 'repeat-index', name: 'renamed', kind: 'image', version: a.version },
    foreign,
  )) as { assets: (typeof a)[] };
  assert.equal(indexed.assets[0]!.creator.actorId, 'director');
  const command = {
    action: 'set-asset-status',
    indexedVersionRef: a.indexedVersionRef,
    expectedRevision: 0,
    operationId: 'foreign-write',
    status: 'canonical',
    reason: 'Human 已同意',
    context: { reference: canonReference, metadataRevision: 1 },
  };
  await f.use([a]);
  await assert.rejects(f.service.run(command, foreign), /access_denied/);
  await assert.rejects(f.service.run({ ...command, actor: canonHuman.actor }, canonCat));
  f.denied.add('producer');
  await assert.rejects(
    f.service.run({ action: 'read-asset', indexedVersionRef: a.indexedVersionRef }, canonCat),
    /access_denied/,
  );
});

test('keep applies to one notice and Work version; later successor prompts again, replay keeps the original receipt', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.mark(await f.image('a.png'));
  const b = await f.mark(await f.image('b.png'));
  const c = await f.mark(await f.image('c.png'));
  const metadata = await f.use([a]);
  await f.replace(a, b);
  const check = async () =>
    f.service.run({ action: 'check-asset-updates', reference: canonReference }, canonCat) as Promise<Listing>;
  const first = (await check()).updates[0]!;
  assert.equal(first.replacement?.record.indexedVersionRef, b.indexedVersionRef);
  const command = {
    action: 'decide-asset-update',
    reference: canonReference,
    indexedVersionRef: a.indexedVersionRef,
    noticeScope: first.noticeScope,
    updateFingerprint: first.updateFingerprint,
    expectedDecisionRevision: 0,
    decision: 'keep_this_version',
    reason: '这版保留六月形象',
    operationId: 'keep-ep0',
  };
  await assert.rejects(f.service.run(command, canonCat), /access_denied/);
  await assert.rejects(f.service.run({ ...command, reason: ' ' }, canonHuman));
  const receipt = await f.service.run(command, canonHuman);
  assert.equal((await check()).updates.length, 0);
  assert.equal((await check()).kept.length, 1);
  assert.deepEqual(f.store.works.contexts.get('owner', canonReference), metadata);
  await f.use([a]); // unrelated metadata revision does not revive this notice
  assert.equal((await check()).updates.length, 0);
  await f.use([a], { ...canonReference, ownerRevision: 2 });
  assert.equal(
    (
      (await f.service.run(
        { action: 'check-asset-updates', reference: { ...canonReference, ownerRevision: 2 } },
        canonCat,
      )) as Listing
    ).updates.length,
    1,
  );
  await f.replace(b, c);
  assert.equal((await check()).updates[0]!.replacement?.record.indexedVersionRef, c.indexedVersionRef);
  assert.deepEqual(await f.service.run(command, canonHuman), receipt);
  await assert.rejects(f.service.run({ ...command, reason: '另一理由' }, canonHuman), /idempotency/);
  await assert.rejects(f.service.run({ ...command, operationId: 'stale-click' }, canonHuman), /update changed/);
  await unlink(join(f.root, 'a.png'));
  assert.ok((await check()).updates.some((u) => u.kind === 'source_missing'));
  f.denied.add(canonReference.contentRef);
  await assert.rejects(check(), /access_denied/);
});

test('indexing a readable file already used by another author cannot claim its original creator', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.image('unrelated.png');
  const version = { ...a.version, id: 'existing.png', locator: { ...a.version.locator, path: 'existing.png' } };
  await writeFile(join(f.root, 'existing.png'), 'unrelated.png');
  await f.contexts.save(
    {
      action: 'set-context',
      reference: { contentRef: 'work:original', ownerRevision: 1 },
      operationId: 'original-work-context',
      expectedMetadataRevision: 0,
      context: {
        format: 'video',
        extractorVersion: 'test',
        provenance: [{ ref: 'original', digest: version.sha256 }],
        story: [],
        assets: [
          {
            asset: { id: 'existing', name: 'existing.png', kind: 'image', versions: [version] },
            versionId: version.id,
            uses: ['全片'],
          },
        ],
      },
    },
    { ...canonCat, actor: { kind: 'cat', actorId: 'original-author' } },
  );
  const indexed = (await f.service.run(
    { action: 'index-asset', name: 'existing.png', kind: 'image', version, operationId: 'attempt-index' },
    canonCat,
  )) as { assets: (typeof a)[] };
  assert.equal(indexed.assets[0]!.creator.actorId, 'original-author');
  await assert.rejects(f.mark(indexed.assets[0]!), /access_denied/);
});

test('explicit supersession rejects cycles and incompatible purposes; revocation appends without reversing a successor', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.mark(await f.image('a.png'));
  const b = await f.mark(await f.image('b.png'));
  const c = await f.mark(await f.image('c.png'));
  await f.replace(a, b);
  await f.replace(b, c);
  await assert.rejects(f.replace(c, a), /current canonical|cycle/);
  const historyBefore = f.store.works.assets.history('owner', a.indexedVersionRef);
  const from = f.store.works.assets.get('owner', a.indexedVersionRef)!;
  const to = f.store.works.assets.get('owner', b.indexedVersionRef)!;
  const receipt = await f.service.run(
    {
      action: 'supersede-asset',
      mode: 'revoke',
      fromVersionRef: a.indexedVersionRef,
      toVersionRef: b.indexedVersionRef,
      expectedFromRevision: from.revision,
      expectedToRevision: to.revision,
      eventRef: from.supersededBy!.eventRef,
      reason: '撤销当时这一条取代，保留其余链路',
      operationId: 'revoke-a-b',
    },
    canonCat,
  );
  assert.ok(receipt);
  assert.equal(f.store.works.assets.get('owner', a.indexedVersionRef)!.supersededBy, null);
  assert.equal(
    f.store.works.assets.get('owner', b.indexedVersionRef)!.supersededBy!.indexedVersionRef,
    c.indexedVersionRef,
  );
  assert.equal(f.store.works.assets.history('owner', a.indexedVersionRef).length, historyBefore.length + 1);
  const use = {
    subjectRef: { kind: 'member' as const, catId: 'director' },
    representation: 'cat',
    styleKey: 'warm',
    role: 'portrait' as const,
  };
  const x = await f.mark(await f.image('x.png', 'x', [use]));
  const y = await f.mark(await f.image('y.png', 'y', [{ ...use, subjectRef: { kind: 'member', catId: 'other' } }]));
  await assert.rejects(f.replace(x, y), /Incompatible/);
  const z = await f.mark(await f.image('z.png', 'z', [{ ...use, styleKey: 'another-style' }]));
  await assert.rejects(f.replace(x, z), /Incompatible/);
});
