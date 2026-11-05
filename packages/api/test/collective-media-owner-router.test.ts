import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { createCollectiveArtifactOwner } from '../src/domains/collaborative-content/collective-artifact/owner-router.js';
import { collectiveArtifactOwnerFixture } from './collective-artifact-owner.fixture.js';
import { collectiveMediaHttpFixture } from './collective-media-http.fixture.js';
import { publishedCollectiveFixture } from './collective-published-media.fixture.js';
import { test } from './helpers/f202-collective-installed-business.js';

test('production composition dispatches by retained owner MIME rather than a caller payload', async (t) => {
  const f = await collectiveMediaHttpFixture(t);
  const modifications = new ArtifactReviewStore(join(f.media.root, 'router-modifications.sqlite'));
  t.after(() => modifications.close());
  const composed = createCollectiveArtifactOwner({
    owner: f.media.owner,
    reviews: f.media.reviews,
    modifications,
    media: f.media.media,
    ownerUserId: 'operator',
    custodyDataDir: join(f.media.root, 'custody'),
  });
  f.connector.setArtifactOwner(composed.port);
  const result = await f.invoke(f.owner.sessionToken, 'read', {}, 'composed-png-read');
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.value.mediaType, 'image/png');
  assert.equal(result.value.value.blobDigest, f.media.asset.blobDigest);
  const unavailable = await f.invoke(
    f.owner.sessionToken,
    'propose',
    { mediaType: 'text/markdown', kind: 'propose' },
    'composed-png-not-markdown',
  );
  assert.equal(unavailable.status, 422, JSON.stringify(unavailable.value));
  assert.ok(composed.port.custody, 'Original Markdown whole-unit custody is retained');
});

test('production composition preserves the original Markdown read, history and publication port', async (t) => {
  const f = await collectiveArtifactOwnerFixture(t);
  const retained = await publishedCollectiveFixture(t);
  const composed = createCollectiveArtifactOwner({
    owner: f.contentOwner,
    reviews: f.reviews,
    modifications: f.modifications,
    media: retained.media,
    ownerUserId: 'real-local-owner',
  });
  f.connector.setArtifactOwner(composed.port);
  const read = await f.request(f.owner.sessionToken, 'read', {}, 'composed-markdown-read');
  assert.equal(read.status, 200, JSON.stringify(read.value));
  assert.equal(read.value.value.text, f.text);
  const history = await f.request(
    f.owner.sessionToken,
    'history',
    { offset: 0, limit: 1 },
    'composed-markdown-history',
  );
  assert.equal(history.status, 200, JSON.stringify(history.value));
  assert.equal(history.value.value.versions[0].blobDigest, f.artifact.versions[0]?.blobDigest);
  assert.equal(typeof composed.port.publish, 'function');
});
