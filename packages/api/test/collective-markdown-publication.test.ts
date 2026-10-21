import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectiveArtifactOwnerFixture } from './collective-artifact-owner.fixture.js';
import {
  CollectiveConnector,
  CollectiveServiceStore,
  ConnectorTransportError,
  test,
} from './helpers/f202-collective-installed-business.js';

async function finishUpload(
  f: Awaited<ReturnType<typeof collectiveArtifactOwnerFixture>>,
  publicationId: string,
  bytes: Buffer,
) {
  let finished = false;
  const waiting = fetch(`${f.server.url}/api/artifacts/publications/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.owner.sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ publicationId, bytesBase64: bytes.toString('base64') }),
  }).then(async (response) => {
    finished = true;
    return { status: response.status, value: await response.json() };
  });
  for (let attempt = 0; attempt < 50 && !finished; attempt += 1) {
    try {
      await f.connector.sync(f.connection.connectionId);
    } catch (error) {
      if (!(error instanceof ConnectorTransportError) || error.code !== 'CONNECTION_REVOKED') throw error;
    }
    if (!finished) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!finished) f.store.stopArtifactOwnerRelay();
  return waiting;
}

test('real authenticated Markdown publication reaches the canonical owner and recovers one catalogue entry after restart', async (t) => {
  const f = await collectiveArtifactOwnerFixture(t);
  const bytes = Buffer.from('# 一起写的正文\n正文只留在内容 owner。\n');
  const input = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    sourceEventId: f.source.eventId,
    requestId: 'real-browser-publication',
    title: '一起写的正文',
    blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  const post = async (path: string, token: string, body: unknown) => {
    const response = await fetch(`${f.server.url}/api/artifacts/publications/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await post('prepare', f.member.sessionToken, input)).status, 403);
  const prepared = await post('prepare', f.owner.sessionToken, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared));
  const upload = { publicationId: prepared.value.publication.publicationId, bytesBase64: bytes.toString('base64') };
  assert.equal(
    (await post('send', f.owner.sessionToken, { ...upload, bytesBase64: Buffer.from('different').toString('base64') }))
      .status,
    400,
  );
  let finished = false;
  const uploading = post('send', f.owner.sessionToken, upload).then((result) => {
    finished = true;
    return result;
  });
  for (let attempt = 0; attempt < 50 && !finished; attempt += 1) {
    await f.connector.sync(f.connection.connectionId);
    if (!finished) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!finished) f.store.stopArtifactOwnerRelay();
  const published = await uploading;
  assert.equal(published.status, 201, JSON.stringify(published));
  const artifact = published.value.publication.artifact;
  assert.equal(artifact.sourceEventId, f.source.eventId);
  assert.equal(artifact.publishedByHumanId, f.owner.human.humanId);
  assert.equal(artifact.versions[0].blobDigest, input.blobDigest);
  assert.equal((await f.contentOwner.describe(artifact.contentRef)).currentOwnerRevision, 1);
  assert.deepEqual(await post('send', f.owner.sessionToken, upload), published);
  const record = f.store
    .listArtifacts(f.member.sessionToken, f.coordinates)
    .find((item) => item.artifactId === artifact.artifactId);
  assert.deepEqual(record?.versions, artifact.versions);
  const persisted = await readFile(join(f.root, 'service', 'collective-service.json'), 'utf8');
  assert.equal(persisted.includes(bytes.toString()), false);
  assert.equal(persisted.includes(upload.bytesBase64), false);
  assert.equal(persisted.includes('relayRef'), false);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: join(f.root, 'service'),
    humanAuthProvider: f.humanAuthProvider,
  });
  assert.deepEqual(
    await reopened.store.prepareArtifactPublication(f.owner.sessionToken, input),
    published.value.publication,
  );
  assert.equal(JSON.stringify(published.value).includes('real-local-owner'), false);
});

test('a lost browser reply still records the same 64KiB publication and retries without another owner version', async (t) => {
  const f = await collectiveArtifactOwnerFixture(t);
  const bytes = Buffer.concat([Buffer.from('# Control character envelope\n'), Buffer.alloc(65536 - 29, 1)]);
  assert.equal(bytes.length, 65536);
  const input = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    sourceEventId: f.source.eventId,
    requestId: 'lost-publication-reply',
    title: '完整边界',
    blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  const prepared = await f.store.prepareArtifactPublication(f.owner.sessionToken, input);
  let dropped = false;
  f.connector.setArtifactOwner({
    execute: (...args) => f.port.execute(...args),
    async publish(operation, authority) {
      const result = await f.port.publish(operation, authority);
      if (!dropped) {
        dropped = true;
        f.store.stopArtifactOwnerRelay();
        f.store.startArtifactOwnerRelay();
      }
      return result;
    },
  });
  assert.equal((await finishUpload(f, prepared.publicationId, bytes)).status, 503);
  assert.equal(
    f.store.listArtifacts(f.owner.sessionToken, f.coordinates).some((item) => item.artifactId === prepared.artifactId),
    true,
  );
  const published = await finishUpload(f, prepared.publicationId, bytes);
  assert.equal(published.status, 201, JSON.stringify(published));
  assert.equal((await f.contentOwner.listOutbox(prepared.contentRef)).length, 1);
  assert.deepEqual((await f.contentOwner.load(prepared.contentRef)).bytes, bytes);
  const persisted = await readFile(join(f.root, 'service', 'collective-service.json'), 'utf8');
  assert.equal(persisted.includes(bytes.toString('base64')), false);
  assert.equal(persisted.includes('bytesBase64'), false);
});

