import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectiveArtifactOwnerFixture } from './collective-artifact-owner.fixture.js';
import { test } from './helpers/f202-collective-installed-business.js';
import { collectiveModuleFixture } from './helpers/f202-collective-module.fixture.js';

test('two independent authenticated sessions share canonical Markdown and a real source-bound annotation over HTTP and Connector', async (t) => {
  const f = await collectiveArtifactOwnerFixture(t);
  assert.notEqual(f.owner.human.humanId, f.member.human.humanId);
  const first = await f.request(f.owner.sessionToken, 'read', {}, 'read-first');
  const second = await f.request(f.member.sessionToken, 'read', {}, 'read-second');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.value.value.text, f.text);
  assert.equal(second.value.value.text, f.text);
  assert.equal(first.value.value.view.review.reviewId, second.value.value.view.review.reviewId);
  const feedback = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'real-shared-feedback',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: f.source.eventId,
    body: '把这句话解释得更清楚。',
  });
  const command = {
    kind: 'annotate',
    messageEventId: feedback.eventId,
    quote: '共同阅读的真实正文',
    expectedReviewRevision: 1,
  };
  const annotated = await f.request(f.member.sessionToken, 'annotate', command, 'annotate-feedback');
  assert.equal(annotated.status, 200, JSON.stringify(annotated));
  const annotation = annotated.value.value.view.review.annotations[0];
  assert.equal(annotation.body, feedback.body, 'the Service resolves the original immutable public message');
  assert.equal(annotation.author.actorId, f.member.human.humanId);
  assert.equal(annotation.collectiveMessage.eventId, feedback.eventId);
  const replay = await f.request(f.member.sessionToken, 'annotate', command, 'annotate-feedback');
  assert.equal(replay.status, 200);
  assert.equal(replay.value.value.view.review.annotations.length, 1);
  assert.equal(replay.value.value.receipt.receiptRef, annotated.value.value.receipt.receiptRef);
  const spoof = await f.request(
    f.member.sessionToken,
    'annotate',
    { ...command, body: 'forged source body' },
    'forged-feedback',
  );
  assert.equal(spoof.status, 400);
  const wrongAuthor = await f.request(f.owner.sessionToken, 'annotate', command, 'other-human-feedback');
  assert.equal(wrongAuthor.status, 403);
  const directory = await readFile(join(f.root, 'service', 'collective-service.json'), 'utf8');
  assert.equal(directory.includes(f.text), false);
  assert.equal(directory.includes('owner-allow:'), false);
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'revoke-shared-member',
  });
  assert.equal((await f.request(f.member.sessionToken, 'read', {}, 'read-second')).status, 403);
  assert.equal((await f.request(f.owner.sessionToken, 'read', {}, 'owner-after-revoke')).status, 200);
});

test('the installed module lifecycle reattaches the retained owner after restart without changing connection identity', async (t) => {
  const f = await collectiveArtifactOwnerFixture(t);
  let calls = 0;
  const owner = {
    execute: async (operation, authority) => {
      calls++;
      return f.port.execute(operation, authority);
    },
  };
  const module = await collectiveModuleFixture(t, f, owner);
  f.useBackgroundSync();
  await module.start();
  assert.equal((await f.request(f.member.sessionToken, 'read', {}, 'before-restart')).status, 200);
  const stateFile = join(module.dataPath, 'connector', 'collective-connector.json');
  const before = JSON.parse(await readFile(stateFile, 'utf8'));
  await module.stop();
  await module.start();
  assert.equal((await f.request(f.member.sessionToken, 'read', {}, 'after-restart')).status, 200);
  const after = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(Object.keys(after.connections), Object.keys(before.connections));
  assert.equal(
    after.connections[f.connection.connectionId].endpointCredential,
    before.connections[f.connection.connectionId].endpointCredential,
  );
  assert.equal(calls, 2);
});

