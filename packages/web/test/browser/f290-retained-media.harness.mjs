import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CollectiveConnector } from '@cat-cafe/collective-connector';
import sharp from 'sharp';
import { mediaHostFixture } from '../../../api/test/collective-media-host.fixture.ts';
import { publishedCollectiveFixture } from '../../../api/test/collective-published-media.fixture.ts';
import { reviewCat } from '../../../api/test/helpers/artifact-review-fixture.ts';
import { participationFixture } from '../../../collective-service/src/__tests__/participation-fixture.ts';
import { startCollectiveServer } from '../../../collective-service/src/index.ts';

/** Real retained owner, Service authentication, two Cafe directories and normal API routes. No pre-shared directory tuple. */
export async function retainedMediaBrowserFixture(mime, hostOrigin) {
  const cleanup = [];
  const hooks = { after: (fn) => cleanup.push(fn) };
  const media = await publishedCollectiveFixture(hooks, mime);
  const f = await participationFixture(join(media.root, 'service'));
  const server = await startCollectiveServer({ store: f.store, port: 0, allowedHostOrigins: [hostOrigin] });
  cleanup.push(() => server.close());
  const invite = await f.store.createInvite({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
  });
  const attempt = await f.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const complete = await f.store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: 'independent-media-reader',
  });
  const member = await f.store.exchangeHumanAuthCompletion(complete.completionToken);
  const cafes = [];
  for (const [auth, localHuman, name] of [
    [f.owner, 'operator', '原作者 Café'],
    [member, 'reader-private-human', '独立成员 Café'],
  ]) {
    const directory = join(media.root, name);
    const connector = await CollectiveConnector.open({ dataDirectory: directory, verifyAgent: async () => false });
    cleanup.push(() => connector.stopMediaReads());
    const intent = await f.store.createPairingIntent({
      sessionToken: auth.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      hostOrigin,
      nonce: crypto.randomUUID(),
    });
    const connection = await connector.pair({ serviceUrl: server.url, intent, endpointLabel: name });
    await connector.setHostRoute(
      connection.connectionId,
      {
        localOwnerUserId: localHuman,
        defaultIngressThreadId: `${name}-private`,
        humanNotificationThreadId: `${name}-private`,
        agentRoutes: {},
      },
      0,
    );
    cafes.push({ connector, connection, directory, auth });
  }
  cafes[0].connector.setArtifactOwner(media.port);
  const source = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: crypto.randomUUID(),
    body: '请一起看这件作品，所有讨论都留在这里。',
    recipient: { kind: 'channel' },
    location: { channelId: 'general' },
  });
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await cafes[0].connector.sync(cafes[0].connection.connectionId);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  let host;
  let closeHost = [];
  return {
    ...f,
    server,
    media,
    member,
    cafes,
    source,
    // The original F138 producer publishes a new retained version; the public viewer never edits or adopts media.
    async publishNextRetainedVersion() {
      const filename = mime === 'video/mp4' ? 'blue.mp4' : 'blue.png';
      const path = join(media.uploads, filename);
      if (mime === 'video/mp4') {
        await promisify(execFile)(
          'ffmpeg',
          [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=c=blue:s=160x96:r=24:d=1',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            path,
          ],
          { timeout: 15000 },
        );
      } else {
        await writeFile(
          path,
          await sharp({
            create: {
              width: 160,
              height: 100,
              channels: 3,
              background: 'blue',
            },
          })
            .png()
            .toBuffer(),
        );
      }
      const artifactRef = `/uploads/${filename}`;
      const publication = media.publish(artifactRef, mime);
      media.task.current.entrustedWork.artifactRefs.push(artifactRef);
      return media.media.publishVersion({
        ...media.prepare,
        principal: reviewCat,
        contentRef: media.asset.contentRef,
        expectedOwnerRevision: 1,
        artifactRef,
        expectedArtifactRevision: String(publication.timestamp),
        operationId: 'retained-browser-private-v2',
      });
    },
    async openHost(index, port) {
      for (const close of closeHost.reverse()) await close();
      closeHost = [];
      host = await mediaHostFixture(
        { after: (fn) => closeHost.push(fn) },
        cafes[index].directory,
        index === 0 ? media.port : undefined,
        { port, hostOrigin, connector: cafes[index].connector },
      );
      return host;
    },
    async reopenRetainedOwner() {
      await cafes[0].connector.stopMediaReads();
      media.reopen();
      cafes[0].connector.setArtifactOwner(media.port);
    },
    async close() {
      for (const close of closeHost.reverse()) await close();
      stopped = true;
      await loop;
      for (const close of cleanup.reverse()) await close();
    },
  };
}
