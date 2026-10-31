import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollectiveMarkdownOwner } from '../src/domains/collaborative-content/collective-artifact/markdown-owner.js';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { custodyAuthority, custodyTransfer } from './collective-custody-transfer.fixture.js';
import { baseConstraint, fixture, scope } from './collective-markdown.fixture.js';

test('preparation drains admitted owner effects before its cut and refuses a later queued annotation', async (t) => {
  const f = await fixture(t);
  const transfer = await custodyTransfer(f.owner);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const constraint = { ...baseConstraint, action: 'annotate' as const };
  const payload = {
    kind: 'annotate',
    messageEventId: 'entered-before-freeze',
    body: 'Already admitted.',
    quote: 'A unique shared quote.',
    location: { channelId: 'general', rootEventId: scope.sourceEventId },
    expectedReviewRevision: 1,
  };
  const first = f.port.execute(
    { relayRef: 'admitted-note', requestId: 'admitted-note', constraint, payload, expiresAt: Date.now() + 10000 },
    {
      reauthorize: async () => {
        entered();
        await waiting;
        return constraint;
      },
    },
  );
  await started;
  assert.ok(f.port.custody);
  const preparing = f.port.custody.prepareSource(
    transfer,
    custodyAuthority(() => transfer, 'source'),
  );
  const late = f.execute(
    constraint,
    { ...payload, messageEventId: 'queued-after-freeze', expectedReviewRevision: 2 },
    'queued-after-freeze',
  );
  release();
  assert.equal((await first).status, 'ok');
  await preparing;
  assert.deepEqual(await late, { status: 'error', error: { code: 'owner_unavailable' } });
  const cut = f.reviews.collectiveCustody.exportSnapshot(scope.contentRef, collectiveContentScopeRef(scope));
  assert.equal(cut?.review.annotations.length, 1);
  assert.equal(cut?.review.annotations[0].body, 'Already admitted.');
});

test('a source crash after permanent retirement recovers its acknowledgement without thawing the old generation', async (t) => {
  const f = await fixture(t);
  let transfer = await custodyTransfer(f.owner);
  const authority = custodyAuthority(() => transfer, 'source');
  assert.ok(f.port.custody);
  const prepared = await f.port.custody.prepareSource(transfer, authority);
  transfer = {
    ...transfer,
    state: 'committed',
    prepared,
    ready: {
      readyRef: 'verified-target-ready',
      preparedRef: prepared.preparedRef,
      manifestDigest: prepared.manifest.digest,
      ownerScopeRef: prepared.ownerScopeRef,
    },
  };
  const retire = f.owner.collectiveCustody.fence.finalizeSource.bind(f.owner.collectiveCustody.fence);
  f.owner.collectiveCustody.fence.finalizeSource = async (...args) => {
    await retire(...args);
    throw new Error('lost source retire response');
  };
  await assert.rejects(f.port.custody.finalize(transfer, authority), /lost source retire response/);
  const root = new CollectiveMarkdownOwner({
    owner: new ProjectContentOwnerService({ dataDir: f.dataDir }),
    reviews: f.reviews,
    modifications: f.modifications,
    ownerUserId: 'real-local-owner',
    custodyDataDir: f.dataDir,
  });
  assert.ok(root.custody);
  await root.custody.finalize(transfer, authority);
  assert.equal(
    (
      await root.execute(
        {
          relayRef: 'old-generation',
          requestId: 'old-generation',
          constraint: baseConstraint,
          payload: {},
          expiresAt: Date.now() + 10000,
        },
        { reauthorize: async () => baseConstraint },
      )
    ).status,
    'error',
  );
});

test('a failed snapshot leaves its durable fence and canonical cancellation releases the orphan after restart', async (t) => {
  const f = await fixture(t);
  let transfer = await custodyTransfer(f.owner);
  const authority = custodyAuthority(() => transfer, 'source');
  f.modifications.collectiveCustody.exportSnapshot = () => {
    throw new Error('snapshot storage unavailable');
  };
  assert.ok(f.port.custody);
  await assert.rejects(f.port.custody.prepareSource(transfer, authority), /snapshot storage unavailable/);
  assert.equal((await f.owner.collectiveCustody.fence.read(baseConstraint.contentRef))?.state, 'source_frozen');
  transfer = { ...transfer, state: 'cancelled' };
  const owner = new ProjectContentOwnerService({ dataDir: f.dataDir });
  const root = new CollectiveMarkdownOwner({
    owner,
    reviews: f.reviews,
    modifications: f.modifications,
    ownerUserId: 'real-local-owner',
    custodyDataDir: f.dataDir,
  });
  assert.ok(root.custody);
  await root.custody.finalize(transfer, authority);
  assert.equal((await owner.collectiveCustody.fence.read(baseConstraint.contentRef))?.state, 'active');
});
