import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';

await import('tsx/esm');
const { ArtifactReviewStore } = await import('../src/domains/collaborative-content/artifact-review/store.ts');
const { AcceptedWorkspaceArtifactReader, projectAppliedWorkspaceReceipts } = await import(
  '../src/domains/collaborative-content/modification/accepted-workspace-artifacts.ts'
);
const { WorkspaceWritebackService } = await import('../src/domains/workspace/writeback/service.ts');
const { acceptedFileFixture } = await import('./helpers/accepted-workspace-artifact-fixture.ts');

test('a real Human-accepted F309 text result reaches thread Works as the original F063 file', async (t) => {
  const f = await acceptedFileFixture(t);
  const before = await f.get();
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(
    before.json().artifacts.some((a) => a.fileLedgerRef),
    false,
    'an unaccepted candidate is not a file result',
  );
  const accepted = await f.accept();
  assert.equal(accepted.statusCode, 200, accepted.body);
  const receipt = accepted.json().receipt;
  assert.equal(receipt.state, 'applied');
  const originalPath = await realpath(join(f.root, f.locator.path));
  const originalBytes = await readFile(originalPath);
  const recordBefore = f.store.requests.get(f.request.requestId, 'operator');
  const messagesBefore = structuredClone(await f.messages.getByThread(f.thread.id, 200, 'operator'));
  const host = messagesBefore.find((m) => m.extra?.contentModificationReceiptV1?.receiptRef === receipt.receiptRef);
  assert.ok(host, 'the normal owner emits its applied Host receipt');

  const read = await f.get();
  assert.equal(read.statusCode, 200, read.body);
  const items = read.json().artifacts.filter((a) => a.fileLedgerRef === originalPath);
  assert.equal(
    items.length,
    1,
    'applied F309 result must appear without Edit/Write events or a fabricated message publication',
  );
  assert.equal(items[0].ref, originalPath);
  assert.equal(items[0].type, 'file');
  assert.equal(items[0].name, 'guide.md');
  assert.equal(items[0].catId, 'codex-astra');
  assert.equal(items[0].createdAt, receipt.appliedAt);
  assert.equal(items[0].sourceMessageId, host.id);
  assert.equal(items[0].url, undefined, 'an applied original file is not an uploads copy');
  assert.equal(items[0].work, undefined, 'F063 SHA is not an F138 owner revision');
  assert.deepEqual(
    (await f.get()).json().artifacts,
    read.json().artifacts,
    'repeat reads retain the same natural object',
  );
  assert.deepEqual(await readFile(originalPath), originalBytes, 'Works reads never write file bytes');
  assert.deepEqual(f.store.requests.get(f.request.requestId, 'operator'), recordBefore);
  assert.deepEqual(await f.messages.getByThread(f.thread.id, 200, 'operator'), messagesBefore);
});

test('current source recall prevents an applied original file from becoming an artifact capability', async (t) => {
  const f = await acceptedFileFixture(t);
  assert.equal((await f.accept()).statusCode, 200);
  f.message.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
  const read = await f.get();
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(
    read.json().artifacts.some((a) => a.fileLedgerRef),
    false,
  );
});

test('the original explicit file request path publishes its accepted result without a new Human or native write', async (t) => {
  const f = await acceptedFileFixture(t, true);
  assert.equal(f.request.progress.sourceKind, 'generated_request');
  assert.equal((await f.accept()).statusCode, 200);
  const before = structuredClone(await f.messages.getByThread(f.thread.id, 200, 'operator'));
  const item = (await f.get()).json().artifacts.find((a) => a.fileLedgerRef);
  assert.equal(item.fileLedgerRef, await realpath(join(f.root, f.locator.path)));
  assert.deepEqual(await f.messages.getByThread(f.thread.id, 200, 'operator'), before);
});

test('current root revocation prevents an applied original file from entering Works', async (t) => {
  const f = await acceptedFileFixture(t);
  assert.equal((await f.accept()).statusCode, 200);
  f.revoke();
  const read = await f.get();
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(
    read.json().artifacts.some((a) => a.fileLedgerRef),
    false,
  );
});

test('the original thread access guard runs before the accepted-result reader', async (t) => {
  const f = await acceptedFileFixture(t);
  assert.equal((await f.accept()).statusCode, 200);
  let reads = 0;
  f.holder.current = {
    read: async () => {
      reads += 1;
      return [];
    },
  };
  const read = await f.get('bob');
  assert.equal(read.statusCode, 403);
  assert.equal(reads, 0);
});

