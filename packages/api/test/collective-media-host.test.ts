import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mediaHostFixture } from './collective-media-host.fixture.js';
import { mediaRangeFixture } from './collective-media-range.fixture.js';
import { after, before, test } from './helpers/f202-collective-installed-business.js';

const configuredOwner = process.env.DEFAULT_OWNER_USER_ID;
before(() => {
  delete process.env.DEFAULT_OWNER_USER_ID;
});
after(() => {
  if (configuredOwner !== undefined) process.env.DEFAULT_OWNER_USER_ID = configuredOwner;
});

test('the normal Host serves exact media through its authenticated paired reader Cafe', async (t) => {
  const f = await mediaRangeFixture(t);
  const host = await mediaHostFixture(t, f.directory);
  const path = `/api/plugins/official.collective-connector/connections/${f.connection.connectionId}/artifacts/${f.input.artifactId}/media/1?sourceEventId=${f.input.sourceEventId}`;
  const response = await f.drive(fetch(`${host.url}${path}`, { headers: { cookie: 'test-session=reader' } }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.f.media.bytes);
});

test('Host reads reject missing, remote, borrowed or cross-source authority before disclosing bytes', async (t) => {
  const f = await mediaRangeFixture(t);
  const host = await mediaHostFixture(t, f.directory);
  const path = `/api/plugins/official.collective-connector/connections/${f.connection.connectionId}/artifacts/${f.input.artifactId}/media/1?sourceEventId=${f.input.sourceEventId}`;
  for (const [headers, expected] of [
    [{}, 401],
    [{ 'x-cat-cafe-user': 'reader-private-human' }, 401],
    [{ cookie: 'test-session=publisher' }, 403],
    [{ cookie: 'test-session=reader', origin: 'https://foreign.invalid' }, 403],
    [{ cookie: 'test-session=reader', 'x-forwarded-for': '127.0.0.1' }, 403],
    [{ 'x-invocation-id': 'other-cat', 'x-callback-token': 'borrowed' }, 401],
  ] as const) {
    const response = await fetch(`${host.url}${path}`, { headers });
    assert.equal(response.status, expected, await response.text());
  }
  for (const changed of [
    path.replace('/media/1?', '/media/0?'),
    `${path}&humanId=forged`,
    `${path}&contentRef=private`,
  ]) {
    const response = await fetch(`${host.url}${changed}`, { headers: { cookie: 'test-session=reader' } });
    assert.equal(response.status, 400, await response.text());
  }
  const denied = await f.drive(
    fetch(`${host.url}${path.replace(f.input.sourceEventId, 'foreign-source')}`, {
      headers: { cookie: 'test-session=reader' },
    }),
  );
  assert.equal(denied.status, 403, await denied.text());
});

test('the Host forwards real MP4 ranges and 416 without exposing a private media URL', async (t) => {
  const f = await mediaRangeFixture(t, 'video/mp4');
  const host = await mediaHostFixture(t, f.directory);
  const url = `${host.url}/api/plugins/official.collective-connector/connections/${f.connection.connectionId}/artifacts/${f.input.artifactId}/media/1?sourceEventId=${f.input.sourceEventId}`;
  for (const [range, start, end] of [
    ['bytes=0-31', 0, 31],
    ['bytes=-16', f.f.media.bytes.length - 16, f.f.media.bytes.length - 1],
  ] as const) {
    const response = await f.drive(fetch(url, { headers: { cookie: 'test-session=reader', range } }));
    assert.equal(response.status, 206, await response.clone().text());
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${f.f.media.bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.f.media.bytes.subarray(start, end + 1));
  }
  const response = await f.drive(fetch(url, { headers: { cookie: 'test-session=reader', range: 'bytes=99999999-' } }));
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), `bytes */${f.f.media.bytes.length}`);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  await f.f.store.updateArtifactAccess(f.f.owner.sessionToken, {
    ...f.f.coordinates,
    artifactId: f.input.artifactId,
    humanId: f.f.member.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'revoke-Host-range-reader',
  });
  const revoked = await f.drive(fetch(url, { headers: { cookie: 'test-session=reader', range: 'bytes=32-63' } }));
  assert.equal(revoked.status, 403, await revoked.text());
  assert.equal((await f.f.invoke(f.f.owner.sessionToken, 'read', {}, 'other-reader-remains')).status, 200);
});

