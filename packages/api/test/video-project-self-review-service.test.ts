import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectSelfReviewService } from '../src/domains/video-studio/project/self-review.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectDocumentFixture, projectHumanFixture } from './helpers/video-project-fixture.js';

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-attestation-'));
  const owner = new ProjectContentOwnerService({ dataDir });
  const projects = new VideoProjectService({ owner, ownerUserId: 'operator', authorizeCat: async () => {} });
  const created = await projects.create({
    principal: projectHumanFixture,
    operationId: 'create',
    document: projectDocumentFixture,
  });
  const principal = {
    userId: 'operator',
    actor: { kind: 'cat' as const, actorId: 'sol' },
    invocationId: 'cat-authenticated-turn',
  };
  const request = {
    principal,
    contentRef: created.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'attest-C01',
    id: 'review-C01',
    input: { contentRef: created.contentRef, ownerRevision: 1, blobDigest: created.blobDigest },
    segmentIds: ['C01'],
    conclusion: 'pass' as const,
    refs: ['review-evidence:actual-C01'],
  };
  const make = (projectService = projects) =>
    new VideoProjectSelfReviewService({
      projects: projectService,
      appendSelfReview: (command) => projectService.appendSelfReview(command),
      // A named test-only source grant. This does not claim the production invocation/source verifier is wired.
      authorizeSource: async () => ({ refs: ['message:verified-original-human-source'] }),
      now: () => '2026-10-10T00:00:00.000Z',
    });
  return { owner, projects, dataDir, request, make, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

test('self-review needs authenticated own Cat and a separate verified source grant', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const denied = new VideoProjectSelfReviewService({
    projects: f.projects,
    appendSelfReview: (input) => f.projects.appendSelfReview(input),
  });
  await assert.rejects(denied.attest(f.request), /access denied/);
  await assert.rejects(f.make().attest({ ...f.request, principal: projectHumanFixture }), /access denied/);
  await assert.rejects(
    f.make().attest({ ...f.request, principal: { ...f.request.principal, invocationId: undefined } }),
    /access denied/,
  );
});

test('actual owner command binds Cat/input/segments/evidence, persists and replays across authenticated turns', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const saved = await f.make().attest(f.request);
  assert.equal(saved.receipt.ownerRevision, 2);
  assert.deepEqual(saved.selfReview.actor, f.request.principal.actor);
  assert.equal(saved.selfReview.input.ownerRevision, 1);
  assert.ok(saved.selfReview.refs.includes('invocation:cat-authenticated-turn'));
  assert.ok(saved.selfReview.refs.includes('message:verified-original-human-source'));
  const restarted = new VideoProjectService({
    owner: new ProjectContentOwnerService({ dataDir: f.dataDir }),
    ownerUserId: 'operator',
    authorizeCat: async () => {},
  });
  assert.deepEqual((await restarted.load(f.request)).document.selfReviews, [saved.selfReview]);
  assert.deepEqual(
    await f
      .make(restarted)
      .attest({ ...f.request, principal: { ...f.request.principal, invocationId: 'new-authenticated-turn' } }),
    saved,
  );
  await assert.rejects(f.make().attest({ ...f.request, conclusion: 'changes-requested' }), /reused/);
});

test('unknown segments, wrong input digest and ordinary fact edits cannot create an attestation', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await assert.rejects(f.make().attest({ ...f.request, segmentIds: ['invented'] }), /real segments/);
  await assert.rejects(
    f.make().attest({ ...f.request, input: { ...f.request.input, blobDigest: `sha256:${'f'.repeat(64)}` } }),
    /exact existing input/,
  );
  const saved = await f.make().attest(f.request);
  const snapshot = await f.projects.load(f.request);
  for (const selfReviews of [[], [{ ...saved.selfReview, conclusion: 'changes-requested' }]]) {
    await assert.rejects(
      f.projects.save({
        ...f.request,
        operationId: `ordinary-${selfReviews.length}`,
        expectedOwnerRevision: 2,
        document: { ...snapshot.document, selfReviews },
      }),
      /registration/,
    );
  }
});
