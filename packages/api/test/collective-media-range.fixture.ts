import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { collectiveMediaHttpFixture } from './collective-media-http.fixture.js';
import { CollectiveConnector } from './helpers/f202-collective-installed-business.js';

export async function mediaRangeFixture(t: { after(fn: () => Promise<unknown>): void }, mime = 'image/png') {
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  const f = await collectiveMediaHttpFixture({ after: (fn) => cleanup.push(fn) }, mime);
  const directory = join(f.media.root, 'reader-cafe');
  const reader = await CollectiveConnector.open({ dataDirectory: directory, verifyAgent: async () => false });
  cleanup.push(() => reader.stopMediaReads());
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
  const coordinates = { ...f.coordinates, connectionId: connection.connectionId };
  const input = { artifactId: f.artifact.artifactId, sourceEventId: f.source.eventId, ownerRevision: 1 };
  const drive = async <T>(pending: Promise<T>): Promise<T> => {
    let done = false;
    // Observe a rejection immediately while the actual Connector independently drains its outbound media jobs.
    const result = pending
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      )
      .finally(() => {
        done = true;
      });
    for (let tick = 0; tick < 1000 && !done; tick++) {
      await f.connector.sync(f.connection.connectionId);
      if (!done) await setTimeout(5);
    }
    assert.ok(done, 'Owner media transport must settle without holding the ordinary Connector authority lock');
    const settled = await result;
    if (!settled.ok) throw settled.error;
    return settled.value;
  };
  const read = async (range?: string, ownerRevision = 1) =>
    drive(
      (async () => {
        const opened = await reader.openArtifactMedia(
          connection.connectionId,
          'reader-private-human',
          { ...input, ownerRevision, ...(range === undefined ? {} : { range }) },
          new AbortController().signal,
        );
        const chunks: Buffer[] = [];
        for await (const chunk of opened.body) {
          assert.ok(Buffer.isBuffer(chunk));
          chunks.push(chunk);
        }
        return { descriptor: opened.descriptor, bytes: Buffer.concat(chunks) };
      })(),
    );
  return { f, reader, directory, connection, credential, coordinates, input, drive, read };
}
