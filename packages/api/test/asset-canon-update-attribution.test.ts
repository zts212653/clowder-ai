import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetCanonUpdate } from '@cat-cafe/shared';
import { canonCat, canonFixture, canonHuman, canonReference } from './helpers/asset-canon-fixture.js';

test('update attribution follows the exact supersession and then the latest edge of A to B to C', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.mark(await f.image('a.png'));
  const b = await f.mark(await f.image('b.png'));
  const c = await f.mark(await f.image('c.png'));
  await f.use([a]);
  const receipt = (await f.service.run(
    {
      action: 'supersede-asset',
      mode: 'replace',
      fromVersionRef: a.indexedVersionRef,
      toVersionRef: b.indexedVersionRef,
      expectedFromRevision: a.revision,
      expectedToRevision: b.revision,
      operationId: 'human-replace',
      reason: '由 Human 定的新图',
    },
    canonHuman,
  )) as { recordedAt: string };
  await f.mark(a, 'failed');
  const check = async () =>
    (
      (await f.service.run({ action: 'check-asset-updates', reference: canonReference }, canonCat)) as {
        updates: AssetCanonUpdate[];
      }
    ).updates[0]!;
  const first = await check();
  assert.deepEqual(first.change, { actor: canonHuman.actor, recordedAt: receipt.recordedAt });
  assert.equal(first.reason, '由 Human 定的新图');
  await f.replace(b, c);
  const next = await check();
  assert.equal(next.replacement?.record.indexedVersionRef, c.indexedVersionRef);
  assert.deepEqual(next.change?.actor, canonCat.actor);
  assert.equal(next.reason, '采用已定稿的新图');
  assert.notEqual(next.updateFingerprint, first.updateFingerprint);
});

test('an unreadable successor never exposes the private change attribution', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const a = await f.mark(await f.image('a.png'));
  const b = await f.mark(await f.image('private.png'));
  await f.use([a]);
  await f.replace(a, b);
  const reference = { contentRef: 'work:private-source', ownerRevision: 1 };
  const metadata = await f.use([b], reference);
  const current = f.store.works.assets.get('owner', b.indexedVersionRef)!;
  f.store.works.assets.put(
    {
      ...current,
      revision: current.revision + 1,
      source: {
        kind: 'work',
        threadId: 'private-thread',
        reference,
        metadataRevision: metadata.metadataRevision,
        assetId: b.name,
      },
    },
    'fixture-source',
  );
  f.denied.add(reference.contentRef);
  const result = (await f.service.run({ action: 'check-asset-updates', reference: canonReference }, canonCat)) as {
    updates: AssetCanonUpdate[];
  };
  assert.equal(result.updates[0]!.kind, 'access_denied');
  assert.equal(result.updates[0]!.change, undefined);
  assert.equal(result.updates[0]!.replacement, undefined);
});
