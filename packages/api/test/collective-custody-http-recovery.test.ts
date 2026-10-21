import assert from 'node:assert/strict';
import { custodyHttpFixture } from './collective-custody-http.fixture.js';
import { test } from './helpers/f202-collective-installed-business.js';

for (const lostAt of ['ready', 'accept-before', 'accept', 'finalized']) {
  test(`real custody restarts source, target and Service after a lost ${lostAt} exchange`, async (t) => {
    let armed = true;
    let paused = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (paused && path.includes('/artifacts/custody/')) throw new Error('test destination temporarily offline');
      if (armed && path === `/api/artifacts/custody/${lostAt === 'accept-before' ? 'accept' : lostAt}`) {
        armed = false;
        // ready/activation ACK requests never arrive; accept commits but its response is lost.
        if (lostAt === 'accept') assert.equal((await fetch(input, init)).status, 200);
        paused = true;
        throw new Error('test custody exchange lost');
      }
      return fetch(input, init);
    };
    const f = await custodyHttpFixture(t, fetchImpl);
    assert.equal((await f.invoke(f.member.sessionToken, 'read', {}, 'initial-owner-read')).status, 200);
    const offered = await f.post('custody/offer', f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      targetHumanId: f.member.human.humanId,
      expectedCustodyRevision: 1,
      requestId: `lost-${lostAt}-offer`,
    });
    assert.equal(offered.status, 201);
    const coordinates = {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      transferId: offered.value.handoffRef,
      connectionId: f.target.connectionId,
    };
    await f.drive(() => paused);
    const cut = f.store.readArtifactCustody(f.targetCredential, coordinates);
    assert.equal(
      cut.state,
      lostAt === 'ready' ? 'source_prepared' : lostAt === 'accept-before' ? 'target_ready' : 'committed',
    );
    if (['accept', 'finalized'].includes(lostAt))
      assert.throws(
        () =>
          f.store.issueArtifactConstraint(f.member.sessionToken, {
            ...f.coordinates,
            artifactId: f.artifact.artifactId,
            sourceEventId: f.source.eventId,
            action: 'read',
          }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ARTIFACT_OWNER_UNAVAILABLE',
      );
    await f.restartSource();
    await f.restartTarget();
    await f.restartService();
    paused = false;
    await f.drive(() => {
      const state = f.store.readArtifactCustody(f.targetCredential, coordinates);
      return state.state === 'committed' && state.targetFinalized && state.sourceFinalized;
    });
    const read = await f.invoke(f.member.sessionToken, 'read', {}, 'read-after-three-restarts');
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.equal(read.value.value.text, f.text);
    assert.equal(f.store.listArtifacts(f.member.sessionToken, f.coordinates).length, 1);
    assert.equal((await f.destination.current.owner.listOutbox(f.artifact.contentRef)).length, 1);
    assert.equal((await f.contentOwner.collectiveCustody.fence.read(f.artifact.contentRef))?.state, 'source_retired');
  });
}

test('an offered transfer survives all three restarts and a prepared cancellation restores the original owner only', async (t) => {
  let paused = true;
  const f = await custodyHttpFixture(t, async (input, init) => {
    if (paused && new URL(String(input)).pathname.includes('/artifacts/custody/'))
      throw new Error('destination offline before transfer');
    return fetch(input, init);
  });
  assert.equal((await f.invoke(f.member.sessionToken, 'read', {}, 'initial-read')).status, 200);
  const offered = await f.post('custody/offer', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    targetHumanId: f.member.human.humanId,
    expectedCustodyRevision: 1,
    requestId: 'offered-restart-and-cancel',
  });
  const target = {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    transferId: offered.value.handoffRef,
    connectionId: f.target.connectionId,
  };
  await f.restartSource();
  await f.restartTarget();
  await f.restartService();
  assert.equal(f.store.readArtifactCustody(f.targetCredential, target).state, 'offered');
  await f.drive(() => f.store.readArtifactCustody(f.targetCredential, target).state === 'source_prepared');
  const cancelled = await f.post('custody/cancel', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    transferId: offered.value.handoffRef,
  });
  assert.equal(cancelled.status, 200);
  await f.restartSource();
  await f.restartTarget();
  await f.restartService();
  paused = false;
  await f.drive(() => {
    const state = f.store.readArtifactCustody(f.targetCredential, target);
    return state.state === 'cancelled' && state.sourceFinalized && state.targetFinalized;
  });
  assert.equal((await f.invoke(f.member.sessionToken, 'read', {}, 'source-after-cancel')).status, 200);
  assert.equal((await f.contentOwner.collectiveCustody.fence.read(f.artifact.contentRef))?.state, 'active');
  await assert.rejects(f.destination.current.owner.describe(f.artifact.contentRef));
});
