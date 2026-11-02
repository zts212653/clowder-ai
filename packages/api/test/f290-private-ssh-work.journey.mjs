import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.ts';
import { CollectiveMarkdownOwner } from '../src/domains/collaborative-content/collective-artifact/markdown-owner.ts';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.ts';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.ts';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.ts';

test(
  'shared Work stays at its original Café through read, proposal and adoption; owner offline does not break ordinary attachments',
  { timeout: 45_000 },
  async (t) => {
    const directory = process.env.F290_SSH_DATA_DIR,
      output = process.env.F290_SSH_EVIDENCE_DIR;
    assert.ok(directory && output && process.env.F290_PLUGIN_PACKAGE_ROOT);
    const f = JSON.parse(await readFile(join(directory, 'isolated-browser-sessions.json'), 'utf8'));
    const root = await mkdtemp(join(tmpdir(), 'f290-ssh-original-owner-'));
    const owner = new ProjectContentOwnerService({ dataDir: join(root, 'original-content') });
    const reviews = new WorkspaceContentReviewStore(join(root, 'reviews.sqlite'));
    const modifications = new ArtifactReviewStore(join(root, 'modifications.sqlite'));
    t.after(async () => {
      reviews.close();
      modifications.close();
      await rm(root, { recursive: true, force: true });
    });
    const { CollectiveConnector } = await import(
      pathToFileURL(join(resolve(process.env.F290_PLUGIN_PACKAGE_ROOT), 'dist/business/connector/connector.js')).href
    );
    const connector = await CollectiveConnector.open({
      dataDirectory: join(root, 'connector'),
      verifyAgent: async () => false,
    });
    t.after(() => connector.stopMediaReads());
    const post = async (path, token, input) => {
      const response = await fetch(f.origin + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() };
    };
    const coordinates = { serviceInstanceId: f.serviceInstanceId, collectiveId: f.collectiveId };
    const intent = await post('/api/pairing-intents', f.owner.sessionToken, {
      collectiveId: f.collectiveId,
      hostOrigin: 'http://127.0.0.1:19411',
      nonce: 'ssh-work-' + randomUUID(),
    });
    assert.equal(intent.status, 201);
    const connection = await connector.pair({
      serviceUrl: f.origin,
      intent: intent.body,
      endpointLabel: 'Original Work owner Café (fixture)',
    });
    await connector.setHostRoute(
      connection.connectionId,
      {
        localOwnerUserId: 'fixture-work-owner',
        defaultIngressThreadId: 'private-fixture-thread',
        humanNotificationThreadId: 'private-fixture-thread',
        agentRoutes: {
          [`${f.owner.human.humanId}:codex-astra`]: {
            catId: 'codex-astra',
            threadId: 'private-fixture-thread',
            participation: { displayName: 'Astra (fixture)', channelIds: ['general'] },
          },
        },
      },
      0,
    );
    await connector.publishParticipation(connection.connectionId);
    const state = JSON.parse(await readFile(join(root, 'connector/collective-connector.json'), 'utf8'));
    const credential = state.connections[connection.connectionId].endpointCredential;
    const source = await post('/api/events/human', f.owner.sessionToken, {
      ...coordinates,
      clientEventId: randomUUID(),
      location: { channelId: 'general' },
      recipient: { kind: 'channel' },
      body: '一起改这份由原 Café 保管的作品。',
    });
    assert.equal(source.status, 201);
    const contentRef = 'collective-content:ssh-original-' + randomUUID();
    const artifactId =
      'artifact_' +
      createHash('sha256')
        .update(JSON.stringify([f.serviceInstanceId, f.collectiveId, contentRef]))
        .digest('hex');
    const scope = {
      kind: 'collective-artifact',
      ...coordinates,
      artifactId,
      contentRef,
      sourceEventId: source.body.eventId,
      publishedByHumanId: f.owner.human.humanId,
    };
    const text = '# SSH_ORIGINAL_OWNER_BYTES\n\n这份真实正文一直保留在原 Café。\n';
    const receipt = await owner.importContent({
      contentRef,
      collectiveScope: scope,
      bytes: Buffer.from(text),
      mediaType: 'text/markdown',
      actor: { kind: 'human', actorId: f.owner.human.humanId },
      operationId: 'import',
      authorizeEffect: async () => {},
      operationContext: {
        kind: 'collective-artifact:publish',
        scopeRef: collectiveContentScopeRef(scope),
        actorHumanId: f.owner.human.humanId,
        requestDigest: `sha256:${'1'.repeat(64)}`,
        custodyRevision: 1,
        dispositionId: 'initial-publication',
      },
    });
    const artifact = await connector.registerArtifact(connection.connectionId, 'fixture-work-owner', {
      contentRef,
      title: 'SSH 原作品',
      mediaType: 'text/markdown',
      sourceEventId: source.body.eventId,
      ownerRevision: 1,
      blobDigest: receipt.blobDigest,
      receiptRef: receipt.receiptId,
      requestId: 'register',
    });
    assert.equal(artifact.artifactId, artifactId);
    connector.setArtifactOwner(
      new CollectiveMarkdownOwner({ owner, reviews, modifications, ownerUserId: 'fixture-work-owner' }),
    );
    async function invoke(token, action, payload, requestId, agent) {
      let done = false;
      const waiting = post(`/api/artifacts/${agent ? 'agent' : 'owner'}/request`, token, {
        ...coordinates,
        artifactId,
        sourceEventId: source.body.eventId,
        action,
        payload,
        requestId,
        ...agent,
      }).finally(() => {
        done = true;
      });
      for (let attempts = 0; attempts < 80 && !done; attempts++) {
        await connector.sync(connection.connectionId);
        if (!done) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return waiting;
    }
    const initialRead = await invoke(f.member.sessionToken, 'read', {}, 'member-read');
    assert.equal(initialRead.status, 200, JSON.stringify(initialRead.body));
    assert.equal(initialRead.body.value.text, text);
    const quote = '真实正文',
      at = text.indexOf(quote);
    const requested = await post('/api/artifacts/requests/publish', f.member.sessionToken, {
      ...coordinates,
      artifactId,
      sourceEventId: source.body.eventId,
      ownerRevision: 1,
      annotationIds: [],
      selections: [
        {
          start: at,
          end: at + quote.length,
          quoteDigest: 'sha256:' + createHash('sha256').update(quote).digest('hex'),
        },
      ],
      expectedReviewRevision: initialRead.body.value.view.review.revision,
      clientEventId: randomUUID(),
      body: '把这一处改成共享正文。',
      recipient: {
        kind: 'agent',
        humanId: f.owner.human.humanId,
        connectionId: connection.connectionId,
        agentId: 'codex-astra',
        participationRevision: 1,
      },
    });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const agent = {
      connectionId: connection.connectionId,
      requestEventId: requested.body.source.eventId,
      catId: 'codex-astra',
      participationRevision: 1,
    };
    const prepared = await invoke(credential, 'read', {}, 'agent-read-original', agent);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const requestId = prepared.body.value.modification.requestId;
    const proposed = await invoke(
      credential,
      'propose',
      {
        kind: 'respond-modification',
        requestId,
        operationId: randomUUID(),
        expectedOwnerRevision: 1,
        expectedProposalRevision: 0,
        baseRevision: receipt.blobDigest,
        edits: [{ start: at, end: at + quote.length, expectedText: quote, replacement: '共享正文' }],
        response: '只修改明确指出的这一处。',
      },
      'agent-proposal',
      agent,
    );
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    const selection = { requestId, proposalRef: proposed.body.value.proposal.proposalRef };
    const adopted = await invoke(f.owner.sessionToken, 'apply', selection, 'owner-adoption');
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    assert.equal(adopted.body.value.receipt.ownerRevision, 2);
    assert.deepEqual(await invoke(f.owner.sessionToken, 'apply', selection, 'owner-adoption'), adopted);
    assert.equal((await owner.load(contentRef)).bytes.toString(), text.replace('真实正文', '共享正文'));
    assert.equal((await owner.listOutbox(contentRef)).length, 2);
    const offline = await post('/api/artifacts/owner/request', f.member.sessionToken, {
      ...coordinates,
      artifactId,
      sourceEventId: source.body.eventId,
      action: 'read',
      payload: {},
      requestId: 'owner-offline-read',
    });
    assert.equal(offline.status, 503);
    assert.equal(offline.body.error.code, 'ARTIFACT_OWNER_UNAVAILABLE');
    const eventsResponse = await fetch(`${f.origin}/api/events/human?collectiveId=${f.collectiveId}`, {
      headers: { authorization: `Bearer ${f.member.sessionToken}`, 'x-collective-message-content': '2' },
    });
    const ordinary = (await eventsResponse.json()).events.find((event) => event.attachments?.length);
    assert.ok(ordinary);
    const attachment = ordinary.attachments[0];
    const opened = await fetch(
      `${f.origin}/api/message-attachments/read?${new URLSearchParams({ ...coordinates, attachmentId: attachment.attachmentId, sourceEventId: ordinary.eventId })}`,
      { method: 'POST', headers: { authorization: `Bearer ${f.member.sessionToken}` } },
    );
    assert.equal(opened.status, 200);
    assert.equal(
      'sha256:' +
        createHash('sha256')
          .update(Buffer.from(await opened.arrayBuffer()))
          .digest('hex'),
      attachment.blobDigest,
    );
    assert.equal(
      (await readFile(join(directory, 'collective-service.json'), 'utf8')).includes('SSH_ORIGINAL_OWNER_BYTES'),
      false,
    );
    const proof = {
      transport: 'actual OpenSSH',
      contentRef,
      artifactId,
      serviceInstanceId: f.serviceInstanceId,
      sourceEventId: source.body.eventId,
      originalOwnerRevision: 1,
      adoptedOwnerRevision: 2,
      originalOwnerReceiptCount: 2,
      ownerOfflineStatus: offline.status,
      ordinaryAttachmentStillReadable: true,
      serviceCopiedOriginalBytes: false,
      providerAndRunningAgent: 'explicit fixtures',
    };
    await writeFile(join(output, 'ssh-original-work.json'), JSON.stringify(proof, null, 2) + '\n');
    console.log(JSON.stringify(proof));
  },
);