test('explicit Host sharing derives the exact retained tuple and replays one public registration', async (t) => {
  const f = await mediaRangeFixture(t);
  const publisher = f.f.media;
  const original = await publisher.owner.describe(publisher.asset.contentRef, 1);
  const contentRef = `${publisher.asset.contentRef}-second-retained`;
  await publisher.owner.importContent({
    contentRef,
    bytes: publisher.bytes,
    mediaType: 'image/png',
    publicationScope: original.publicationScope,
    sourcePublication: original.sourcePublication,
    actor: { kind: 'human', actorId: 'operator' },
    operationId: 'another-retained-publication',
  });
  const host = await mediaHostFixture(t, join(publisher.root, 'connector'), publisher.port);
  const url = `${host.url}/api/plugins/official.collective-connector/connections/${f.f.connection.connectionId}/artifacts/share-media`;
  const input = {
    contentRef,
    ownerRevision: 1,
    title: '明确分享的作品',
    sourceEventId: f.f.source.eventId,
    requestId: 'explicit-share-host-once',
  };
  const share = (body: unknown = input, cookie = 'test-session=publisher') =>
    fetch(url, {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost:5182', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const first = await share();
  assert.equal(first.status, 200, await first.clone().text());
  const artifact = await first.json();
  assert.equal(artifact.contentRef, contentRef);
  assert.equal(artifact.mediaType, 'image/png');
  assert.equal(artifact.versions[0].blobDigest, publisher.asset.blobDigest);
  assert.equal(artifact.versions.length, 1);
  const replay = await share();
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual(await replay.json(), artifact);
  const forged = await share({ ...input, blobDigest: `sha256:${'f'.repeat(64)}`, receiptRef: 'browser-reported' });
  assert.equal(forged.status, 400);
  const foreign = await share(input, 'test-session=reader');
  assert.equal(foreign.status, 403, await foreign.text());
  const secret = JSON.stringify(artifact);
  for (const value of ['task-cover', 'thread-cover', '/uploads', 'sourcePublication', 'operator'])
    assert.equal(secret.includes(value), false);
});

test('Host reports an unavailable canonical owner separately from denied access', async (t) => {
  const f = await mediaRangeFixture(t);
  const host = await mediaHostFixture(t, f.directory);
  await f.f.store.revokeConnection({
    sessionToken: f.f.owner.sessionToken,
    collectiveId: f.f.coordinates.collectiveId,
    connectionId: f.f.connection.connectionId,
  });
  const response = await fetch(
    `${host.url}/api/plugins/official.collective-connector/connections/${f.connection.connectionId}/artifacts/${f.input.artifactId}/media/1?sourceEventId=${f.input.sourceEventId}`,
    { headers: { cookie: 'test-session=reader' } },
  );
  assert.equal(response.status, 503, await response.clone().text());
  assert.deepEqual(await response.json(), { error: 'owner_unavailable' });
});

test('Host registration context requires its direct local Human and discloses only exact public CAS', async (t) => {
  const f = await mediaRangeFixture(t);
  const host = await mediaHostFixture(t, join(f.f.media.root, 'connector'), f.f.media.port);
  const url = `${host.url}/api/plugins/official.collective-connector/connections/${f.f.connection.connectionId}/artifacts/share-media/context`;
  const input = { contentRef: f.f.artifact.contentRef, sourceEventId: f.f.source.eventId, mediaType: 'image/png' };
  const read = (body: unknown, headers: Record<string, string>) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5182', ...headers },
      body: JSON.stringify(body),
    });
  const publisher = { cookie: 'test-session=publisher' };
  const response = await read(input, publisher);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), {
    ...input,
    ...f.f.coordinates,
    connectionId: f.f.connection.connectionId,
    current: { revision: 1, custodyRevision: 1 },
  });
  for (const [headers, expected] of [
    [{}, 401],
    [{ cookie: 'test-session=reader' }, 403],
    [{ ...publisher, origin: 'https://foreign.invalid' }, 403],
    [{ 'x-invocation-id': 'borrowed-cat', 'x-callback-token': 'borrowed' }, 401],
  ] as const) {
    assert.equal((await read(input, headers)).status, expected);
  }
  assert.equal((await read({ ...input, mediaType: 'video/mp4' }, publisher)).status, 403);
  assert.equal((await read({ ...input, expectedRevision: 1 }, publisher)).status, 400);
  await f.f.store.revokeConnection({
    sessionToken: f.f.owner.sessionToken,
    collectiveId: f.f.coordinates.collectiveId,
    connectionId: f.f.connection.connectionId,
  });
  assert.equal((await read(input, publisher)).status, 403);
});
