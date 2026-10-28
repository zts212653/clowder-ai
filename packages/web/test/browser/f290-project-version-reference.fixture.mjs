import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArtifactReviewStore } from '../../../api/src/domains/collaborative-content/artifact-review/store.ts';
import { CollectiveMarkdownOwner } from '../../../api/src/domains/collaborative-content/collective-artifact/markdown-owner.ts';
import { WorkspaceContentReviewStore } from '../../../api/src/domains/collaborative-content/workspace-review/store.ts';
import { collectiveContentScopeRef } from '../../../api/src/domains/video-studio/content-owner/collective-scope.ts';
import { ProjectContentOwnerService } from '../../../api/src/domains/video-studio/content-owner/service.ts';
import { expressionFixture } from './f290-expression.fixture.mjs';

/** Real Service, Connector and F309 byte owner. Only Human authentication is a declared fixture provider. */
export async function projectVersionFixture(options = {}) {
  const allowedHostOrigins = options.allowedHostOrigins ?? ['http://localhost:5182'];
  const f = await expressionFixture({ ...options, allowedHostOrigins });
  try {
    const packageRoot =
      process.env.F290_PLUGIN_PACKAGE_ROOT ?? resolve(process.env.F290_PLUGIN_ROOT, 'packages/collective-connector');
    const { CollectiveConnector } = await import(
      pathToFileURL(join(packageRoot, 'dist/business/connector/connector.js')).href
    );
    const connector = await CollectiveConnector.open({
      dataDirectory: join(f.directory, 'connector'),
      verifyAgent: async () => false,
    });
    const pair = await f.store.createPairingIntent({
      sessionToken: f.creator.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      hostOrigin: allowedHostOrigins[0],
      nonce: 'project-version-owner-pair',
    });
    const connection = await connector.pair({
      serviceUrl: f.url,
      intent: pair,
      endpointLabel: 'Original content Café',
    });
    await connector.setHostRoute(
      connection.connectionId,
      {
        localOwnerUserId: 'f290-version-owner',
        defaultIngressThreadId: 'fixture-private',
        humanNotificationThreadId: 'fixture-private',
        agentRoutes: {},
      },
      0,
    );
    const source = await f.store.postHumanMessage(f.creator.sessionToken, {
      ...f.coordinates,
      clientEventId: 'version-source',
      location: { channelId: 'general' },
      recipient: { kind: 'channel' },
      body: '同一份插件接入指南，保留每一版的正文。',
    });
    const contentRef = 'collective-content:project-version-guide';
    const artifactId = `artifact_${createHash('sha256')
      .update(JSON.stringify([f.coordinates.serviceInstanceId, f.coordinates.collectiveId, contentRef]))
      .digest('hex')}`;
    const scope = {
      kind: 'collective-artifact',
      ...f.coordinates,
      artifactId,
      contentRef,
      sourceEventId: source.eventId,
      publishedByHumanId: f.creator.human.humanId,
    };
    let owner = new ProjectContentOwnerService({ dataDir: join(f.directory, 'original-guide-owner') });
    let reviews = new WorkspaceContentReviewStore(join(f.directory, 'original-review.sqlite'));
    let modifications = new ArtifactReviewStore(join(f.directory, 'original-modification.sqlite'));
    let port = new CollectiveMarkdownOwner({ owner, reviews, modifications, ownerUserId: 'f290-version-owner' });
    connector.setArtifactOwner(port);
    const texts = new Map(),
      versions = new Map();
    let artifact;
    const publish = async (n, description) => {
      const text = `# 插件接入指南\n\n这是原件的第 ${n} 版，正文标记 OWNER-V${n}。\n\n${description}\n`;
      texts.set(n, text);
      const operationContext = {
        kind: n === 1 ? 'collective-artifact:publish' : 'collective-artifact:apply',
        scopeRef: collectiveContentScopeRef(scope),
        actorHumanId: f.creator.human.humanId,
        requestDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        custodyRevision: 1,
        dispositionId: `owner-version-${n}`,
      };
      const common = {
        contentRef,
        bytes: Buffer.from(text),
        actor: { kind: 'human', actorId: f.creator.human.humanId },
        operationId: `owner-version-${n}`,
        operationContext,
        authorizeEffect: async () => {
          if (n > 1)
            f.store.issueArtifactConstraint(f.creator.sessionToken, {
              ...f.coordinates,
              artifactId,
              sourceEventId: source.eventId,
              action: 'apply',
              ownerRevision: n - 1,
            });
        },
      };
      const receipt =
        n === 1
          ? await owner.importContent({ ...common, collectiveScope: scope, mediaType: 'text/markdown' })
          : await owner.settle({ ...common, expectedOwnerRevision: n - 1 });
      artifact = await connector.registerArtifact(connection.connectionId, 'f290-version-owner', {
        contentRef,
        title: '插件接入指南',
        mediaType: 'text/markdown',
        sourceEventId: source.eventId,
        ownerRevision: receipt.ownerRevision,
        blobDigest: receipt.blobDigest,
        receiptRef: receipt.receiptId,
        changeSummary: description,
        requestId: `register-version-${n}`,
        ...(artifact ? { expectedRevision: artifact.revision, expectedCustodyRevision: 1 } : {}),
      });
      versions.set(n, artifact.versions[0]);
      return artifact;
    };
    await publish(1, '草稿');
    await publish(2, '第一版完整稿');
    await publish(3, '加入首次启动说明');
    const a = await f.store.createCollectiveProject(f.creator.sessionToken, {
      ...f.coordinates,
      requestId: 'project-a',
      channelId: options.projectChannelId ?? 'general',
      title: '插件框架 A',
      purpose: '明确使用接入指南的一版',
    });
    const b = await f.store.createCollectiveProject(f.member.sessionToken, {
      ...f.coordinates,
      requestId: 'project-b',
      channelId: 'general',
      title: '新用户上手 B',
      purpose: '保留自己的版本选择',
    });
    let running = false,
      stopped = false,
      lastSync = Promise.resolve();
    const syncErrors = [];
    const sync = () => {
      if (running || stopped) return;
      running = true;
      lastSync = connector
        .sync(connection.connectionId)
        .catch((error) => {
          if (!stopped) syncErrors.push(String(error));
        })
        .finally(() => {
          running = false;
        });
    };
    const timer = setInterval(sync, 80);
    sync();
    return {
      ...f,
      a,
      b,
      connector,
      connection,
      get owner() {
        return owner;
      },
      syncErrors,
      texts,
      versions,
      publish,
      get store() {
        return f.store;
      },
      get url() {
        return f.url;
      },
      get artifact() {
        return artifact;
      },
      setOwnerAvailable(available) {
        connector.setArtifactOwner(available ? port : undefined);
      },
      async restartOwner() {
        connector.setArtifactOwner(undefined);
        await lastSync;
        reviews.close();
        modifications.close();
        owner = new ProjectContentOwnerService({ dataDir: join(f.directory, 'original-guide-owner') });
        reviews = new WorkspaceContentReviewStore(join(f.directory, 'original-review.sqlite'));
        modifications = new ArtifactReviewStore(join(f.directory, 'original-modification.sqlite'));
        port = new CollectiveMarkdownOwner({ owner, reviews, modifications, ownerUserId: 'f290-version-owner' });
        connector.setArtifactOwner(port);
      },
      async close() {
        stopped = true;
        clearInterval(timer);
        await lastSync;
        reviews.close();
        modifications.close();
        await f.close();
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
