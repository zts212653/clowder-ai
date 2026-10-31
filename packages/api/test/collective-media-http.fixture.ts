import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { ReviewedMediaAsset } from '@cat-cafe/shared';
import { publishedCollectiveFixture } from './collective-published-media.fixture.js';
import {
  CollectiveConnector,
  CollectiveServiceStore,
  startCollectiveServer,
} from './helpers/f202-collective-installed-business.js';
import { participationFixture } from './helpers/f202-collective-participation.fixture.js';

/** Two independent authenticated Service Humans; the retained owner still belongs to one private Host Human. */
export async function collectiveMediaHttpFixture(t: { after(fn: () => Promise<unknown>): void }, mime = 'image/png') {
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  const media = await publishedCollectiveFixture({ after: (fn) => cleanup.push(fn) }, mime);
  const serviceDirectory = join(media.root, 'service');
  const f = await participationFixture(serviceDirectory);
  let store = f.store;
  let server = await startCollectiveServer({ store, port: 0, allowedHostOrigins: ['http://localhost:5182'] });
  cleanup.push(() => server.close());
  const connectorDirectory = join(media.root, 'connector');
  let connector = await CollectiveConnector.open({ dataDirectory: connectorDirectory, verifyAgent: async () => false });
  const intent = await store.createPairingIntent({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5182',
    nonce: 'retained-media-owner-cafe',
  });
  const connection = await connector.pair({ serviceUrl: server.url, intent, endpointLabel: 'Retained media Cafe' });
  await connector.setHostRoute(
    connection.connectionId,
    {
      localOwnerUserId: 'operator',
      defaultIngressThreadId: 'private-original',
      humanNotificationThreadId: 'private-original',
      agentRoutes: {},
    },
    0,
  );
  connector.setArtifactOwner(media.port);
  cleanup.push(() => connector.stopMediaReads());
  const invite = await store.createInvite({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
  });
  const attempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const complete = await store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: 'media-independent-member',
  });
  const member = await store.exchangeHumanAuthCompletion(complete.completionToken);
  const source = await store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'original-media-discussion',
    body: '一起看这份已出版的作品。',
    recipient: { kind: 'channel' },
    location: { channelId: 'general' },
  });
  const artifactId = `artifact_${createHash('sha256')
    .update(JSON.stringify([f.coordinates.serviceInstanceId, f.coordinates.collectiveId, media.asset.contentRef]))
    .digest('hex')}`;
  const scope = { ...f.coordinates, artifactId, sourceEventId: source.eventId, custodyRevision: 1 };
  let catalogueRevision: number | undefined;
  const share = async (asset: ReviewedMediaAsset = media.asset) => {
    const admitted = await media.share(asset, scope);
    const result = await connector.registerArtifact(connection.connectionId, 'operator', {
      title: 'Shared retained media',
      contentRef: admitted.contentRef,
      mediaType: admitted.mediaType,
      sourceEventId: source.eventId,
      ownerRevision: admitted.ownerRevision,
      blobDigest: admitted.blobDigest,
      receiptRef: admitted.ownerReceiptRef,
      requestId: `share-retained-media-${admitted.ownerRevision}`,
      ...(catalogueRevision === undefined ? {} : { expectedRevision: catalogueRevision, expectedCustodyRevision: 1 }),
    });
    catalogueRevision = result.revision;
    return result;
  };
  const artifact = await share();
  const post = async (path: string, credential: string, body: unknown) => {
    const response = await fetch(`${server.url}/api/artifacts/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  const invoke = async (
    token: string,
    action: string,
    payload: Record<string, unknown>,
    requestId: string,
    ownerRevision?: number,
  ) => {
    let done = false;
    const pending = post('owner/request', token, {
      ...f.coordinates,
      artifactId,
      sourceEventId: source.eventId,
      action,
      payload,
      requestId,
      ...(ownerRevision === undefined ? {} : { ownerRevision }),
    }).finally(() => {
      done = true;
    });
    const errors: unknown[] = [];
    for (let tick = 0; tick < 300 && !done; tick++) {
      await connector.sync(connection.connectionId).catch((error) => errors.push(error));
      if (!done) await setTimeout(5);
    }
    if (!done) store.stopArtifactOwnerRelay();
    assert.ok(done, errors.map(String).join('\n'));
    return pending;
  };
  const state = JSON.parse(await readFile(join(connectorDirectory, 'collective-connector.json'), 'utf8')) as {
    connections: Record<string, { endpointCredential: string }>;
  };
  const credential = state.connections[connection.connectionId]?.endpointCredential;
  assert.ok(credential);
  return {
    ...f,
    media,
    member,
    source,
    scope,
    artifact,
    connection,
    connectorDirectory,
    serviceDirectory,
    get store() {
      return store;
    },
    get server() {
      return server;
    },
    get connector() {
      return connector;
    },
    credential,
    post,
    invoke,
    share,
    async restart() {
      await connector.stopMediaReads();
      const port = Number(new URL(server.url).port);
      await server.close();
      store = (
        await CollectiveServiceStore.open({ dataDirectory: serviceDirectory, humanAuthProvider: f.humanAuthProvider })
      ).store;
      server = await startCollectiveServer({ store, port, allowedHostOrigins: ['http://localhost:5182'] });
      media.reopen();
      connector = await CollectiveConnector.open({ dataDirectory: connectorDirectory, verifyAgent: async () => false });
      connector.setArtifactOwner(media.port);
    },
  };
}
