import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { collectiveMediaHttpFixture } from './collective-media-http.fixture.js';
import { mediaRangeFixture } from './collective-media-range.fixture.js';
import { CollectiveConnector, ConnectorTransportError, test } from './helpers/f202-collective-installed-business.js';

test('an independently paired reader Cafe receives the original exact PNG through the binary HTTP owner relay', async (t) => {
  const f = await collectiveMediaHttpFixture(t);
  const directory = join(f.media.root, 'reader-cafe');
  const reader = await CollectiveConnector.open({ dataDirectory: directory, verifyAgent: async () => false });
  const intent = await f.store.createPairingIntent({
    sessionToken: f.member.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5182',
    nonce: 'independent-media-reader',
  });
  const connection = await reader.pair({ serviceUrl: f.server.url, intent, endpointLabel: 'Independent reader Cafe' });
  await reader.setHostRoute(
    connection.connectionId,
    {
      localOwnerUserId: 'reader-private-human',
      defaultIngressThreadId: 'reader-private',
      humanNotificationThreadId: 'reader-private',
      agentRoutes: {},
    },
    0,
  );
  const state = JSON.parse(await readFile(join(directory, 'collective-connector.json'), 'utf8')) as {
    connections: Record<string, { endpointCredential: string }>;
  };
  const credential = state.connections[connection.connectionId]?.endpointCredential;
  assert.ok(credential);
  let done = false;
  const pending = fetch(`${f.server.url}/api/artifacts/media/read`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ...f.coordinates,
      connectionId: connection.connectionId,
      artifactId: f.artifact.artifactId,
      sourceEventId: f.source.eventId,
      ownerRevision: 1,
    }),
  })
    .then(async (response) => ({
      status: response.status,
      headers: response.headers,
      bytes: Buffer.from(await response.arrayBuffer()),
    }))
    .finally(() => {
      done = true;
    });
  for (let i = 0; i < 1000 && !done; i++) {
    await f.connector.sync(f.connection.connectionId);
    if (!done) await setTimeout(5);
  }
  assert.ok(done, 'binary reader and owner must complete without holding each other’s authority lock');
  const result = await pending;
  assert.equal(result.status, 200, result.bytes.toString().slice(0, 500));
  assert.deepEqual(result.bytes, f.media.bytes);
  assert.equal(result.headers.get('content-type'), 'image/png');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
});

for (const mime of ['image/png', 'video/mp4'])
  test(`the actual reader Connector receives exact ${mime} ranges and cannot turn its paired credential into Human write authority`, async (t) => {
    const r = await mediaRangeFixture(t, mime),
      { f } = r;
    const whole = await r.read();
    assert.deepEqual(whole.bytes, f.media.bytes);
    assert.equal(`sha256:${createHash('sha256').update(whole.bytes).digest('hex')}`, whole.descriptor.blobDigest);
    assert.equal(whole.descriptor.ownerReceiptRef, f.media.asset.ownerReceiptRef);
    const parts = [];
    for (const range of ['bytes=0-31', 'bytes=32-', 'bytes=-16']) {
      const result = await r.read(range);
      assert.equal(result.descriptor.status, 206);
      const { start, end } = result.descriptor;
      assert.ok(start !== undefined && end !== undefined);
      assert.deepEqual(result.bytes, f.media.bytes.subarray(start, end + 1));
      assert.equal(result.descriptor.byteLength, f.media.bytes.length);
      parts.push(result.bytes);
    }
    assert.deepEqual(Buffer.concat(parts.slice(0, 2)), whole.bytes);
    await f.restart();
    assert.deepEqual((await r.read('bytes=0-31')).bytes, f.media.bytes.subarray(0, 32));
    const invalid = await r.read('bytes=999999999-');
    assert.equal(invalid.descriptor.status, 416);
    assert.equal(invalid.bytes.length, 0);
    const cross = await f.post('media/read', r.credential, { ...r.coordinates, ...r.input, collectiveId: 'wrong' });
    assert.equal(cross.status, 409);
    const forge = await f.post('media/read', r.credential, {
      ...r.coordinates,
      ...r.input,
      action: 'annotate',
      humanId: f.owner.human.humanId,
    });
    assert.equal(forge.status, 400);
    const write = await f.post('owner/request', r.credential, {
      ...f.coordinates,
      ...r.input,
      action: 'annotate',
      requestId: 'endpoint-not-Human',
      payload: {
        kind: 'media-review',
        expectedReviewRevision: 1,
        action: { kind: 'annotate', body: 'forged', anchor: { kind: 'image-point', x: 1, y: 1 } },
      },
    });
    assert.notEqual(write.status, 200);
    await assert.rejects(
      r.reader.openArtifactMedia(
        r.connection.connectionId,
        'another-local-Human',
        r.input,
        new AbortController().signal,
      ),
      (error) => error instanceof ConnectorTransportError && error.statusCode === 403,
    );
    await f.store.updateArtifactAccess(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      humanId: f.member.human.humanId,
      expectedAccessRevision: 1,
      access: 'revoked',
      requestId: 'revoke-range-reader',
    });
    await assert.rejects(
      r.read('bytes=32-63'),
      (error) => error instanceof ConnectorTransportError && error.statusCode === 403,
    );
    const other = await f.invoke(f.owner.sessionToken, 'read', {}, 'other-reader-stays');
    assert.equal(other.status, 200);
  });

test('a source recall or a forged owner range descriptor never becomes a successful byte response', async (t) => {
  const r = await mediaRangeFixture(t),
    { f } = r;
  assert.equal(
    (await f.post('media/poll', r.credential, { ...f.coordinates, connectionId: f.connection.connectionId })).status,
    401,
  );
  assert.deepEqual((await f.post('media/poll', r.credential, r.coordinates)).value.operations, []);
  assert.equal((await f.post('media/read', f.member.sessionToken, { ...r.coordinates, ...r.input })).status, 401);
  const original = f.media.port;
  f.connector.setArtifactOwner({
    execute: original.execute.bind(original),
    media: {
      async read(...args) {
        const result = await original.media.read(...args);
        return result.status === 'ok'
          ? { ...result, descriptor: { ...result.descriptor, blobDigest: `sha256:${'0'.repeat(64)}` } }
          : result;
      },
    },
  });
  await assert.rejects(r.read(), (error) => error instanceof ConnectorTransportError && error.statusCode === 403);
  f.connector.setArtifactOwner(original);
  const source = f.media.messages.get(f.media.asset.sourcePublication.sourceRef.split(':').at(-1) ?? '');
  assert.ok(source);
  source.recall = { recalledAt: 9999, recalledBy: 'operator' };
  await assert.rejects(r.read(), (error) => error instanceof ConnectorTransportError && error.statusCode === 403);
});
