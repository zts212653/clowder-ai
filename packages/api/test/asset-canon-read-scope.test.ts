import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetCanonItem, WorkVideoContext } from '@cat-cafe/shared';
import { canonCat, canonFixture, canonHuman } from './helpers/asset-canon-fixture.js';

const originalWork = { contentRef: 'work:large-original', ownerRevision: 1 };
const laterWork = { contentRef: 'work:large-later', ownerRevision: 1 };
async function largeContext(f: Awaited<ReturnType<typeof canonFixture>>) {
  const at = new Date().toISOString();
  const context: WorkVideoContext = {
    format: 'video',
    extractorVersion: 'test',
    provenance: [{ ref: 'large-source', digest: `sha256:${'a'.repeat(64)}` }],
    story: [],
    assets: Array.from({ length: 1073 }, (_, i) => {
      const version = {
        id: `v${i}`,
        mediaType: 'image/png',
        byteLength: i + 1000,
        sha256: `sha256:${i.toString(16).padStart(64, '0')}`,
        recordedAt: at,
        locator: { kind: 'workspace' as const, rootId: 'root', path: `assets/${i}.png` },
        origin: { kind: 'created' as const, actor: canonCat.actor, at, refs: [] },
      };
      return {
        asset: { id: `a${i}`, name: `${i}.png`, kind: 'image', versions: [version] },
        versionId: version.id,
        uses: ['全片'],
      };
    }),
  };
  for (const reference of [originalWork, laterWork])
    await f.contexts.save(
      { action: 'set-context', reference, operationId: reference.contentRef, expectedMetadataRevision: 0, context },
      canonCat,
    );
}

for (const reference of [originalWork, laterWork]) {
  test(`one 50-row page over 1073 assets parses each source once: ${reference.contentRef}`, async (t) => {
    const f = await canonFixture();
    t.after(f.cleanup);
    await largeContext(f);
    let reads = 0,
      decodes = 0;
    const read = f.contexts.read.bind(f.contexts),
      get = f.store.works.contexts.get.bind(f.store.works.contexts);
    f.contexts.read = async (...args: Parameters<typeof read>) => {
      reads++;
      return read(...args);
    };
    f.store.works.contexts.get = (...args: Parameters<typeof get>) => {
      decodes++;
      return get(...args);
    };
    const command = { action: 'list-assets', purpose: 'used', reference, limit: 50, verifyFiles: false };
    for (const phase of ['cold', 'warm']) {
      reads = 0;
      decodes = 0;
      const start = performance.now();
      const result = (await f.service.run(command, canonHuman)) as { items: AssetCanonItem[] };
      assert.equal(result.items.length, 50);
      console.log(
        JSON.stringify({ source: reference.contentRef, phase, reads, decodes, durationMs: performance.now() - start }),
      );
      assert.ok(reads <= (reference === originalWork ? 2 : 3), `${phase}: ${reads} repeated context reads`);
      assert.ok(decodes <= (reference === originalWork ? 2 : 3), `${phase}: ${decodes} repeated full context decodes`);
    }
    const records = ((await f.service.run(command, canonHuman)) as { items: AssetCanonItem[] }).items;
    for (const { record } of records)
      await f.service.run(
        {
          action: 'set-asset-status',
          indexedVersionRef: record.indexedVersionRef,
          expectedRevision: 0,
          operationId: `mark-${record.name}`,
          status: 'failed',
          reason: 'Retain the actual missing original',
        },
        canonCat,
      );
    reads = 0;
    decodes = 0;
    const updates = (await f.service.run({ action: 'check-asset-updates', reference, limit: 50 }, canonHuman)) as {
      items: AssetCanonItem[];
    };
    assert.equal(updates.items.length, 50);
    assert.ok(reads <= (reference === originalWork ? 2 : 3), `updates: ${reads} repeated context reads`);
    assert.ok(decodes <= (reference === originalWork ? 2 : 3), `updates: ${decodes} repeated context decodes`);
  });
}

test('a cached source is reauthorized before returning and is not shared with the next request', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  await largeContext(f);
  const authorizeRoot = f.service.deps.authorizeRoot;
  let rootChecks = 0;
  f.service.deps.authorizeRoot = async (...args: Parameters<typeof authorizeRoot>) => {
    await authorizeRoot(...args);
    if (++rootChecks === 5) f.denied.add(originalWork.contentRef);
  };
  const command = { action: 'list-assets', purpose: 'used', reference: laterWork, limit: 50, verifyFiles: false };
  await assert.rejects(f.service.run(command, canonHuman), /access_denied/);
  const next = (await f.service.run(command, canonHuman)) as { items: AssetCanonItem[] };
  assert.equal(next.items.length, 50);
  assert.ok(
    next.items.every(
      (item) =>
        !item.canWrite &&
        item.record.source.kind === 'work' &&
        item.record.source.reference.contentRef === laterWork.contentRef,
    ),
  );
  assert.doesNotMatch(JSON.stringify(next), /work:large-original/);
});