test('historical applied receipts reach thread and full global Works after owner reopen without a new message', async (t) => {
  const f = await acceptedFileFixture(t);
  assert.equal((await f.accept()).statusCode, 200);
  for (let i = 0; i < 205; i++)
    f.messages.append({
      userId: 'operator',
      threadId: f.thread.id,
      from: { kind: 'user', userId: 'operator' },
      mentions: [],
      timestamp: Date.now() + i,
      content: `Later ordinary message ${i}`,
    });
  const writer = new WorkspaceWritebackService({
    source: f.source,
    databasePath: join(f.root, 'workspace/writebacks.sqlite'),
    proofDirectory: join(f.root, 'workspace/writeback-proofs'),
  });
  const store = new ArtifactReviewStore(join(f.root, 'collaborative-content/artifact-reviews.sqlite'));
  t.after(() => writer.close());
  t.after(() => store.close());
  f.holder.current = new AcceptedWorkspaceArtifactReader({ store, messages: f.messages, writer });
  const before = structuredClone(await f.messages.getByThread(f.thread.id, 1000, 'operator'));
  const reopened = await f.holder.current.read({
    ownerUserId: 'operator',
    threadId: f.thread.id,
    receipts: projectAppliedWorkspaceReceipts(before),
  });
  assert.equal(reopened.length, 1, 'reopened durable owners resolve the historical applied result');
  const thread = await f.get();
  const global = await f.get('operator', '/api/artifacts');
  assert.equal(thread.statusCode, 200, thread.body);
  assert.equal(global.statusCode, 200, global.body);
  const item = thread.json().artifacts.find((a) => a.fileLedgerRef);
  assert.ok(item, 'an applied receipt beyond the first 200 messages still contributes');
  assert.deepEqual(
    global.json().artifacts.find((a) => a.fileLedgerRef),
    {
      ...item,
      threadId: f.thread.id,
      threadTitle: f.thread.title,
    },
  );
  assert.equal(
    (await f.get('bob', '/api/artifacts')).json().artifacts.some((a) => a.fileLedgerRef),
    false,
  );
  assert.equal(
    (await f.get('operator', '/api/artifacts?view=recent-works&limit=10'))
      .json()
      .artifacts.some((a) => a.fileLedgerRef),
    false,
    'the separate publication-only recent view keeps its declared scope',
  );
  assert.deepEqual(await f.messages.getByThread(f.thread.id, 1000, 'operator'), before);
});

test('root rebinding cannot redirect an applied file capability to a same-name replacement', async (t) => {
  const f = await acceptedFileFixture(t);
  assert.equal((await f.accept()).statusCode, 200);
  await f.rebind();
  assert.equal(
    (await f.get()).json().artifacts.some((a) => a.fileLedgerRef),
    false,
  );
});

test('a later authorized edit remains the same original file without claiming its historical bytes as current', async (t) => {
  const f = await acceptedFileFixture(t);
  assert.equal((await f.accept()).statusCode, 200);
  const path = await realpath(join(f.root, f.locator.path));
  await writeFile(path, 'Later Human edit.\n');
  const item = (await f.get()).json().artifacts.find((a) => a.fileLedgerRef);
  assert.equal(item.fileLedgerRef, path);
  assert.equal(item.work, undefined);
  assert.equal(item.revision, undefined);
  assert.equal(await readFile(path, 'utf8'), 'Later Human edit.\n');
});

for (const mutate of ['user', 'sender', 'task', 'candidate', 'receipt', 'source', 'target', 'time']) {
  test(`an apparent applied Host with a mismatched ${mutate} cannot mint an original file`, async (t) => {
    const f = await acceptedFileFixture(t);
    assert.equal((await f.accept()).statusCode, 200);
    const host = (await f.messages.getByThread(f.thread.id, 200, 'operator')).find(
      (m) => m.extra?.contentModificationReceiptV1?.state === 'applied',
    );
    const receipt = host.extra.contentModificationReceiptV1;
    if (mutate === 'user') host.userId = 'other-owner';
    else if (mutate === 'sender') host.from = { kind: 'user', userId: 'operator' };
    else if (mutate === 'source') {
      host.replyTo = f.message.id + '-other';
      receipt.sourceMessageId = host.replyTo;
    } else if (mutate === 'time') receipt.observedAt += 1;
    else
      receipt[{ receipt: 'receiptRef', candidate: 'candidateRef', task: 'taskId', target: 'targetCatId' }[mutate]] +=
        '-other';
    assert.equal(
      (await f.get()).json().artifacts.some((a) => a.fileLedgerRef),
      false,
    );
  });
}

