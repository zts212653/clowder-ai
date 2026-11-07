import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  CanonicalTasteMemoryCueSource,
  F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1,
  tasteTaskBundleAnchor,
} from '../../dist/domains/memory/cue/sources/TasteMemoryCueSource.js';
import { TasteMemoryReader } from '../../dist/domains/memory/taste/TasteMemoryReader.js';
import { owner, publishedCueFixture, sha, vignette } from '../helpers/cue-published-fixture.js';
import { git } from '../taste-publication-fixtures.js';

const path = 'docs/taste/vignettes/cognitive.md';
const missingPath = 'docs/taste/vignettes/published-only.md';
const selection = { ownerUserId: owner, stage: 'review', selectedSkill: 'request-review', featureId: 'F999' };

async function readMap(source) {
  const projection = await source.resolve(selection);
  assert.ok(projection, 'a published map remains available without checkout synchronization');
  const result = await source.read({
    ownerUserId: owner,
    anchor: `taste-dimensions:${projection.dimensions.join(',')}`,
    expectedRevision: projection.revision,
  });
  assert.equal(result.status, 'ok');
  return { projection, result };
}

test('Taste cue discovery and drill use published public files while private sources stay local and owner scoped', async (t) => {
  const approved = vignette('Approved published scene');
  const f = publishedCueFixture(t, { [path]: approved, [missingPath]: vignette('Published only scene') });
  writeFileSync(join(f.primary, path), vignette('Unsubmitted local edit'));
  rmSync(join(f.primary, missingPath));
  writeFileSync(join(f.primary, 'docs/taste/vignettes/untracked.md'), vignette('Untracked public draft'));
  mkdirSync(join(f.primary, 'private/taste'), { recursive: true });
  writeFileSync(join(f.primary, 'private/taste/private.md'), vignette('Owner private scene', 'sensitive'));
  const before = git(f.primary, ['status', '--porcelain']);
  const reader = new TasteMemoryReader(f.repository, owner);
  assert.equal((await reader.read({ ownerUserId: owner, sourcePath: path })).payload.scene, 'Approved published scene');
  const source = new CanonicalTasteMemoryCueSource(f.repository, owner);
  const { result } = await readMap(source);
  assert.deepEqual(result.payload.vignettes.map((x) => x.payload.scene).sort(), [
    'Approved published scene',
    'Owner private scene',
    'Published only scene',
  ]);
  assert.equal(await source.resolve({ ...selection, ownerUserId: 'another-owner' }), null);
  assert.equal(git(f.primary, ['status', '--porcelain']), before, 'readers never synchronize or modify the checkout');
});

test('a corrected published Taste remains discoverable and an old cue cannot silently switch revisions', async (t) => {
  const original = vignette('Original published scene');
  const f = publishedCueFixture(t, { [path]: original });
  let currentRevision = `sha256:${sha(original)}`;
  const source = new CanonicalTasteMemoryCueSource(f.repository, owner, {
    isReadable: (user, sourcePath, revision) => user === owner && sourcePath === path && revision === currentRevision,
  });
  const old = await readMap(source);
  const corrected = vignette('Corrected published scene');
  f.publish(path, corrected);
  currentRevision = `sha256:${sha(corrected)}`;
  writeFileSync(join(f.primary, path), original);
  const after = await readMap(source);
  assert.equal(after.result.payload.vignettes[0].payload.scene, 'Corrected published scene');
  assert.notEqual(after.projection.revision, old.projection.revision);
  assert.equal(
    (
      await source.read({
        ownerUserId: owner,
        anchor: 'taste-dimensions:cognitive-honesty',
        expectedRevision: old.projection.revision,
      })
    ).status,
    'not_available',
  );
  f.publish(path, null);
  mkdirSync(dirname(join(f.primary, path)), { recursive: true });
  writeFileSync(join(f.primary, path), corrected);
  assert.equal(await source.resolve(selection), null, 'local leftovers never restore a removed published source');
});

test('the existing named Taste bundle resolves the same published revisions as its exact drill reader', async (t) => {
  const paths = F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths;
  const files = Object.fromEntries(paths.map((p, i) => [p, vignette(`Published bundle item ${i}`)]));
  const f = publishedCueFixture(t, files);
  for (const p of paths) {
    mkdirSync(dirname(join(f.primary, p)), { recursive: true });
    writeFileSync(join(f.primary, p), vignette('Unpublished bundle edit'));
  }
  const source = new CanonicalTasteMemoryCueSource(f.repository, owner);
  const bundle = await source.resolveTaskBundle({ ...selection, featureId: 'F315' });
  assert.ok(bundle);
  for (const [i, item] of bundle.sources.entries()) {
    const drilled = await source.read({
      ownerUserId: owner,
      anchor: tasteTaskBundleAnchor(bundle.bundleId, item.sourcePath),
      expectedRevision: item.revision,
    });
    assert.equal(drilled.status, 'ok', 'resolve and drill must agree without a checkout update');
    assert.equal(drilled.payload.vignette.payload.scene, `Published bundle item ${i}`);
  }
  assert.match(readFileSync(join(f.primary, paths[0]), 'utf8'), /Unpublished bundle edit/);
});
