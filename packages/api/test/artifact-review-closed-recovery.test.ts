import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { promisify } from 'node:util';
import type { ArtifactReviewAction, ArtifactReviewView } from '@cat-cafe/shared';
import sharp from 'sharp';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

async function writeMedia(file: string, kind: 'png' | 'mp4', color: string) {
  if (kind === 'png') {
    await writeFile(
      file,
      await sharp({ create: { width: 160, height: 100, channels: 3, background: color } })
        .png()
        .toBuffer(),
    );
  } else {
    await promisify(execFile)(
      'ffmpeg',
      ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x100:r=25:d=0.12`, '-c:v', 'libx264', file],
      { timeout: 15000 },
    );
  }
}

async function fixture(t: TestContext, kind: 'png' | 'mp4') {
  const root = await mkdtemp(join(tmpdir(), `f309-closed-${kind}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeMedia(join(root, `review-input.${kind}`), kind, 'blue');
  const f = await createLiveReviewFixture(root, kind === 'png' ? 'image/png' : 'video/mp4');
  t.after(() => f.store.close());
  return { ...f, root };
}

async function completedLineage(f: Fixture, kind: 'png' | 'mp4', pointer: 'content' | 'latest') {
  let view = await f.reviews.prepare(f.prepare, f.human);
  const publications = [f.publication];
  for (const round of [1, 2]) {
    const media = view.review.rounds.at(-1)?.asset.media;
    assert.ok(media);
    const anchor =
      media.kind === 'image'
        ? { kind: 'image-region' as const, x: 10, y: 10, width: 40, height: 30 }
        : { kind: 'video-range' as const, streamId: media.streamId, startTick: 0, endTick: media.durationTicks };
    view = (
      await f.reviews.act(
        command(view, {
          kind: 'annotate',
          annotationId: `note-${round}`,
          anchor,
          body: `第 ${round} 版的保留意见`,
        }),
        f.human,
      )
    ).view;
    view = (
      await f.reviews.act(
        command(view, {
          kind: 'submit_feedback',
          explanation: `请修改第 ${round} 版`,
        }),
        f.human,
      )
    ).view;
    const name = `review-version-${round + 1}.${kind}`;
    await writeMedia(join(f.root, name), kind, round === 1 ? 'red' : 'green');
    const publication = f.publish(name);
    publications.push(publication);
    view = (
      await f.reviews.respond(
        {
          reviewId: view.review.reviewId,
          expectedRevision: view.review.revision,
          expectedTaskRevision: view.authority.taskRevision,
          expectedOwnerRevision: round,
          operationId: `version-${round + 1}`,
          artifactRef: `/uploads/${name}`,
          expectedArtifactRevision: String(publication.timestamp),
          responses: [{ annotationId: `note-${round}`, disposition: 'addressed', explanation: '本版已修改' }],
        },
        f.cat,
      )
    ).view;
    if (pointer === 'latest' || round === 1)
      await f.lifecycle.update({
        taskId: f.taskId,
        expectedRevision: view.authority.taskRevision,
        artifactRefs: [pointer === 'content' ? `content:${view.review.contentRef}` : `/uploads/${name}`],
      });
    view = await f.reviews.read(view.review.reviewId, f.human);
    view = (
      await f.reviews.act(
        command(view, {
          kind: 'request_judgment',
          summary: '新版准备好',
          judgmentNeeded: '请确认',
        }),
        f.cat,
      )
    ).view;
  }
  view = (
    await f.reviews.act(
      command(view, {
        kind: 'decide',
        outcome: 'approved',
        explanation: '最终版通过',
      }),
      f.human,
    )
  ).view;
  const taskRevision = await closeTask(f, view.continuation.reviewEvidenceRef);
  return { view, taskRevision, publications };
}

for (const kind of ['png', 'mp4'] as const) {
  for (const pointer of ['content', 'latest'] as const) {
    test(`${kind}: closed ${pointer} Task discovers original, middle and latest review publications`, async (t) => {
      const f = await fixture(t, kind);
      const { view, taskRevision } = await completedLineage(f, kind, pointer);
      const beforeTask = structuredClone(f.tasks.get(f.taskId));
      const beforeHistory = f.store.history(view.review.reviewId);
      for (const round of view.review.rounds) {
        const input = { threadId: f.thread.id, artifactRef: round.asset.sourcePublication.artifactRef };
        const contexts = await f.contexts(input, f.human);
        assert.equal(contexts.length, 1, `round ${round.number} must resolve through retained lineage`);
        assert.equal(contexts[0]?.expectedTaskRevision, taskRevision);
        assert.equal(contexts[0]?.expectedArtifactRevision, '3');
      }
      const unrelated = f.publish(`unrelated.${kind}`);
      assert.ok(unrelated);
      assert.deepEqual(
        await f.contexts({ threadId: f.thread.id, artifactRef: `/uploads/unrelated.${kind}` }, f.human),
        [],
      );
      assert.deepEqual(f.tasks.get(f.taskId), beforeTask);
      assert.deepEqual(f.store.history(view.review.reviewId), beforeHistory);
      assert.equal(f.store.listReviewIds('operator').length, 1);
    });

    test(`${kind}: closed ${pointer} Task prepares only its authorized retained review lineage`, async (t) => {
      const f = await fixture(t, kind);
      const { view, taskRevision, publications } = await completedLineage(f, kind, pointer);
      const before = f.store.history(view.review.reviewId);
      const artifacts = [
        `content:${view.review.contentRef}`,
        ...view.review.rounds.map((r) => r.asset.sourcePublication.artifactRef),
      ];
      for (const artifactRef of artifacts) {
        const input = { ...f.prepare, artifactRef, expectedTaskRevision: taskRevision, expectedArtifactRevision: '3' };
        for (const principal of [f.human, f.cat]) {
          const restored = await f.reviews.prepare(input, principal);
          assert.deepEqual(restored.review, view.review);
          assert.equal(restored.authority.canWrite, false);
          assert.equal(restored.authority.state, 'task_closed');
          await assert.rejects(
            f.reviews.prepare({ ...input, expectedTaskRevision: taskRevision - 1 }, principal),
            /task_changed/,
          );
          await assert.rejects(
            f.reviews.prepare({ ...input, expectedArtifactRevision: 'stale' }, principal),
            /asset_changed/,
          );
        }
      }
      const original = { ...f.prepare, expectedTaskRevision: taskRevision, expectedArtifactRevision: '3' };
      await assert.rejects(
        f.reviews.prepare(original, { userId: 'other', actor: { kind: 'human', actorId: 'other' } }),
        /access_denied/,
      );
      await assert.rejects(f.reviews.prepare(original, { ...f.cat, threadId: 'other-thread' }), /access_denied/);
      await assert.rejects(
        f.reviews.prepare({ ...original, artifactRef: `/uploads/unrelated.${kind}` }, f.human),
        /task_changed|task_closed/,
      );
      const withdrawn = publications[pointer === 'content' ? 0 : 2];
      assert.ok(withdrawn);
      f.messages.softDelete(withdrawn.id, 'operator');
      assert.deepEqual(await f.contexts({ threadId: f.thread.id, artifactRef: f.prepare.artifactRef }, f.human), []);
      await assert.rejects(f.reviews.prepare(original, f.human), /access_denied/);
      assert.deepEqual(f.store.history(view.review.reviewId), before);
    });
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function command(view: ArtifactReviewView, action: ArtifactReviewAction) {
  return {
    reviewId: view.review.reviewId,
    expectedRevision: view.review.revision,
    expectedTaskRevision: view.authority.taskRevision,
    operationId: randomUUID(),
    round: view.review.rounds.at(-1)?.number ?? 1,
    action,
  };
}

async function approve(f: Fixture) {
  let view = await f.reviews.prepare(f.prepare, f.human);
  view = (
    await f.reviews.act(
      command(view, { kind: 'request_judgment', summary: '完成审阅', judgmentNeeded: '请确认该产物' }),
      f.cat,
    )
  ).view;
  return (
    await f.reviews.act(command(view, { kind: 'decide', outcome: 'approved', explanation: '本版已通过。' }), f.human)
  ).view;
}

async function closeTask(f: Fixture, evidenceRef = `message:${f.thread.id}:${f.publication.id}`) {
  const task = f.tasks.get(f.taskId);
  assert.ok(task?.entrustedWork);
  const closed = await f.lifecycle.close({
    taskId: f.taskId,
    expectedRevision: task.entrustedWork.revision,
    closure: { ...task.entrustedWork.closure, state: 'satisfied', evidenceRefs: [evidenceRef] },
  });
  assert.ok(closed.entrustedWork);
  return closed.entrustedWork.revision;
}

for (const kind of ['png', 'mp4'] as const) {
  test(`${kind}: the original Artifact discovers a closed Task's retained read-only review`, async (t) => {
    const f = await fixture(t, kind);
    const approved = await approve(f);
    const revision = await closeTask(f, approved.continuation.reviewEvidenceRef);
    const beforeTask = structuredClone(f.tasks.get(f.taskId));
    const beforeHistory = f.store.history(approved.review.reviewId);
    const beforeEffects = await f.owner.listOutbox(approved.review.contentRef);
    const input = { threadId: f.thread.id, artifactRef: f.prepare.artifactRef };

    for (const principal of [f.human, f.cat]) {
      const contexts = await f.contexts(input, principal);
      assert.equal(contexts.length, 1, 'completed work must retain its original Artifact history entry');
      assert.equal(contexts[0]?.taskId, f.taskId);
      assert.equal(contexts[0]?.expectedTaskRevision, revision);
      const found = contexts[0];
      assert.ok(found);
      const { title: _title, ...context } = found;
      const restored = await f.reviews.prepare({ ...context, operationId: randomUUID() }, principal);
      assert.equal(restored.review.reviewId, approved.review.reviewId);
      assert.deepEqual(restored.review, approved.review);
      assert.equal(restored.authority.state, 'task_closed');
      assert.equal(restored.authority.canWrite, false);
      await assert.rejects(
        f.reviews.act(command(restored, { kind: 'reopen', explanation: '不能修改已收口任务' }), principal),
        /task_closed/,
      );
    }
    assert.deepEqual(f.tasks.get(f.taskId), beforeTask);
    assert.deepEqual(f.store.history(approved.review.reviewId), beforeHistory);
    assert.deepEqual(await f.owner.listOutbox(approved.review.contentRef), beforeEffects);
    assert.equal(f.store.listReviewIds('operator').length, 1);
    assert.deepEqual(await f.contexts(input, { userId: 'other', actor: { kind: 'human', actorId: 'other' } }), []);
    await assert.rejects(f.contexts(input, { ...f.cat, threadId: 'another-thread' }), /access_denied/);
    f.messages.softDelete(f.publication.id, 'operator');
    assert.deepEqual(await f.contexts(input, f.human), [], 'withdrawn history must disappear from discovery');
    await assert.rejects(
      f.reviews.prepare({ ...f.prepare, expectedTaskRevision: revision, operationId: randomUUID() }, f.human),
      /access_denied/,
    );
  });

  test(`${kind}: closed canonical review recovery retains revision and publication authority fences`, async (t) => {
    const f = await fixture(t, kind);
    const approved = await approve(f);
    const artifactRef = `content:${approved.review.contentRef}`;
    await f.lifecycle.update({ taskId: f.taskId, expectedRevision: 1, artifactRefs: [artifactRef] });
    const revision = await closeTask(f, approved.continuation.reviewEvidenceRef);
    const input = {
      ...f.prepare,
      artifactRef,
      expectedTaskRevision: revision,
      expectedArtifactRevision: String(approved.review.rounds[0]?.asset.ownerRevision),
      operationId: randomUUID(),
    };
    const restored = await f.reviews.prepare(input, f.human);
    assert.deepEqual(restored.review, approved.review);
    assert.equal(restored.authority.canWrite, false);
    await assert.rejects(f.reviews.prepare({ ...input, expectedTaskRevision: revision - 1 }, f.human), /task_changed/);
    await assert.rejects(f.reviews.prepare({ ...input, expectedArtifactRevision: 'stale' }, f.human), /asset_changed/);
    await assert.rejects(
      f.reviews.prepare(input, { userId: 'other', actor: { kind: 'human', actorId: 'other' } }),
      /access_denied/,
    );
    await assert.rejects(f.reviews.prepare(input, { ...f.cat, threadId: 'another-thread' }), /access_denied/);
    f.messages.softDelete(f.publication.id, 'operator');
    await assert.rejects(f.reviews.prepare(input, f.human), /access_denied/);
    await assert.rejects(f.reviews.mediaBytes(approved.review.reviewId, 1, f.human), /access_denied/);
    assert.equal(f.store.get(approved.review.reviewId)?.revision, approved.review.revision);
  });

  test(`${kind}: completing an unreviewed Task never advertises or imports a new review`, async (t) => {
    const f = await fixture(t, kind);
    const input = { threadId: f.thread.id, artifactRef: f.prepare.artifactRef };
    assert.equal((await f.contexts(input, f.human)).length, 1, 'the active publication was discoverable');
    const revision = await closeTask(f);
    let imports = 0;
    const importContent = f.owner.importContent.bind(f.owner);
    f.owner.importContent = async (...args) => {
      imports += 1;
      return importContent(...args);
    };
    assert.deepEqual(await f.contexts(input, f.human), [], 'a closed Task without history has nothing to reopen');
    await assert.rejects(
      f.reviews.prepare({ ...f.prepare, expectedTaskRevision: revision, operationId: randomUUID() }, f.human),
      /task_closed/,
    );
    assert.deepEqual(f.store.listReviewIds('operator'), []);
    assert.equal(imports, 0, 'the content owner must reject new admission before any import');
  });
}