test('rejected and conflicted candidates never become Works results', async (t) => {
  const rejected = await acceptedFileFixture(t);
  const rejection = await rejected.app.inject({
    method: 'POST',
    url: `/api/content-modifications/${rejected.request.requestId}/reject`,
    headers: { 'x-cat-cafe-user': 'operator' },
    payload: { candidateRef: rejected.returned.proposal.proposalRef },
  });
  assert.equal(rejection.statusCode, 200, rejection.body);
  assert.equal(
    (await rejected.get()).json().artifacts.some((a) => a.fileLedgerRef),
    false,
  );
  const conflicted = await acceptedFileFixture(t);
  await writeFile(join(conflicted.root, conflicted.locator.path), 'External changed bytes.\n');
  const acceptance = await conflicted.accept();
  assert.equal(acceptance.statusCode, 200, acceptance.body);
  assert.equal(acceptance.json().receipt.state, 'conflict');
  assert.equal(
    (await conflicted.get()).json().artifacts.some((a) => a.fileLedgerRef),
    false,
  );
});

test('missing accepted-result and lineage owners preserve ordinary artifacts without work coordinates', async (t) => {
  const f = await acceptedFileFixture(t);
  assert.equal((await f.accept()).statusCode, 200);
  f.messages.append({
    userId: 'operator',
    from: { kind: 'agent', catId: 'codex-astra' },
    threadId: f.thread.id,
    mentions: [],
    timestamp: Date.now(),
    content: 'An independent original publication.',
    extra: {
      rich: { blocks: [{ kind: 'file', v: 1, id: 'ordinary', url: '/uploads/ordinary.md', fileName: 'ordinary.md' }] },
    },
  });
  for (const reader of [
    undefined,
    {
      read: async () => {
        throw new Error('owner read unavailable');
      },
    },
  ]) {
    f.holder.current = reader;
    for (const url of [`/api/threads/${f.thread.id}/artifacts`, '/api/artifacts']) {
      const response = await f.get('operator', url);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().workLineage, 'unavailable');
      assert.ok(response.json().artifacts.every((a) => a.work === undefined));
      assert.ok(response.json().artifacts.some((a) => a.url === '/uploads/ordinary.md'));
      assert.equal(
        response.json().artifacts.some((a) => a.fileLedgerRef),
        false,
      );
    }
  }
});

for (const scope of ['thread', 'global']) {
  test(`${scope} Works preserves resolved F138 lineage when the accepted-file owner is unavailable`, async (t) => {
    const f = await acceptedFileFixture(t);
    assert.equal((await f.accept()).statusCode, 200);
    const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#f5b942' } })
      .png()
      .toBuffer();
    await writeFile(join(f.root, 'review-input.png'), png);
    const retained = await f.media.prepare({ ...f.prepare, principal: f.human });
    f.lineageHolder.current = f.globalArtifactWorkLineage;
    const url = scope === 'thread' ? `/api/threads/${f.thread.id}/artifacts` : '/api/artifacts';
    const before = (await f.get('operator', url)).json();
    assert.ok(
      before.artifacts.some((a) => a.fileLedgerRef),
      'the independent accepted-file owner is healthy',
    );
    for (const reader of [
      undefined,
      {
        read: async () => {
          throw new Error('accepted-file owner unavailable');
        },
      },
    ]) {
      f.holder.current = reader;
      const response = await f.get('operator', url);
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      const media = body.artifacts.find((a) => a.sourceMessageId === f.publication.id);
      assert.deepEqual(
        media?.work,
        {
          contentRef: retained.contentRef,
          ownerRevision: retained.ownerRevision,
          currentOwnerRevision: retained.ownerRevision,
        },
        'healthy F138 coordinates survive independent accepted-file degradation',
      );
      assert.equal(body.workLineage, 'resolved', 'the F138 status describes only the F138 owner');
      assert.deepEqual(
        body.artifacts,
        before.artifacts.filter((a) => !a.fileLedgerRef),
      );
    }
    f.holder.current = f.integration.workspaceArtifacts;
    f.lineageHolder.current = undefined;
    const degradedLineage = (await f.get('operator', url)).json();
    assert.equal(degradedLineage.workLineage, 'unavailable');
    assert.ok(degradedLineage.artifacts.every((a) => a.work === undefined));
    assert.ok(
      degradedLineage.artifacts.some((a) => a.fileLedgerRef),
      'F138 failure preserves the independent original file',
    );
  });
}
