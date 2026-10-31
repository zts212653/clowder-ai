import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('unrelated closed Tasks do not repeatedly deserialize the same review during Artifact discovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-context-scale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'review-input.png'),
    await sharp({
      create: { width: 80, height: 50, channels: 3, background: '#eee4d5' },
    })
      .png()
      .toBuffer(),
  );
  const f = await createLiveReviewFixture(root);
  t.after(() => f.store.close());
  const view = await f.reviews.prepare(f.prepare, f.human);
  const originalTask = f.tasks.get(f.taskId);
  assert.ok(originalTask?.entrustedWork);
  await f.lifecycle.close({
    taskId: f.taskId,
    expectedRevision: 1,
    closure: {
      ...originalTask.entrustedWork.closure,
      state: 'satisfied',
      evidenceRefs: [view.continuation.reviewEvidenceRef],
    },
  });

  let bodyReads = 0;
  let publicationReads = 0;
  const publicationRead = f.publications.readPreparedArtifact.bind(f.publications);
  f.publications.readPreparedArtifact = (input) => {
    publicationReads += 1;
    return publicationRead(input);
  };
  const get = f.store.get.bind(f.store);
  f.store.get = (reviewId) => {
    const review = get(reviewId);
    if (review) bodyReads += 1;
    return review;
  };
  if (typeof f.store.listForTask === 'function') {
    const listForTask = f.store.listForTask.bind(f.store);
    f.store.listForTask = (...args) => {
      const reviews = listForTask(...args);
      bodyReads += reviews.length;
      return reviews;
    };
  }
  const input = { threadId: f.thread.id, artifactRef: f.prepare.artifactRef };
  const baseline = await f.contexts(input, f.human);
  assert.equal(baseline.length, 1);
  const baselineBodyReads = bodyReads;
  const baselinePublicationReads = publicationReads;

  for (let index = 0; index < 24; index += 1) {
    const admitted = await f.lifecycle.admitOrResume({
      task: {
        threadId: f.thread.id,
        userId: 'operator',
        ownerCatId: originalTask.ownerCatId,
        createdBy: originalTask.createdBy,
        title: `已完成的独立任务 ${index}`,
        why: '长期线程中的历史任务',
      },
      admission: {
        basis: 'explicit_entrustment',
        idempotencyKey: `unrelated-${index}`,
        sourceRefs: ['message:unrelated-entrustment'],
        intendedOutcome: '完成独立产物',
      },
      closure: { condition: '独立任务已完成', expectedSignal: 'finished' },
      time: {},
      artifactRefs: [`/uploads/unrelated-${index}.png`],
    });
    assert.ok('subjectRef' in admitted && admitted.subjectRef);
    const taskId = admitted.subjectRef.replace(/^task:work:/, '');
    const task = f.tasks.get(taskId);
    assert.ok(task?.entrustedWork);
    await f.lifecycle.close({
      taskId,
      expectedRevision: 1,
      closure: { ...task.entrustedWork.closure, state: 'satisfied', evidenceRefs: ['message:finished'] },
    });
  }
  bodyReads = 0;
  publicationReads = 0;
  assert.deepEqual(await f.contexts(input, f.human), baseline);
  t.diagnostic(`review bodies loaded: baseline=${baselineBodyReads}, with24 unrelated closed Tasks=${bodyReads}`);
  assert.equal(bodyReads, baselineBodyReads, 'unrelated closed Tasks must not reload this review body');
  assert.equal(
    publicationReads,
    baselinePublicationReads,
    'closed Tasks without this review must not rescan the publication feed',
  );
  assert.deepEqual(await f.contexts(input, { userId: 'other', actor: { kind: 'human', actorId: 'other' } }), []);
  assert.equal(f.store.listReviewIds('operator').length, 1);
});
