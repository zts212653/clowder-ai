import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollectiveMarkdownOwner } from '../src/domains/collaborative-content/collective-artifact/markdown-owner.js';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { custodyAuthority, custodyTransfer, emptyCustodyOwner } from './collective-custody-transfer.fixture.js';
import { baseConstraint, fixture, scope, text } from './collective-markdown.fixture.js';

test('the unified owner port stages all pages, survives reconstruction, activates only after commit and permanently retires source effects', async (t) => {
  const f = await fixture(t);
  const target = await emptyCustodyOwner(t);
  for (let index = 0; index < 3; index++) {
    assert.equal(
      (
        await f.execute(
          { ...baseConstraint, action: 'annotate' },
          {
            kind: 'annotate',
            messageEventId: `large-note-${index}`,
            body: '字'.repeat(8000),
            quote: 'A unique shared quote.',
            location: { channelId: 'general', rootEventId: scope.sourceEventId },
            expectedReviewRevision: index + 1,
          },
          `large-note-${index}`,
        )
      ).status,
      'ok',
    );
  }
  let transfer = await custodyTransfer(f.owner);
  const sourceAuthority = custodyAuthority(() => transfer, 'source');
  const targetAuthority = custodyAuthority(() => transfer, 'target');
  assert.ok(f.port.custody);
  const prepared = await f.port.custody.prepareSource(transfer, sourceAuthority);
  assert.deepEqual(await f.port.custody.prepareSource(transfer, sourceAuthority), prepared);
  assert.ok(prepared.manifest.pageCount > 1);
  const reopenedSource = new CollectiveMarkdownOwner({
    owner: new ProjectContentOwnerService({ dataDir: f.dataDir }),
    reviews: f.reviews,
    modifications: f.modifications,
    ownerUserId: 'real-local-owner',
    custodyDataDir: f.dataDir,
  });
  assert.ok(reopenedSource.custody);
  assert.deepEqual(await reopenedSource.custody.prepareSource(transfer, sourceAuthority), prepared);
  transfer = { ...transfer, state: 'source_prepared', prepared };
  const first = await reopenedSource.custody.readPage(transfer, 0, sourceAuthority);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 65536);
  assert.ok(target.current.root.custody);
  await assert.rejects(
    target.current.root.custody.stageTarget(
      transfer,
      { ...first, digest: `sha256:${'f'.repeat(64)}` },
      targetAuthority,
    ),
  );
  assert.equal(await target.current.owner.collectiveCustody.fence.read(scope.contentRef), null);
  await target.current.root.custody.stageTarget(transfer, first, targetAuthority);
  await target.current.root.custody.stageTarget(transfer, first, targetAuthority);
  await assert.rejects(target.current.owner.describe(scope.contentRef));
  await assert.rejects(target.current.root.custody.attestReady(transfer, targetAuthority), /page missing/);
  target.reopen();
  for (let index = prepared.manifest.pageCount - 1; index >= 1; index--) {
    const page = await reopenedSource.custody.readPage(transfer, index, sourceAuthority);
    assert.ok(target.current.root.custody);
    await assert.rejects(
      target.current.root.custody.stageTarget(
        transfer,
        { ...page, digest: `sha256:${'f'.repeat(64)}` },
        targetAuthority,
      ),
    );
    await target.current.root.custody.stageTarget(transfer, page, targetAuthority);
  }
  assert.ok(target.current.root.custody);
  const ready = await target.current.root.custody.attestReady(transfer, targetAuthority);
  target.reopen();
  assert.ok(target.current.root.custody);
  assert.deepEqual(await target.current.root.custody.attestReady(transfer, targetAuthority), ready);
  // A lost ready HTTP reply may restart the Connector's page cursor; exact retained pages must replay without changing ready truth.
  await target.current.root.custody.stageTarget(transfer, first, targetAuthority);
  assert.deepEqual(await target.current.root.custody.attestReady(transfer, targetAuthority), ready);
  await assert.rejects(target.current.root.custody.finalize(transfer, targetAuthority));
  transfer = { ...transfer, state: 'committed', ready };
  await reopenedSource.custody.finalize(transfer, sourceAuthority);
  await target.current.root.custody.finalize(transfer, targetAuthority);
  target.reopen();
  assert.ok(target.current.root.custody);
  await target.current.root.custody.finalize(transfer, targetAuthority);
  const scopeRef = collectiveContentScopeRef(scope);
  assert.equal((await target.current.owner.load(scope.contentRef)).bytes.toString('utf8'), text);
  const original = f.reviews.getByContent('real-local-owner', scope.contentRef, scopeRef);
  assert.deepEqual(target.current.reviews.getByContent('destination-real-local-owner', scope.contentRef, scopeRef), {
    ...original,
    ownerUserId: 'destination-real-local-owner',
  });
  assert.deepEqual(await f.execute(baseConstraint), { status: 'error', error: { code: 'owner_unavailable' } });
  await assert.rejects(f.owner.collectiveCustody.fence.assertEffectAvailable(scope.contentRef, scopeRef, 1));
  const current = { ...baseConstraint, custodyRevision: 2, humanId: 'human-bob' };
  const read = await target.current.root.execute(
    {
      relayRef: 'new-owner-read',
      requestId: 'new-owner-read',
      constraint: current,
      payload: {},
      expiresAt: Date.now() + 10000,
    },
    { reauthorize: async () => current },
  );
  assert.equal(read.status, 'ok');
});

test('pre-commit cancellation requires canonical cancellation and restores source effects after restart', async (t) => {
  const f = await fixture(t);
  let transfer = await custodyTransfer(f.owner);
  const authority = custodyAuthority(() => transfer, 'source');
  assert.ok(f.port.custody);
  const prepared = await f.port.custody.prepareSource(transfer, authority);
  await assert.rejects(f.port.custody.finalize(transfer, authority));
  transfer = { ...transfer, state: 'cancelled', prepared };
  await f.port.custody.finalize(transfer, authority);
  assert.equal((await f.execute(baseConstraint)).status, 'ok');
  await f.port.custody.finalize(transfer, authority);
});
