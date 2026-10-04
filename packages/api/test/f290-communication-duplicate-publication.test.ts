import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { documentPayload, duplicatePublicationFixture } from './f290-communication-duplicate-publication.fixture.js';

test('one authenticated document and same-invocation replay keep one prepared result and live acceptance entry', async () => {
  const f = await duplicatePublicationFixture();
  try {
    const artifactRef = await f.publish();
    await f.register(artifactRef);
    const initial = await f.prepared(artifactRef);
    assert.ok(initial, 'actual F232 published-file reader finds the first callback publication');
    const repeated = await f.publish();
    assert.equal(repeated, artifactRef);
    assert.equal((await f.filePublications(artifactRef)).length, 1);
    assert.deepEqual(await f.prepared(artifactRef), initial);
    assert.deepEqual(await readFile(join(f.uploadDir, basename(artifactRef))), Buffer.from(documentPayload.markdown));
    const sealed = await f.sealed();
    assert.ok(sealed && 'textPublication' in sealed && sealed.textPublication);
    await f.returnResult();
    assert.equal((await f.receipt())?.eligible, true);
    assert.deepEqual(await readdir(f.uploadDir), [basename(artifactRef)]);
  } finally {
    await f.close();
  }
});

test('authorized same-Task delegate repeating identical bytes must preserve one published Artifact coordinate', async (t) => {
  const f = await duplicatePublicationFixture();
  try {
    const artifactRef = await f.publish();
    await f.register(artifactRef);
    const initial = await f.prepared(artifactRef);
    assert.ok(initial);
    const relay = await f.relayAuth();
    assert.equal(await f.publish(relay), artifactRef);
    const publications = await f.filePublications(artifactRef);
    const prepared = await f.prepared(artifactRef);
    t.diagnostic(
      JSON.stringify({
        publicationCount: publications.length,
        prepared,
        sourceMessageIds: publications.map((m) => m.id),
      }),
    );
    assert.equal(publications.length, 1, 'repeated immutable bytes are one publication, across same-Task invocations');
    assert.deepEqual(prepared, initial, 'the registered prepared coordinate stays bound to the original publication');
    const sealed = await f.sealed();
    assert.ok(sealed && 'textPublication' in sealed && sealed.textPublication);
  } finally {
    await f.close();
  }
});

test('a registered Artifact unreadable after real duplicate publication must refuse result return instead of dropping its snapshot', async (t) => {
  const f = await duplicatePublicationFixture();
  try {
    const artifactRef = await f.publish();
    await f.register(artifactRef);
    assert.ok(await f.prepared(artifactRef));
    assert.equal(await f.publish(await f.relayAuth()), artifactRef);
    const prepared = await f.prepared(artifactRef);
    // A corrected writer may suppress the duplicate; then the canonical result must retain its sealed snapshot.
    if (prepared) {
      await f.returnResult();
      assert.equal((await f.receipt())?.eligible, true);
    } else {
      t.diagnostic('Actual F232 reader returned null for the registered scoped URL after delegated publication');
      try {
        await assert.rejects(f.returnResult(), { code: 'WORK_ARTIFACT_UNAVAILABLE' });
      } finally {
        t.diagnostic(
          JSON.stringify(
            (await f.resultPublications()).map((publication) => ({
              resultEventId: publication.resultEventId,
              artifactSnapshotPresent: Boolean(publication.artifactSnapshot),
            })),
          ),
        );
      }
      assert.equal(
        (await f.cafe.connector.readAssignedWork(f.cafe.connectionId, f.work.workId)).resultEventId,
        undefined,
      );
    }
  } finally {
    await f.close();
  }
});

test('republication after accepted result_ready must not erase the live F290 result-review entry', async (t) => {
  const f = await duplicatePublicationFixture();
  try {
    const artifactRef = await f.publish();
    await f.register(artifactRef);
    const relay = await f.relayAuth();
    await f.returnResult();
    const before = await f.receipt();
    assert.equal(before?.eligible, true, 'single publication is a real producer GREEN control');
    assert.equal(await f.publish(relay), artifactRef);
    const publications = await f.filePublications(artifactRef);
    const after = await f.receipt();
    t.diagnostic(
      JSON.stringify({ publicationCount: publications.length, eligibleBefore: before?.eligible, receiptAfter: after }),
    );
    assert.ok(after?.eligible, 'same Task bytes must not retire an already prepared review entry');
    assert.deepEqual(after, before);
    assert.equal(publications.length, 1);
  } finally {
    await f.close();
  }
});

test('a registered scoped Artifact with missing actual bytes already fails closed before result publication', async () => {
  const f = await duplicatePublicationFixture();
  try {
    const artifactRef = await f.publish();
    await f.register(artifactRef);
    await f.removeBytes(artifactRef);
    await assert.rejects(f.returnResult(), { code: 'WORK_ARTIFACT_UNAVAILABLE' });
    assert.equal(
      (await f.cafe.connector.readAssignedWork(f.cafe.connectionId, f.work.workId)).resultEventId,
      undefined,
    );
  } finally {
    await f.close();
  }
});

test('registered Artifact with a genuinely soft-deleted publication refuses result return even without duplicates', async () => {
  const f = await duplicatePublicationFixture();
  try {
    const artifactRef = await f.publish();
    await f.register(artifactRef);
    const publications = await f.filePublications(artifactRef);
    assert.equal(publications.length, 1);
    const deleted = await f.messages.softDelete(publications[0].id, f.cafe.ownerUserId);
    assert.ok(deleted?.deletedAt);
    assert.equal(await f.prepared(artifactRef), null, 'real publication reader cannot resolve the registered ref');
    await assert.rejects(f.returnResult(), { code: 'WORK_ARTIFACT_UNAVAILABLE' });
    assert.equal(
      (await f.cafe.connector.readAssignedWork(f.cafe.connectionId, f.work.workId)).resultEventId,
      undefined,
    );
  } finally {
    await f.close();
  }
});

test('distinct real document bytes in the same current execution remain distinct available publications', async () => {
  const f = await duplicatePublicationFixture();
  try {
    const first = await f.publish();
    const second = await f.publish(f.auth, `${documentPayload.markdown}\nA new section.\n`);
    assert.notEqual(first, second);
    assert.equal((await f.filePublications(first)).length, 1);
    assert.equal((await f.filePublications(second)).length, 1);
    assert.ok(await f.prepared(first));
    assert.ok(await f.prepared(second));
    await f.register(second);
    const sealed = await f.sealed();
    assert.ok(sealed && 'textPublication' in sealed && sealed.textPublication);
  } finally {
    await f.close();
  }
});
