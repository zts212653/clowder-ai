import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectiveContentTextProposalReceiptSchema, collectiveEventSourceIdentity } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { readArtifactJsonPages } from '../../collective-client/src/collective-artifact-client.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { collectiveArtifactOwnerFixture } from './collective-artifact-owner.fixture.js';
import { loadCollectiveModule, test } from './helpers/f202-collective-installed-business.js';
import { installCollectiveNativeFixture } from './helpers/f202-collective-native.fixture.js';

for (const selectionMode of ['existing-annotation', 'same-send-selection', 'escaped-64k-patch'] as const) {
  test(`real callback uses ${selectionMode} while independently authenticated Human adoption remains separate`, async (t) => {
    let approvedInvocationId = '';
    const f = await collectiveArtifactOwnerFixture(t, {
      verifyAgent: async (agent) => agent.catId === 'codex-sol' && agent.sessionRef === approvedInvocationId,
      ...(selectionMode === 'escaped-64k-patch'
        ? { text: `# 真实正文\n${'\u0001'.repeat(65536 - Buffer.byteLength('# 真实正文\n'))}` }
        : {}),
    });
    await f.connector.setHostRoute(
      f.connection.connectionId,
      {
        localOwnerUserId: 'real-local-owner',
        defaultIngressThreadId: 'private-channel',
        humanNotificationThreadId: 'private-channel',
        agentRoutes: {
          [`${f.owner.human.humanId}:codex-sol`]: {
            catId: 'codex-sol',
            threadId: 'private-channel',
            participation: { displayName: 'Sol', channelIds: ['general'] },
          },
        },
      },
      1,
    );
    await f.connector.publishParticipation(f.connection.connectionId);
    const feedback = await f.store.postHumanMessage(f.member.sessionToken, {
      ...f.coordinates,
      clientEventId: 'callback-comment',
      location: { channelId: 'general', rootEventId: f.source.eventId },
      recipient: { kind: 'channel' },
      body: '说明得更清楚些。',
    });
    const annotated = await f.request(
      f.member.sessionToken,
      'annotate',
      {
        kind: 'annotate',
        messageEventId: feedback.eventId,
        quote: '真实正文',
        expectedReviewRevision: 1,
      },
      'callback-annotation',
    );
    assert.equal(annotated.status, 200);
    const review = annotated.value.value.view.review;
    if (selectionMode === 'same-send-selection') {
      const mismatched = await f.request(
        f.member.sessionToken,
        'annotate',
        {
          kind: 'annotate',
          messageEventId: feedback.eventId,
          quote: '真实正文',
          expectedReviewRevision: review.revision,
          selection: {
            start: 0,
            end: 4,
            quoteDigest: `sha256:${createHash('sha256').update('真实正文').digest('hex')}`,
          },
        },
        'incorrect-source-position',
      );
      assert.equal(mismatched.status, 409, JSON.stringify(mismatched));
      assert.equal(f.reviews.get(review.reviewId).annotations.length, 1);
    }
    const published = await fetch(`${f.server.url}/api/artifacts/requests/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${f.member.sessionToken}` },
      body: JSON.stringify({
        ...f.coordinates,
        artifactId: f.artifact.artifactId,
        sourceEventId: f.source.eventId,
        ownerRevision: 1,
        annotationIds: selectionMode !== 'same-send-selection' ? [review.annotations[0].id] : [],
        ...(selectionMode === 'same-send-selection'
          ? {
              selections: [
                {
                  start: f.text.indexOf('真实正文'),
                  end: f.text.indexOf('真实正文') + 4,
                  quoteDigest: `sha256:${createHash('sha256').update('真实正文').digest('hex')}`,
                },
              ],
            }
          : {}),
        expectedReviewRevision: review.revision,
        clientEventId: 'callback-request',
        body: 'Sol，请改这处说明。',
        recipient: {
          kind: 'agent',
          humanId: f.owner.human.humanId,
          agentId: 'codex-sol',
          connectionId: f.connection.connectionId,
          participationRevision: 2,
        },
      }),
    });
    const publication = await published.json();
    assert.equal(published.status, 201, JSON.stringify(publication));
    const ask = publication.source;
    if (selectionMode === 'same-send-selection') {
      const saved = await f.request(
        f.member.sessionToken,
        'annotate',
        {
          kind: 'annotate-published-selections',
          messageEventId: ask.eventId,
        },
        'materialize-human-selections',
      );
      assert.equal(saved.status, 200, JSON.stringify(saved));
      assert.equal(saved.value.value.view.review.annotations.at(-1).collectiveMessage.eventId, ask.eventId);
    }
    const source = collectiveEventSourceIdentity(ask);
    if (!source) throw new Error('Expected an exact public request source');
    const messages = new MessageStore();
    const instanceId = 'pi_collective';
    const { collectiveSender } = await loadCollectiveModule('collective-ingress-routing.js');
    const native = await loadCollectiveModule('public-native-methods.js');
    await f.connector.sync(f.connection.connectionId);
    const route = await f.connector.getHostRoute(f.connection.connectionId);
    await f.connector.beginInboxRouting(f.connection.connectionId, ask.eventId, route.revision);
    const message = messages.append({
      userId: 'real-local-owner',
      threadId: 'private-channel',
      from: { kind: 'plugin', instanceId },
      content: ask.body,
      mentions: [],
      timestamp: Date.now(),
      extra: {
        pluginMessage: {
          instanceId,
          revision: 1,
          elements: [],
          appendOps: [],
          presentation: {
            connector: 'collective',
            label: 'Collective',
            sender: collectiveSender(ask),
            meta: { participation: source },
          },
        },
      },
    });
    const registry = new InvocationRegistry();
    const auth = await registry.create(
      'real-local-owner',
      'codex-sol',
      'private-channel',
      undefined,
      undefined,
      {
        mode: 'plugin_native',
        pluginInstanceId: instanceId,
        contributionId: native.COLLECTIVE_NATIVE_ID,
        actionMethods: native.COLLECTIVE_PUBLIC_METHODS,
      },
      message.id,
      'unknown',
    );
    approvedInvocationId = auth.invocationId;
    const app = Fastify();
    t.after(() => app.close());
    const token = await installCollectiveNativeFixture({ app, f, registry, messages, instanceId, message, auth });
    const headers = {
      'x-invocation-id': auth.invocationId,
      'x-callback-token': auth.callbackToken,
      'x-clowder-plugin-action-token': token,
    };
    const current = await app.inject({
      method: 'POST',
      url: '/api/plugin-runtime/action',
      headers,
      payload: { method: 'collective.context.current', input: {} },
    });
    assert.equal(current.statusCode, 200, current.body);
    const discovered = current.json().result;
    assert.equal(discovered.artifactRequests.requests[0].artifactId, f.artifact.artifactId);
    const readCommand = { kind: 'read', artifactId: f.artifact.artifactId };
    const call = async (
      command: Record<string, unknown>,
      contextRef = discovered.contextRef,
      credentials = headers,
    ) => {
      let settled = false;
      const waiting = app
        .inject({
          method: 'POST',
          url: '/api/plugin-runtime/action',
          headers: credentials,
          payload: { method: 'collective.artifact.command', input: { contextRef, command } },
        })
        .then((response) => {
          settled = true;
          return { statusCode: response.statusCode, body: response.body, json: () => response.json().result };
        });
      for (let i = 0; i < 60 && !settled; i += 1) {
        await f.connector.sync(f.connection.connectionId);
        if (!settled) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      return waiting;
    };
    assert.equal((await call(readCommand, 'not-this-invocation')).statusCode, 502);
    assert.equal(
      (await call(readCommand, discovered.contextRef, { ...headers, 'x-callback-token': 'forged' })).statusCode,
      401,
    );
    assert.equal((await call({ kind: 'apply', artifactId: f.artifact.artifactId })).statusCode, 502);
    assert.equal((await call({ ...readCommand, artifactId: 'another-artifact' })).statusCode, 502);
    const read = await call(readCommand);
    assert.equal(read.statusCode, 200, read.body);
    const ownerView = (await readArtifactJsonPages(async (page) => {
      const result = Object.keys(page).length ? await call({ ...readCommand, ...page }) : read;
      assert.equal(result.statusCode, 200, result.body);
      return result.json();
    })) as ReturnType<typeof read.json>;
    assert.equal(ownerView.text, f.text);
    assert.match(ownerView.modification.requestId, /^f309-modification-[a-f0-9]{64}$/);
    assert.equal(ownerView.modification.requestEventId, ask.eventId);
    if (selectionMode === 'same-send-selection') {
      const selection = ownerView.modification.selections[0];
      assert.equal(selection.anchor.quote, '真实正文');
      assert.equal(selection.author.actorId, f.member.human.humanId);
      assert.equal(selection.body, ask.body);
      const repeated = await call(readCommand);
      assert.equal(repeated.statusCode, 200, repeated.body);
      assert.deepEqual(repeated.json().modification.selections, ownerView.modification.selections);
      assert.equal(f.reviews.get(ownerView.view.review.reviewId).annotations.length, 2);
    }
    const command = {
      kind: 'respond',
      artifactId: f.artifact.artifactId,
      requestId: ownerView.modification.requestId,
      operationId: '00000000-0000-4000-8000-000000000001',
      expectedOwnerRevision: ownerView.ownerRevision,
      expectedProposalRevision: ownerView.modification.latestProposalRevision,
      baseRevision: ownerView.blobDigest,
      response: '这处说明已改清楚。',
      edits: [
        {
          start: f.text.indexOf('真实正文'),
          end: f.text.indexOf('真实正文') + 4,
          expectedText: '真实正文',
          replacement: '共享正文',
        },
      ],
    };
    if (selectionMode === 'escaped-64k-patch') {
      command.edits = [{ start: 0, end: f.text.length, expectedText: f.text, replacement: '\u0002'.repeat(65536) }];
      command.response = '\u0003'.repeat(8000);
      assert.ok(Buffer.byteLength(JSON.stringify(command)) > 768 * 1024);
      const execute = f.port.execute.bind(f.port);
      let loseResponse = true;
      f.port.execute = async (operation, authority) => {
        const result = await execute(operation, authority);
        if (
          loseResponse &&
          operation.constraint.action === 'propose' &&
          operation.payload.kind === 'respond-modification' &&
          result.status === 'ok'
        ) {
          loseResponse = false;
          throw new Error('simulated lost response after durable proposal commit');
        }
        return result;
      };
      assert.equal((await call(command)).statusCode, 502);
      assert.equal(f.modifications.text.proposals(command.requestId).length, 1);
    }
    const proposed = await call(command);
    assert.equal(proposed.statusCode, 200, proposed.body);
    assert.equal(proposed.json().kind, 'proposal-receipt');
    collectiveContentTextProposalReceiptSchema.parse(proposed.json().proposal);
    assert.equal(proposed.json().proposal.edits, undefined);
    assert.equal(proposed.json().proposal.response, undefined);
    assert.ok(Buffer.byteLength(proposed.body) < 16 * 1024);
    assert.equal(proposed.json().proposal.authorCatId, 'codex-sol');
    assert.deepEqual((await call(command)).json(), proposed.json());
    const humanRead = (await readArtifactJsonPages(async (page) => {
      const response = await f.request(f.member.sessionToken, 'read', page, 'human-request-list');
      assert.equal(response.status, 200, JSON.stringify(response));
      return response.value.value;
    })) as { modifications: { requests: Array<{ requestId: string; latestProposalRef: string }> } };
    assert.equal(humanRead.modifications.requests[0].requestId, ownerView.modification.requestId);
    assert.equal(humanRead.modifications.requests[0].latestProposalRef, proposed.json().proposal.proposalRef);
    assert.equal((await f.contentOwner.describe(f.artifact.contentRef)).currentOwnerRevision, 1);
    const selection = {
      requestId: ownerView.modification.requestId,
      proposalRef: proposed.json().proposal.proposalRef,
    };
    const preview = (await readArtifactJsonPages(async (page) => {
      const response = await f.request(f.member.sessionToken, 'preview', { ...selection, ...page }, 'callback-preview');
      assert.equal(response.status, 200, JSON.stringify(response));
      return response.value.value;
    })) as { baseText: string; proposedText: string; proposal: { edits: typeof command.edits } };
    assert.equal(preview.baseText, f.text);
    assert.deepEqual(preview.proposal.edits, command.edits);
    if (selectionMode === 'escaped-64k-patch') assert.equal(preview.proposedText, '\u0002'.repeat(65536));
    const adopted = await f.request(f.owner.sessionToken, 'apply', selection, 'callback-adopt');
    assert.equal(adopted.status, 200, JSON.stringify(adopted));
    assert.equal(adopted.value.value.receipt.ownerRevision, 2);
    assert.equal((await f.contentOwner.load(f.artifact.contentRef)).bytes.toString('utf8'), preview.proposedText);
    const version = f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0].versions.at(-1);
    assert.equal(version.adoptedByHumanId, f.owner.human.humanId);
    assert.equal(version.authorCatId, 'codex-sol');
    assert.equal(
      f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0].versions.at(-1).lineage.requestEventId,
      ask.eventId,
    );
    const afterAdoption = await call(command);
    assert.equal(afterAdoption.statusCode, 200, afterAdoption.body);
    assert.deepEqual(afterAdoption.json().proposal, proposed.json().proposal);
    assert.equal(afterAdoption.json().request.state, 'accepted');
    if (selectionMode === 'escaped-64k-patch') {
      assert.equal(f.modifications.text.proposals(command.requestId).length, 1);
      for (const path of ['service/collective-service.json', 'connector/collective-connector.json']) {
        const state = await readFile(join(f.root, path), 'utf8');
        for (const code of ['\\u0001', '\\u0002', '\\u0003']) assert.equal(state.includes(code.repeat(32)), false);
      }
    }

    assert.equal(JSON.stringify([discovered, ownerView, proposed.json()]).includes('real-local-owner'), false);
    await f.store.updateArtifactAccess(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      humanId: f.member.human.humanId,
      expectedAccessRevision: 1,
      access: 'revoked',
      requestId: 'callback-revoke-requester',
    });
    assert.equal((await call(readCommand)).statusCode, 502);
    assert.equal((await call(command)).statusCode, 502);
  });
}
