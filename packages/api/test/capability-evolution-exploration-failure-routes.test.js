import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  experimentRef,
  explorationFixture,
  nodeRef,
  objectRef,
  programRef,
  source,
} from './capability-evolution-exploration.helper.mjs';
import {
  explorationHttpFixture as fixture,
  explorationUrl as url,
} from './capability-evolution-exploration-http.helper.mjs';

const unavailable = () => ({
  schemaVersion: 1,
  status: 'unavailable',
  programRef,
  objectRef,
  blockers: [{ code: 'target_drift', ownerRef: objectRef }],
});

test('version-only owners preserve unavailable blockers and distinguish invalid identity, protocol and read failures', async () => {
  for (const [read, status, state, code] of [
    [async () => unavailable(), 503, 'unavailable', 'target_drift'],
    [async () => undefined, 422, 'invalid', 'owner_version_review_invalid'],
    [
      async () => ({ ...unavailable(), objectRef: source('wrong-object') }),
      422,
      'invalid',
      'owner_version_review_identity_mismatch',
    ],
    [
      async () => {
        throw new Error('offline');
      },
      503,
      'unavailable',
      'owner_version_review_failed',
    ],
  ]) {
    const { app, adapter, counts } = await fixture();
    adapter.versionReview = read;
    const response = await app.inject({ url });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.json().status, state);
    assert(
      response.json().blockers.some((blocker) => blocker.code === code),
      response.body,
    );
    assert.equal(counts().writes, 0);
  }
});

test('legacy owner blockers are not silently lost when the bounded catalog is full', async () => {
  const { app, adapter } = await fixture();
  const raw = unavailable();
  raw.blockers = Array.from({ length: 32 }, (_, index) => ({ code: `owner_gap_${index}`, ownerRef: objectRef }));
  adapter.versionReview = async () => raw;
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 503, response.body);
  for (const blocker of raw.blockers) assert(response.json().blockers.some((entry) => entry.code === blocker.code));
});

const bytes = Buffer.from('verified-test-video');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const media = {
  mediaRef: source('video', sha256),
  kind: 'video',
  contentType: 'video/mp4',
  label: '真实原件',
  provenance: 'original',
  sourceRecordRef: source('actual-response'),
};
const mediaUrl = `${url}-media/${sha256}?${new URLSearchParams({
  experimentRef: JSON.stringify(experimentRef),
  recordRef: JSON.stringify(source('record')),
})}`;

test('record failures map to their own HTTP status before any media lookup or byte read', async () => {
  for (const [status, expected] of [
    ['unavailable', 503],
    ['invalid', 422],
  ]) {
    const { app, adapter, counts } = await fixture();
    const publication = explorationFixture({ withDetail: true });
    publication.details = [{ status, experimentRef, nodeRef, reason: '记录来源状态已由 owner 核对' }];
    adapter.explorationReview = async () => publication;
    let byteReads = 0;
    adapter.explorationMedia = async () => {
      byteReads++;
      return undefined;
    };
    const response = await app.inject({ url: mediaUrl });
    assert.equal(response.statusCode, expected, response.body);
    assert.equal(response.json().error, `exploration_record_${status}`);
    assert.equal(byteReads, 0);
    assert.equal(counts().writes, 0);
  }
});

test('a failed record media inventory is never reported as an absent media URL', async () => {
  for (const [status, expected] of [
    ['unavailable', 503],
    ['invalid', 422],
  ]) {
    const { app, adapter } = await fixture();
    const publication = explorationFixture({ withDetail: true });
    publication.details[0].records[0].mediaStatus = { status, reason: '媒体来源未通过读取或核验' };
    adapter.explorationReview = async () => publication;
    let byteReads = 0;
    adapter.explorationMedia = async () => {
      byteReads++;
      return undefined;
    };
    const response = await app.inject({ url: mediaUrl });
    assert.equal(response.statusCode, expected, response.body);
    assert.equal(response.json().error, `exploration_media_${status}`);
    assert.equal(byteReads, 0);
  }
});

test('byte readers use an explicit response protocol for unavailable, invalid and withdrawn sources', async () => {
  const { app, adapter } = await fixture();
  adapter.explorationReview = async () => explorationFixture({ withDetail: true, media });
  for (const [status, expected] of [
    ['unavailable', 503],
    ['invalid', 422],
    ['not_found', 404],
  ]) {
    adapter.explorationMedia = async () => ({ status, reason: 'owner 已明确给出此读取状态' });
    const response = await app.inject({ url: mediaUrl });
    assert.equal(response.statusCode, expected, response.body);
    assert.equal(response.json().error, `exploration_media_${status}`);
  }
  adapter.explorationMedia = async () => ({ status: 'still_working' });
  const malformed = await app.inject({ url: mediaUrl });
  assert.equal(malformed.statusCode, 422);
  assert.equal(malformed.json().error, 'exploration_media_protocol_invalid');
  delete adapter.explorationMedia;
  const missingReader = await app.inject({ url: mediaUrl });
  assert.equal(missingReader.statusCode, 503);
  assert.equal(missingReader.json().error, 'exploration_media_unavailable');
});

test('validated media response still verifies the exact publication identity, type, byte limit and hash', async () => {
  const { app, adapter } = await fixture();
  adapter.explorationReview = async () => explorationFixture({ withDetail: true, media });
  const valid = { status: 'resolved', mediaRef: media.mediaRef, kind: 'video', contentType: 'video/mp4', bytes };
  for (const mutation of [
    { mediaRef: source('another-media', sha256) },
    { bytes: Buffer.from('tampered') },
    { bytes: Buffer.alloc(25 * 1024 * 1024 + 1) },
    { bytes: new Uint8Array() },
    { kind: 'image', contentType: 'image/png' },
    { contentType: 'text/html' },
  ]) {
    adapter.explorationMedia = async () => ({ ...valid, ...mutation });
    assert.equal((await app.inject({ url: mediaUrl })).statusCode, 422);
  }
  adapter.explorationMedia = async () => valid;
  const response = await app.inject({ url: mediaUrl });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, bytes);
});
