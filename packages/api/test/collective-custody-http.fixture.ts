import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { CollectiveMarkdownOwner } from '../src/domains/collaborative-content/collective-artifact/markdown-owner.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { collectiveArtifactOwnerFixture } from './collective-artifact-owner.fixture.js';
import { emptyCustodyOwner } from './collective-custody-transfer.fixture.js';
import {
  CollectiveConnector,
  CollectiveServiceStore,
  startCollectiveServer,
} from './helpers/f202-collective-installed-business.js';

export async function custodyHttpFixture(
  t: { after(fn: () => Promise<unknown>): void },
  fetchImpl?: typeof fetch,
  options: { text?: string } = {},
) {
  const cleanup: Array<() => Promise<unknown>> = [];
  const register = {
    after(fn: () => Promise<unknown>) {
      cleanup.push(fn);
    },
  };
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  const f = await collectiveArtifactOwnerFixture(register, options);
  const destination = await emptyCustodyOwner(register);
  let sourceRoot = new CollectiveMarkdownOwner({
    owner: f.contentOwner,
    reviews: f.reviews,
    modifications: f.modifications,
    ownerUserId: 'real-local-owner',
    custodyDataDir: join(f.root, 'content-cafe'),
  });
  let sourceConnector = f.connector;
  sourceConnector.setArtifactOwner(sourceRoot);
  const targetDirectory = join(f.root, 'target-connector');
  let targetConnector = await CollectiveConnector.open({
    dataDirectory: targetDirectory,
    verifyAgent: async () => false,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const intent = await f.store.createPairingIntent({
    sessionToken: f.member.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5182',
    nonce: 'actual-transfer-target',
  });
  const target = await targetConnector.pair({ serviceUrl: f.server.url, intent, endpointLabel: 'Destination Cafe' });
  await targetConnector.setHostRoute(
    target.connectionId,
    {
      localOwnerUserId: 'destination-real-local-owner',
      defaultIngressThreadId: 'private-destination',
      humanNotificationThreadId: 'private-destination',
      agentRoutes: {},
    },
    0,
  );
  targetConnector.setArtifactOwner(destination.current.root);
  const credentialAt = async (directory: string, connectionId: string) => {
    const state = JSON.parse(await readFile(join(directory, 'collective-connector.json'), 'utf8'));
    return state.connections[connectionId].endpointCredential as string;
  };
  const sourceCredential = await credentialAt(join(f.root, 'connector'), f.connection.connectionId);
  const targetCredential = await credentialAt(targetDirectory, target.connectionId);
  const errors: unknown[] = [];
  // Pump the actual production Connector with one outstanding sync per Cafe, independently of remote RPC latency.
  const drive = async (done: () => boolean) => {
    const active = new Map<string, Promise<unknown>>();
    try {
      for (let attempt = 0; attempt < 1500 && !done(); attempt++) {
        for (const [connector, connection] of [
          [sourceConnector, f.connection],
          [targetConnector, target],
        ] as const) {
          if (active.has(connection.connectionId)) continue;
          const job = connector
            .sync(connection.connectionId)
            .catch((error) => {
              errors.push(error);
            })
            .finally(() => {
              active.delete(connection.connectionId);
            });
          active.set(connection.connectionId, job);
        }
        await setTimeout(10);
      }
      assert.ok(done(), errors.map(String).slice(-5).join('\n'));
    } catch (error) {
      f.store.stopArtifactOwnerRelay();
      throw error;
    } finally {
      await Promise.allSettled(active.values());
    }
  };
  const post = async (path: string, credential: string, body: unknown) => {
    const response = await fetch(`${f.server.url}/api/artifacts/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  const invoke = async (
    credential: string,
    action: string,
    payload: Record<string, unknown>,
    requestId: string,
    agent?: { connectionId: string; requestEventId: string; catId: string; participationRevision: number },
    ownerRevision?: number,
  ) => {
    let done = false;
    const pending = post(agent ? 'agent/request' : 'owner/request', credential, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      sourceEventId: f.source.eventId,
      action,
      payload,
      requestId,
      ...agent,
      ...(ownerRevision === undefined ? {} : { ownerRevision }),
    }).finally(() => {
      done = true;
    });
    await drive(() => done);
    return pending;
  };
  return {
    ...f,
    destination,
    target,
    get sourceRoot() {
      return sourceRoot;
    },
    get connector() {
      return sourceConnector;
    },
    get targetConnector() {
      return targetConnector;
    },
    get store() {
      return f.store;
    },
    get server() {
      return f.server;
    },
    get contentOwner() {
      return f.contentOwner;
    },
    sourceCredential,
    targetCredential,
    drive,
    post,
    invoke,
    targetDirectory,
    async restartSource() {
      f.reviews.close();
      f.modifications.close();
      f.reviews = new WorkspaceContentReviewStore(join(f.root, 'content-cafe', 'workspace-reviews.sqlite'));
      f.modifications = new ArtifactReviewStore(join(f.root, 'artifact-reviews.sqlite'));
      const reviews = f.reviews;
      const modifications = f.modifications;
      cleanup.push(async () => {
        reviews.close();
        modifications.close();
      });
      f.contentOwner = new ProjectContentOwnerService({ dataDir: join(f.root, 'content-cafe') });
      sourceRoot = new CollectiveMarkdownOwner({
        owner: f.contentOwner,
        reviews,
        modifications,
        ownerUserId: 'real-local-owner',
        custodyDataDir: join(f.root, 'content-cafe'),
      });
      sourceConnector = await CollectiveConnector.open({
        dataDirectory: join(f.root, 'connector'),
        verifyAgent: async () => false,
      });
      sourceConnector.setArtifactOwner(sourceRoot);
    },
    async restartService() {
      const port = Number(new URL(f.server.url).port);
      await f.server.close();
      const opened = await CollectiveServiceStore.open({
        dataDirectory: join(f.root, 'service'),
        humanAuthProvider: f.humanAuthProvider,
      });
      f.store = opened.store;
      f.server = await startCollectiveServer({ store: f.store, port, allowedHostOrigins: ['http://localhost:5182'] });
      const server = f.server;
      cleanup.push(() => server.close());
    },
    async restartTarget() {
      destination.reopen();
      targetConnector = await CollectiveConnector.open({
        dataDirectory: targetDirectory,
        verifyAgent: async () => false,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      targetConnector.setArtifactOwner(destination.current.root);
    },
  };
}
