import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createArtifactReviewIntegration } from '../src/domains/growing/artifact-review-composition.js';
import { F232PreparedArtifactReader } from '../src/domains/growing/F232PreparedArtifactReader.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { projectDocumentFixture, projectHumanFixture } from './helpers/video-project-fixture.js';

test('F326 runtime composition shares the real F138 receipt and artifact-reviews.sqlite ledger across Human/Cat reads and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f326-real-review-'));
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  const messages = new MessageStore();
  const principal = projectHumanFixture;
  const cat = { userId: 'operator', actor: { kind: 'cat' as const, actorId: 'sol' }, invocationId: 'verified-call' };
  const compose = () => {
    const owner = new ProjectContentOwnerService({ dataDir: root });
    const projects = new VideoProjectService({
      owner,
      ownerUserId: 'operator',
      authorizeCat: async ({ principal }) => {
        if (principal.actor.actorId !== 'sol' || principal.invocationId !== 'verified-call')
          throw new Error('Untrusted invocation');
      },
    });
    const integration = createArtifactReviewIntegration({
      dataDir: root,
      uploadDir: root,
      owner,
      projects,
      tasks,
      threads,
      messages,
      workspace: new WorkspaceContentSourceService({
        ownerUserId: 'operator',
        resolveWorktreeRoot: async (id) => ({ root, canonicalWorktreeId: id }),
      }),
      publications: new F232PreparedArtifactReader({ messages }),
      delivery: {
        async deliver() {
          throw new Error('No delivery in Phase A');
        },
      },
      emit() {},
      onError(error) {
        throw error;
      },
    });
    return { ...integration, projects };
  };
  let integration = compose();
  try {
    const receipt = await integration.projects.create({
      principal,
      operationId: 'create-project',
      document: projectDocumentFixture,
    });
    const reviews = integration.projectReviews;
    assert.ok(reviews);
    const opened = await reviews.prepare({
      principal: cat,
      contentRef: receipt.contentRef,
      operationId: 'prepare-review',
    });
    const annotated = await reviews.annotate({
      principal: cat,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'annotate-shot',
      body: 'Check the opening.',
      target: { kind: 'project' },
    });
    const snapshot = await integration.projects.load({ principal, contentRef: receipt.contentRef });
    const located = await reviews.act({
      principal: cat,
      reviewId: opened.review.reviewId,
      expectedRevision: annotated.review.revision,
      operationId: 'locate-opening',
      action: {
        kind: 'located',
        annotationId: annotated.review.annotations[0]!.id,
        targets: [
          {
            kind: 'video-project',
            baseOwnerRevision: snapshot.ownerRevision,
            baseRevision: snapshot.blobDigest,
            target: { kind: 'segment', segmentId: 'C01' },
          },
        ],
      },
    });
    snapshot.document.timeline.events.push({
      id: 'opening-subtitle',
      kind: 'subtitle',
      startTick: 10,
      durationTicks: 30,
      segmentId: 'C01',
      text: 'Revised opening.',
    });
    const contentReceipt = await integration.projects.save({
      principal,
      contentRef: receipt.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'edit-project',
      document: snapshot.document,
    });
    const addressed = await reviews.act({
      principal: cat,
      reviewId: opened.review.reviewId,
      expectedRevision: (await reviews.read({ principal: cat, reviewId: opened.review.reviewId })).review.revision,
      operationId: 'record-address',
      action: {
        kind: 'addressed',
        annotationId: annotated.review.annotations[0]!.id,
        result: {
          contentRef: contentReceipt.contentRef,
          ownerRevision: contentReceipt.ownerRevision,
          blobDigest: contentReceipt.blobDigest,
          operationId: contentReceipt.operationId,
        },
      },
    });
    const ledgerReceipt = await reviews.operationReceipt({
      principal,
      reviewId: opened.review.reviewId,
      operationId: 'record-address',
    });
    const canonical = (await integration.ledgers?.read({ principal, reviewId: opened.review.reviewId }))?.review;
    assert.deepEqual(canonical?.annotations, addressed.review.annotations);
    assert.deepEqual(integration.store.ledgers.getByContent('operator', receipt.contentRef), canonical);
    assert.deepEqual(addressed.review.annotations[0]!.anchor, annotated.review.annotations[0]!.anchor);
    assert.deepEqual(
      addressed.review.annotations[0]!.projectHistory!.slice(0, -1),
      located.review.annotations[0]!.projectHistory,
    );
    assert.deepEqual(
      (await readdir(join(root, 'collaborative-content'))).filter((path) => path.endsWith('.sqlite')),
      ['artifact-reviews.sqlite'],
    );
    integration.store.close();
    integration = compose();
    assert.deepEqual(
      (await integration.projectReviews?.read({ principal: cat, reviewId: opened.review.reviewId }))?.review,
      addressed.review,
    );
    assert.deepEqual(
      (await integration.ledgers?.read({ principal, reviewId: opened.review.reviewId }))?.review,
      canonical,
    );
    assert.deepEqual(
      await integration.projectReviews?.operationReceipt({
        principal,
        reviewId: opened.review.reviewId,
        operationId: 'record-address',
      }),
      ledgerReceipt,
    );
    assert.equal((await integration.projects.load({ principal, contentRef: receipt.contentRef })).ownerRevision, 2);
  } finally {
    integration.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