test('shared modification requests resolve their real Human message and exact declared Cat at the Service boundary', async (t) => {
  const f = await collectiveArtifactOwnerFixture(t);
  await f.store.publishParticipation(f.targetConnection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.targetConnection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex61-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const feedback = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'request-comment',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: f.source.eventId,
    body: '解释一下这句话。',
  });
  const annotation = await f.request(
    f.member.sessionToken,
    'annotate',
    {
      kind: 'annotate',
      messageEventId: feedback.eventId,
      quote: '共同阅读的真实正文',
      expectedReviewRevision: 1,
    },
    'annotate-before-request',
  );
  assert.equal(annotation.status, 200);
  const review = annotation.value.value.view.review;
  const ask = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'named-cat-ask',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    replyToEventId: f.source.eventId,
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      agentId: 'codex61-sol',
      connectionId: f.targetConnection.connectionId,
      participationRevision: 1,
    },
    body: 'Sol，请把这处说明得更清楚。',
  });
  const payload = {
    kind: 'request-modification',
    messageEventId: ask.eventId,
    annotationIds: [review.annotations[0].id],
    expectedReviewRevision: review.revision,
  };
  const requested = await f.request(f.member.sessionToken, 'propose', payload, 'request-named-cat');
  assert.equal(requested.status, 200, JSON.stringify(requested));
  assert.deepEqual(requested.value.value.request.target, { humanId: f.owner.human.humanId, catId: 'codex61-sol' });
  assert.equal((await f.request(f.owner.sessionToken, 'propose', payload, 'forge-requester')).status, 403);
  assert.equal(
    (await f.request(f.member.sessionToken, 'propose', { ...payload, instruction: 'forged' }, 'forge-instruction'))
      .status,
    400,
  );
  const agent = {
    connectionId: f.targetConnection.connectionId,
    requestEventId: ask.eventId,
    catId: 'codex61-sol',
    participationRevision: 1,
  };
  const read = await f.request(f.targetConnection.endpointCredential, 'read', {}, 'cat-read', agent);
  assert.equal(read.status, 200, JSON.stringify(read));
  assert.equal(read.value.value.text, f.text);
  const command = {
    kind: 'respond-modification',
    requestId: requested.value.value.request.requestId,
    operationId: '00000000-0000-4000-8000-000000000001',
    expectedOwnerRevision: 1,
    expectedProposalRevision: 0,
    baseRevision: f.artifact.versions[0].blobDigest,
    edits: [
      {
        start: f.text.indexOf('真实正文'),
        end: f.text.indexOf('真实正文') + 4,
        expectedText: '真实正文',
        replacement: '共享正文',
      },
    ],
    response: '说明已更清楚。',
  };
  const wrongCat = await f.request(f.targetConnection.endpointCredential, 'propose', command, 'other-cat', {
    ...agent,
    catId: 'another-cat',
  });
  assert.equal(wrongCat.status, 403);
  const proposal = await f.request(f.targetConnection.endpointCredential, 'propose', command, 'cat-submit', agent);
  assert.equal(proposal.status, 200, JSON.stringify(proposal));
  const selected = { requestId: command.requestId, proposalRef: proposal.value.value.proposal.proposalRef };
  const preview = await f.request(f.member.sessionToken, 'preview', selected, 'view-proposal');
  assert.equal(preview.status, 200);
  assert.equal(preview.value.value.proposedText, f.text.replace('真实正文', '共享正文'));
  const deniedApply = await f.request(f.member.sessionToken, 'apply', selected, 'not-granted-apply');
  assert.equal(deniedApply.status, 403);
  const adopted = await f.request(f.owner.sessionToken, 'apply', selected, 'adopt-shared-change');
  assert.equal(adopted.status, 200, JSON.stringify(adopted));
  const replay = await f.request(f.owner.sessionToken, 'apply', selected, 'adopt-shared-change');
  assert.deepEqual(replay, adopted);
  assert.equal((await f.contentOwner.describe(f.artifact.contentRef)).currentOwnerRevision, 2);
  const catalogue = f.store.listArtifacts(f.member.sessionToken, f.coordinates);
  assert.equal(catalogue[0].versions.at(-1).ownerRevision, 2);
  const latest = await f.request(f.member.sessionToken, 'read', {}, 'read-adopted-version');
  assert.equal(latest.value.value.text, f.text.replace('真实正文', '共享正文'));
  assert.equal(latest.value.value.view.canWrite, true);

  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'remove-requester',
  });
  const revokedCatRead = await f.request(f.targetConnection.endpointCredential, 'read', {}, 'cat-after-revoke', agent);
  assert.equal(revokedCatRead.status, 403);
});
