import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProjectScreeningContextAttachment } from '@cat-cafe/shared';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import {
  deriveGrowingSourceMessageRevision,
  MessageStore,
} from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import {
  ProjectMessageCatGrants,
  type ProjectMessageTakeoverGrantPort,
} from '../src/domains/collaborative-content/workspace-review/project-message/cat-grants.js';
import { VideoProjectMessageImporter } from '../src/domains/collaborative-content/workspace-review/project-message/import.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { screeningFixture } from './helpers/video-project-screening.js';

async function setup() {
  const f = await screeningFixture();
  const { screening } = await f.make().register(f.request);
  const store = new ArtifactReviewStore(join(f.root, 'artifact-reviews.sqlite'));
  const messages = new MessageStore();
  const turns = new InMemoryTurnExecutionStore();
  let threadAllowed = true;
  const authority = {
    messages,
    authorizeSource: async () => {
      if (!threadAllowed) throw new Error('Thread permission denied');
    },
  };
  const attachment: ProjectScreeningContextAttachment = {
    v: 1,
    id: 'attachment-1',
    kind: 'project-screening',
    title: 'Review opening',
    contentRef: f.request.contentRef,
    screeningId: screening.id,
    input: screening.input,
    media: { contentRef: screening.media.contentRef, ownerRevision: 1, blobDigest: screening.media.blobDigest },
    selections: [
      {
        id: 'selection-1',
        mediaRange: {
          startPts: screening.media.media.startTick,
          endPts: screening.media.media.startTick + screening.media.media.durationTicks,
        },
        target: { kind: 'moment', tick: 0, endTick: 30, timebase: { numerator: 1, denominator: 30 } },
      },
    ],
  };
  const message = messages.append({
    userId: f.principal.userId,
    threadId: 'thread-1',
    from: { kind: 'user', userId: f.principal.userId },
    mentions: ['sol'],
    content: 'Please fix the opening',
    timestamp: Date.now(),
    contentBlocks: [{ type: 'context_attachment', attachment }],
  });
  const importer = new VideoProjectMessageImporter({
    store: store.ledgers,
    projects: f.projects,
    screenings: f.make(),
    authority,
  });
  const imported = await importer.import({
    principal: f.principal,
    contentRef: f.request.contentRef,
    threadId: message.threadId,
    messageId: message.id,
    messageRevision: deriveGrowingSourceMessageRevision(message),
    attachmentId: attachment.id,
    selectionId: 'selection-1',
  });
  const child = {
    invocationId: 'child-1',
    parentInvocationId: 'parent-1',
    threadId: 'thread-1',
    userId: f.principal.userId,
    catId: 'sol',
    executionKind: 'ordinary' as const,
    startedAt: Date.now(),
    causal: { triggerMessageId: message.id },
  };
  turns.createRunning(child);
  const principal = {
    userId: f.principal.userId,
    actor: { kind: 'cat' as const, actorId: 'sol' },
    invocationId: child.invocationId,
  };
  const grants = (takeover?: ProjectMessageTakeoverGrantPort) =>
    new ProjectMessageCatGrants({ turns, authority, ledgers: store.ledgers, takeover });
  return {
    ...f,
    store,
    messages,
    turns,
    message,
    imported,
    child,
    principal,
    grants,
    revokeThread() {
      threadAllowed = false;
    },
    async cleanup() {
      store.close();
      await f.cleanup();
    },
  };
}

test('F326 actual child and original imported Human request permit Cat reads while write defaults to deny', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const projects = new VideoProjectService({
    owner: f.owner,
    ownerUserId: f.principal.userId,
    authorizeCat: f.grants().authorize,
  });
  const snapshot = await projects.load({ principal: f.principal, contentRef: f.request.contentRef });
  assert.equal(snapshot.ownerRevision, 2);
  snapshot.document.title = 'Unapproved write';
  await assert.rejects(
    projects.save({
      principal: f.principal,
      contentRef: f.request.contentRef,
      expectedOwnerRevision: 2,
      operationId: 'denied',
      document: snapshot.document,
    }),
    { code: 'access_denied' },
  );
});

test('F326 write authority consumes an exact takeover proof port and retains the real Cat actor', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  let checked = false;
  const grants = f.grants({
    hasGrant: async (witness) => {
      assert.equal(witness.principal.invocationId, 'child-1');
      assert.equal(witness.principal.actor.actorId, 'sol');
      assert.equal(witness.contentRef, f.request.contentRef);
      assert.equal(witness.threadId, 'thread-1');
      assert.equal(witness.sourceMessageId, f.message.id);
      assert.equal(witness.sourceMessageRevision, deriveGrowingSourceMessageRevision(f.message));
      assert.deepEqual(
        witness.annotationIds,
        f.imported.review.annotations.map((item) => item.id),
      );
      checked = true;
      return true; // Explicit test-only confirmed takeover port, never a production role-based grant.
    },
  });
  const projects = new VideoProjectService({
    owner: f.owner,
    ownerUserId: f.principal.userId,
    authorizeCat: grants.authorize,
  });
  const snapshot = await projects.load({ principal: f.principal, contentRef: f.request.contentRef });
  snapshot.document.title = 'Accepted modification';
  const receipt = await projects.save({
    principal: f.principal,
    contentRef: f.request.contentRef,
    expectedOwnerRevision: 2,
    operationId: 'accepted',
    document: snapshot.document,
  });
  assert.ok(checked);
  assert.deepEqual(receipt.actor, f.principal.actor);
});

for (const flaw of [
  'parent-id',
  'other-cat',
  'other-owner',
  'other-thread',
  'terminal',
  'no-human-trigger',
  'not-mentioned',
  'edited',
  'whisper-excludes-cat',
  'thread-revoked',
] as const)
  test(`F326 project grant rejects ${flaw} despite an imported opinion`, async (t) => {
    const f = await setup();
    t.after(f.cleanup);
    const principal = { ...f.principal, actor: { ...f.principal.actor } };
    if (flaw === 'parent-id') principal.invocationId = 'parent-1';
    if (flaw === 'other-cat') principal.actor.actorId = 'astra';
    if (flaw === 'other-owner') principal.userId = 'someone-else';
    if (flaw === 'other-thread' || flaw === 'no-human-trigger') {
      const child = {
        ...f.child,
        invocationId: 'different-child',
        threadId: flaw === 'other-thread' ? 'other-thread' : 'thread-1',
        causal: flaw === 'no-human-trigger' ? {} : f.child.causal,
      };
      f.turns.createRunning(child);
      principal.invocationId = child.invocationId;
    }
    if (flaw === 'terminal') f.turns.transitionTerminal('child-1', { status: 'succeeded', endedAt: Date.now() });
    const source = f.messages.getById(f.message.id);
    assert.ok(source);
    if (flaw === 'not-mentioned') source.mentions = [];
    if (flaw === 'edited') source.content = 'Changed source';
    if (flaw === 'whisper-excludes-cat') {
      source.visibility = 'whisper';
      source.whisperTo = [];
    }
    if (flaw === 'thread-revoked') f.revokeThread();
    await assert.rejects(f.grants().authorize({ principal, contentRef: f.request.contentRef, permission: 'read' }), {
      code: 'access_denied',
    });
  });

test('F326 a source edited during async takeover verification cannot authorize project mutation', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const grant = f.grants({
    hasGrant: async () => {
      const source = f.messages.getById(f.message.id);
      assert.ok(source);
      source.content = 'Revoked source body';
      return true;
    },
  });
  await assert.rejects(
    grant.authorize({ principal: f.principal, contentRef: f.request.contentRef, permission: 'write' }),
    { code: 'access_denied' },
  );
});
