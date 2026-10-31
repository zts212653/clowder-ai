import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { baseConstraint, fixture, scope, text } from './collective-markdown.fixture.js';

test('a source transfer fence survives owner reconstruction, cancels only on canonical proof and retires permanently', async (t) => {
  const f = await fixture(t);
  let owner = f.owner;
  const scopeRef = collectiveContentScopeRef(scope);
  const binding = { contentRef: scope.contentRef, scopeRef, transferId: 'transfer-source-fence', custodyRevision: 1 };
  await owner.collectiveCustody.fence.freezeSource(
    { ...binding, ownerRevision: 1, blobDigest: baseConstraint.blobDigest },
    async () => {},
  );
  owner = new ProjectContentOwnerService({ dataDir: f.dataDir });
  const settle = () =>
    owner.settle({
      contentRef: scope.contentRef,
      expectedOwnerRevision: 1,
      bytes: Buffer.from(`${text}\nChanged.\n`),
      actor: { kind: 'human', actorId: 'human-alice' },
      operationId: 'fenced-effect',
      operationContext: {
        kind: 'collective-artifact:apply',
        scopeRef,
        custodyRevision: 1,
        actorHumanId: 'human-alice',
        dispositionId: 'fenced-disposition',
        requestDigest: baseConstraint.blobDigest,
      },
      authorizeEffect: async () => {},
    });
  await assert.rejects(settle(), /custody.*unavailable/i);
  assert.equal((await owner.describe(scope.contentRef)).currentOwnerRevision, 1);
  await assert.rejects(
    owner.collectiveCustody.fence.finalizeSource(binding, 'cancelled', async () => {
      throw new Error('No canonical cancellation');
    }),
  );
  await assert.rejects(settle(), /custody.*unavailable/i);
  await owner.collectiveCustody.fence.finalizeSource(binding, 'cancelled', async () => {});
  await settle();
  const current = await owner.describe(scope.contentRef);
  const next = { ...binding, transferId: 'transfer-permanent-retirement' };
  await owner.collectiveCustody.fence.freezeSource(
    { ...next, ownerRevision: 2, blobDigest: current.blobDigest },
    async () => {},
  );
  await owner.collectiveCustody.fence.finalizeSource(next, 'committed', async () => {});
  await assert.rejects(owner.collectiveCustody.fence.finalizeSource(next, 'cancelled', async () => {}));
  await assert.rejects(
    owner.collectiveCustody.fence.assertEffectAvailable(scope.contentRef, scopeRef, 1),
    /custody.*unavailable/i,
  );
  assert.equal(
    (await owner.load(scope.contentRef, 1)).bytes.toString('utf8'),
    text,
    'owner-internal immutable history remains retained',
  );
});

test('a frozen owner serves pure existing reads but refuses lazy agent preparation and all ledger effects', async (t) => {
  const f = await fixture(t);
  const scopeRef = collectiveContentScopeRef(scope);
  assert.equal((await f.execute(baseConstraint)).status, 'ok');
  const before = f.reviews.getByContent('real-local-owner', scope.contentRef, scopeRef);
  const binding = { contentRef: scope.contentRef, scopeRef, transferId: 'transfer-ledger-freeze', custodyRevision: 1 };
  await f.owner.collectiveCustody.fence.freezeSource(
    { ...binding, ownerRevision: 1, blobDigest: baseConstraint.blobDigest },
    async () => {},
  );
  assert.equal((await f.execute(baseConstraint)).status, 'ok');
  const agent = {
    requestEventId: 'event-in-flight',
    humanId: 'human-bob',
    catId: 'codex61-sol',
    connectionId: 'connection-bob',
    participationRevision: 1,
    membershipRevision: 1,
    revocationEpoch: 1,
  };
  assert.deepEqual(await f.execute({ ...baseConstraint, agent }, { sharedRequest: {} }), {
    status: 'error',
    error: { code: 'owner_unavailable' },
  });
  assert.deepEqual(
    await f.execute(
      { ...baseConstraint, action: 'annotate' },
      {
        kind: 'annotate',
        messageEventId: 'new-note-while-frozen',
        body: 'Must wait',
        quote: 'A unique shared quote.',
        location: { channelId: 'general', rootEventId: scope.sourceEventId },
        expectedReviewRevision: 1,
      },
    ),
    { status: 'error', error: { code: 'owner_unavailable' } },
  );
  assert.deepEqual(f.reviews.get(before?.reviewId ?? ''), before);
  await f.owner.collectiveCustody.fence.finalizeSource(binding, 'committed', async () => {});
  assert.deepEqual(await f.execute(baseConstraint), { status: 'error', error: { code: 'owner_unavailable' } });
});

test('a frozen first read never creates a new ledger as a side effect', async (t) => {
  const f = await fixture(t);
  const scopeRef = collectiveContentScopeRef(scope);
  await f.owner.collectiveCustody.fence.freezeSource(
    {
      contentRef: scope.contentRef,
      scopeRef,
      transferId: 'unopened-source',
      custodyRevision: 1,
      ownerRevision: 1,
      blobDigest: baseConstraint.blobDigest,
    },
    async () => {},
  );
  assert.deepEqual(await f.execute(baseConstraint), { status: 'error', error: { code: 'owner_unavailable' } });
  assert.equal(f.reviews.getByContent('real-local-owner', scope.contentRef, scopeRef), null);
});
