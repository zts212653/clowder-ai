import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { CollectiveMarkdownOwner } from '../src/domains/collaborative-content/collective-artifact/markdown-owner.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { CollectiveConnector, startCollectiveServer } from './helpers/f202-collective-installed-business.js';
import { participationFixture } from './helpers/f202-collective-participation.fixture.js';

export async function collectiveArtifactOwnerFixture(
  t: { after(fn: () => Promise<unknown>): void },
  options: {
    verifyAgent?: (agent: { catId: string; sessionRef: string }) => Promise<boolean>;
    text?: string;
    additionalHostOrigins?: readonly string[];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'f290-real-owner-'));
  const serviceDirectory = join(root, 'service');
  const f = await participationFixture(serviceDirectory);
  const server = await startCollectiveServer({
    store: f.store,
    port: 0,
    allowedHostOrigins: ['http://localhost:5182', ...(options.additionalHostOrigins ?? [])],
  });
  let reviews: WorkspaceContentReviewStore | undefined;
  let modifications: ArtifactReviewStore | undefined;
  t.after(async () => {
    await server.close();
    reviews?.close();
    modifications?.close();
    await rm(root, { recursive: true, force: true });
  });
  const connector = await CollectiveConnector.open({
    dataDirectory: join(root, 'connector'),
    verifyAgent: options.verifyAgent ?? (async () => false),
  });
  const pairing = await f.store.createPairingIntent({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5182',
    nonce: 'owner-relay-pairing-nonce',
  });
  const connection = await connector.pair({
    serviceUrl: server.url,
    intent: pairing,
    endpointLabel: 'Canonical content Café',
  });
  await connector.setHostRoute(
    connection.connectionId,
    {
      localOwnerUserId: 'real-local-owner',
      defaultIngressThreadId: 'private-channel',
      humanNotificationThreadId: 'private-channel',
      agentRoutes: {},
    },
    0,
  );
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
    code: 'independent-member',
  });
  const member = await f.store.exchangeHumanAuthCompletion(complete.completionToken);
  const source = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'real-shared-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '一起改这份接入指南。',
  });
  const contentRef = 'collective-content:real-shared-guide';
  const artifactId = `artifact_${createHash('sha256')
    .update(JSON.stringify([f.coordinates.serviceInstanceId, f.coordinates.collectiveId, contentRef]))
    .digest('hex')}`;
  const scope = {
    kind: 'collective-artifact',
    ...f.coordinates,
    artifactId,
    contentRef,
    sourceEventId: source.eventId,
    publishedByHumanId: f.owner.human.humanId,
  } as const;
  const text = options.text ?? '# 接入指南\n\n这是一份共同阅读的真实正文。\n';
  const owner = new ProjectContentOwnerService({ dataDir: join(root, 'content-cafe') });
  reviews = new WorkspaceContentReviewStore(join(root, 'content-cafe', 'workspace-reviews.sqlite'));
  const receipt = await owner.importContent({
    contentRef,
    collectiveScope: scope,
    bytes: Buffer.from(text),
    mediaType: 'text/markdown',
    actor: { kind: 'human', actorId: f.owner.human.humanId },
    operationId: 'import-real-shared-guide',
    authorizeEffect: async () => {},
    operationContext: {
      kind: 'collective-artifact:publish',
      scopeRef: collectiveContentScopeRef(scope),
      actorHumanId: f.owner.human.humanId,
      requestDigest: `sha256:${'1'.repeat(64)}`,
      custodyRevision: 1,
      dispositionId: 'publish-guide',
    },
  });
  const artifact = await connector.registerArtifact(connection.connectionId, 'real-local-owner', {
    contentRef,
    title: '接入指南',
    mediaType: 'text/markdown',
    sourceEventId: source.eventId,
    ownerRevision: receipt.ownerRevision,
    blobDigest: receipt.blobDigest,
    receiptRef: receipt.receiptId,
    requestId: 'publish-guide',
  });
  modifications = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
  const port = new CollectiveMarkdownOwner({ owner, reviews, modifications, ownerUserId: 'real-local-owner' });
  connector.setArtifactOwner(port);
  let automaticSync = false;
  const request = async (
    token: string,
    action: string,
    payload: Record<string, unknown>,
    requestId: string,
    agent?: { connectionId: string; requestEventId: string; catId: string; participationRevision: number },
  ) => {
    let settled = false;
    let admitted = false;
    const waiting = fetch(`${server.url}/api/artifacts/${agent ? 'agent/request' : 'owner/request'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ...f.coordinates,
        artifactId,
        sourceEventId: source.eventId,
        action,
        payload,
        requestId,
        ...agent,
      }),
    }).then(async (response) => {
      settled = true;
      return { status: response.status, value: await response.json() };
    });
    // Read-only polling waits for actual server admission; it never fabricates an owner operation.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const persisted = await f.store.pollArtifactOperations(connectionCredential(), {
        ...f.coordinates,
        connectionId: connection.connectionId,
      });
      if (persisted.length) {
        admitted = true;
        break;
      }
      if (settled) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    if (admitted && !automaticSync) await connector.sync(connection.connectionId);
    return waiting;
  };
  // Test-only inspection of the private endpoint file; production only uses the Connector capability.
  let credential: string | undefined;
  const { readFile } = await import('node:fs/promises');
  const persisted = JSON.parse(await readFile(join(root, 'connector', 'collective-connector.json'), 'utf8')) as {
    connections: Record<string, { endpointCredential: string }>;
  };
  credential = persisted.connections[connection.connectionId]?.endpointCredential;
  function connectionCredential() {
    if (!credential) throw new Error('Expected private endpoint credential');
    return credential;
  }
  return {
    ...f,
    useBackgroundSync: () => {
      automaticSync = true;
    },
    root,
    server,
    connector,
    connection,
    member,
    contentOwner: owner,
    reviews,
    artifact,
    text,
    source,
    request,
    port,
    targetConnection: f.connection,
    modifications,
  };
}
