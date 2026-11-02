import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCollectiveMessageAttachmentOwner } from '../../../api/src/domains/collaborative-content/collective-artifact/message-attachment-owner.ts';
import { ProjectContentOwnerService } from '../../../api/src/domains/video-studio/content-owner/service.ts';

/** Real Service + original byte custodian + compiled Client. OAuth identities are explicitly test fixtures. */
export async function expressionFixture({ port = 0, allowedHostOrigins = [], materialSource } = {}) {
  if (!process.env.F290_PLUGIN_ROOT) throw new Error('F290_PLUGIN_ROOT must name the tested plugin checkout');
  const installedPackage = process.env.F290_PLUGIN_PACKAGE_ROOT;
  const packageRoot = installedPackage
    ? resolve(installedPackage)
    : resolve(process.env.F290_PLUGIN_ROOT, 'packages/collective-connector');
  const load = (path) => import(pathToFileURL(join(packageRoot, 'dist', path)).href);
  const { CollectiveServiceStore } = await load('business/service/store.js');
  const { startCollectiveServer } = await load('business/service/http-server.js');
  const { loadCollectiveClient } = await load('client-assets.js');
  const clientRoot = installedPackage
    ? join(packageRoot, 'assets/client')
    : resolve(fileURLToPath(new URL('../../../collective-client/dist/', import.meta.url)));
  if (installedPackage) {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@clowder-ai/collective-connector');
    const source = JSON.parse(await readFile(join(clientRoot, 'source.json'), 'utf8'));
    assert.ok(process.env.F290_EXPECTED_CLIENT_SOURCE, 'Packaged journeys require the exact paired Client source');
    assert.equal(source.sourceBaseHead, process.env.F290_EXPECTED_CLIENT_SOURCE);
    assert.equal(source.sourceState, 'exact-source-head');
    process.stdout.write(
      `F290 packaged consumer: ${manifest.version}, Client source ${source.sourceBaseHead}, assets ${source.assetDigest}\n`,
    );
  }
  const client = await loadCollectiveClient(pathToFileURL(clientRoot + '/'));
  const directory = await mkdtemp(join(tmpdir(), 'f290-expression-real-service-'));
  const dataDirectory = join(directory, 'service');
  const owner = new ProjectContentOwnerService({ dataDir: join(directory, 'content') });
  const messageAttachmentOwner = createCollectiveMessageAttachmentOwner(owner, {
    stickerDirectories: {
      memory: fileURLToPath(new URL('../../../web/public/f321/stickers/', import.meta.url)),
      collaboration: fileURLToPath(
        new URL('../../../../docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration/', import.meta.url),
      ),
    },
  });
  const humanAuthProvider = {
    id: 'github',
    readiness: { ready: true },
    authorizationUrl: ({ state }) => `https://fixture.invalid/?state=${state}`,
    authenticate: async ({ code }) => ({ providerSubject: code, handle: code, displayName: code }),
  };
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider,
    messageAttachmentOwner,
    materialSource,
  });
  let store = opened.store;
  let server = await startCollectiveServer({ store, port, clientAssets: client.files, allowedHostOrigins });
  const creator = await store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: '测试成员 A' });
  const bind = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: creator.sessionToken,
  });
  await store.exchangeHumanAuthCompletion(
    (await store.completeHumanAuth({ provider: 'github', state: bind.state, code: '测试成员 A' })).completionToken,
  );
  const collective = await store.createCollective({ sessionToken: creator.sessionToken, name: '频道表达测试' });
  const invite = await store.createInvite({
    sessionToken: creator.sessionToken,
    collectiveId: collective.collectiveId,
  });
  const joinAttempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const member = await store.exchangeHumanAuthCompletion(
    (await store.completeHumanAuth({ provider: 'github', state: joinAttempt.state, code: '测试成员 B' }))
      .completionToken,
  );
  const coordinates = { serviceInstanceId: store.serviceInstanceId, collectiveId: collective.collectiveId };
  return {
    directory,
    coordinates,
    creator,
    member,
    get url() {
      return server.url;
    },
    get store() {
      return store;
    },
    async restart() {
      const previousPort = server.port;
      await server.close();
      store = (
        await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider, messageAttachmentOwner, materialSource })
      ).store;
      server = await startCollectiveServer({
        store,
        port: previousPort,
        clientAssets: client.files,
        allowedHostOrigins,
      });
    },
    async close() {
      await server.close();
      await rm(directory, { recursive: true });
    },
  };
}