test('an admitted publication blocks custody revoke, and fresh denial leaves no owner effect', async (t) => {
  const f = await collectiveArtifactOwnerFixture(t);
  const bytes = Buffer.from('# Removed before the commit');
  const prepared = await f.store.prepareArtifactPublication(f.owner.sessionToken, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    sourceEventId: f.source.eventId,
    requestId: 'revoked-publication',
    title: '未发布',
    blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  let checks = 0;
  f.connector.setArtifactOwner({
    execute: (...args) => f.port.execute(...args),
    recoverPublication: (publication) => f.port.recoverPublication(publication),
    async publish(operation, authority) {
      return f.port.publish(operation, {
        reauthorize: async () => {
          checks += 1;
          if (checks === 3) {
            await assert.rejects(
              f.store.revokeConnection({
                sessionToken: f.owner.sessionToken,
                collectiveId: f.coordinates.collectiveId,
                connectionId: f.connection.connectionId,
              }),
              { code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED' },
            );
            throw new ConnectorTransportError('Fresh publication authority withdrawn', 403);
          }
          return authority.reauthorize();
        },
      });
    },
  });
  assert.equal((await finishUpload(f, prepared.publicationId, bytes)).status, 403);
  assert.equal(checks, 3);
  await assert.rejects(f.contentOwner.load(prepared.contentRef), { code: 'CONTENT_NOT_FOUND' });
  assert.equal(
    f.store.listArtifacts(f.member.sessionToken, f.coordinates).some((item) => item.artifactId === prepared.artifactId),
    false,
  );
  const retry = await f.store.prepareArtifactPublication(f.owner.sessionToken, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    sourceEventId: f.source.eventId,
    requestId: 'revoked-publication',
    title: '未发布',
    blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  assert.equal(retry.status, 'pending');
});

test('a committed publication recovers from the canonical receipt after Connector restart without uploading bytes again', async (t) => {
  const f = await collectiveArtifactOwnerFixture(t);
  const bytes = Buffer.from('# A committed effect must remain visible');
  const prepared = await f.store.prepareArtifactPublication(f.owner.sessionToken, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    sourceEventId: f.source.eventId,
    requestId: 'committed-response-lost',
    title: '可恢复的分享',
    blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  f.connector.setArtifactOwner({
    execute: (...args) => f.port.execute(...args),
    async publish(operation, authority) {
      await f.port.publish(operation, authority);
      f.store.stopArtifactOwnerRelay();
      throw new Error('Host stopped after canonical commit, before receipt delivery');
    },
  });
  assert.equal((await finishUpload(f, prepared.publicationId, bytes)).status, 503);
  assert.equal((await f.contentOwner.describe(prepared.contentRef)).currentOwnerRevision, 1);
  f.store.startArtifactOwnerRelay();
  const restarted = await CollectiveConnector.open({
    dataDirectory: join(f.root, 'connector'),
    verifyAgent: async () => false,
  });
  restarted.setArtifactOwner(f.port);
  await restarted.sync(f.connection.connectionId);
  const artifact = f.store
    .listArtifacts(f.member.sessionToken, f.coordinates)
    .find((item) => item.artifactId === prepared.artifactId);
  assert.ok(artifact, 'the already committed owner receipt must recover its canonical catalogue entry');
  assert.equal(artifact.versions[0]?.receiptRef, (await f.contentOwner.listOutbox(prepared.contentRef))[0]?.receiptId);
  assert.equal((await f.contentOwner.listOutbox(prepared.contentRef)).length, 1);
  const saved = await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8');
  assert.equal(saved.includes(bytes.toString('base64')), false);
  assert.equal(saved.includes('bytesBase64'), false);
});

test('a refused local disconnect restores the original active Connector so custody can still be handed off', async (t) => {
  const f = await collectiveArtifactOwnerFixture(t);
  await assert.rejects(
    f.connector.revoke(f.connection.connectionId),
    (error) => error instanceof ConnectorTransportError && error.causeCode === 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED',
  );
  assert.equal((await f.connector.getProjection(f.connection.connectionId)).authorityStatus, 'connected');
  assert.equal((await f.connector.sync(f.connection.connectionId)).liveStatus, 'online');
  assert.equal(
    (await f.request(f.member.sessionToken, 'read', {}, 'still-reachable-after-refused-disconnect')).status,
    200,
  );
});
