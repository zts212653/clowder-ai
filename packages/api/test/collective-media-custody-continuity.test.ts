import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { collectiveMediaHttpFixture } from './collective-media-http.fixture.js';
import { CollectiveConnector, test } from './helpers/f202-collective-installed-business.js';

test('the same retained owner explicitly rebinds after revoke and restart while the old endpoint stays fenced', async (t) => {
  const f = await collectiveMediaHttpFixture(t);
  const oldDecision = f.store.issueArtifactConstraint(f.member.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
  });
  await f.store.revokeConnection({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    connectionId: f.connection.connectionId,
  });
  await f.connector.sync(f.connection.connectionId);
  const connector = await CollectiveConnector.open({
    dataDirectory: f.connectorDirectory,
    verifyAgent: async () => false,
  });
  const intent = await f.store.createPairingIntent({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5182',
    nonce: 'same-owner-continuity',
  });
  const paired = await connector.pair({ serviceUrl: f.server.url, intent, endpointLabel: 'Repaired same Cafe' });
  await connector.setHostRoute(
    paired.connectionId,
    {
      localOwnerUserId: 'operator',
      defaultIngressThreadId: 'private-original',
      humanNotificationThreadId: 'private-original',
      agentRoutes: {},
    },
    0,
  );
  connector.setArtifactOwner(f.media.port);
  // The existing explicit share action verifies the retained canonical asset under the local Human session again.
  const asset = await f.media.share(f.media.asset, f.scope);
  const input = {
    contentRef: asset.contentRef,
    mediaType: asset.mediaType,
    title: 'Shared retained media',
    sourceEventId: f.source.eventId,
    ownerRevision: asset.ownerRevision,
    blobDigest: asset.blobDigest,
    receiptRef: asset.ownerReceiptRef,
    requestId: 'same-canonical-media-rebind',
  };
  const privateState = JSON.parse(await readFile(join(f.connectorDirectory, 'collective-connector.json'), 'utf8')) as {
    connections: Record<string, { endpointCredential?: string; custodyRecoveryCredential?: string }>;
  };
  const credential = privateState.connections[paired.connectionId]?.endpointCredential;
  const proof = privateState.connections[f.connection.connectionId]?.custodyRecoveryCredential;
  assert.ok(credential);
  assert.ok(proof);
  assert.equal(
    JSON.stringify(privateState).includes(f.credential),
    false,
    'revocation erases the ordinary endpoint token',
  );
  const recovery = { ...f.coordinates, connectionId: paired.connectionId, ...input };
  assert.equal((await f.post('media/continuity', credential, recovery)).value.status, 'proof_required');
  assert.equal(f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0]?.availability, 'owner_unavailable');
  assert.equal(
    (
      await f.post('media/continuity', credential, {
        ...recovery,
        previousConnectionId: f.connection.connectionId,
        previousCustodyProof: 'f'.repeat(64),
      })
    ).status,
    403,
  );
  const foreignIntent = await f.store.createPairingIntent({
    sessionToken: f.member.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5182',
    nonce: 'foreign-continuity-proof',
  });
  const foreign = await f.store.exchangePairingIntent({ ...foreignIntent, endpointLabel: 'Another Human' });
  assert.equal(
    (
      await f.post('media/continuity', foreign.endpointCredential, {
        ...recovery,
        connectionId: foreign.connectionId,
        previousConnectionId: f.connection.connectionId,
        previousCustodyProof: proof,
      })
    ).status,
    403,
  );
  const rebound = await connector.registerArtifact(paired.connectionId, 'operator', input);
  assert.equal(rebound.artifactId, f.artifact.artifactId);
  assert.equal(rebound.versions.length, 1, 'rebind is not another content version');
  assert.deepEqual(await connector.registerArtifact(paired.connectionId, 'operator', input), rebound);
  assert.equal(
    (
      await f.post('constraints/validate', credential, {
        ...f.coordinates,
        connectionId: paired.connectionId,
        artifactId: f.artifact.artifactId,
        sourceEventId: f.source.eventId,
        action: 'read',
        decisionRef: oldDecision.decisionRef,
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.post('media/poll', f.credential, { ...f.coordinates, connectionId: f.connection.connectionId })).status,
    401,
  );
  const serviceState = await readFile(join(f.serviceDirectory, 'collective-service.json'), 'utf8');
  assert.equal(serviceState.includes(proof), false, 'the narrow source proof must never enter Service state');
  assert.equal(
    serviceState.includes(f.credential),
    false,
    'a continuity secret must never enter the Service operation fingerprint',
  );
  await f.restart();
  let done = false;
  const reading = f.connector
    .openArtifactMedia(
      paired.connectionId,
      'operator',
      { artifactId: rebound.artifactId, sourceEventId: f.source.eventId, ownerRevision: 1 },
      new AbortController().signal,
    )
    .then(async (opened) => {
      const chunks: Buffer[] = [];
      for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    })
    .finally(() => {
      done = true;
    });
  for (let tick = 0; tick < 300 && !done; tick++) {
    await f.connector.sync(paired.connectionId);
    await setTimeout(5);
  }
  assert.ok(done, 'rebound media must be readable after both owners restart');
  assert.deepEqual(await reading, f.media.bytes);
});
