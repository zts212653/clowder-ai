import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { MediaOwnerError } from '../dist/domains/video-studio/content-owner/media-errors.js';
import { threadWorksJoinFixture } from './helpers/thread-works-join-fixture.js';

test('admitted thread Works overlaps title and real owner reads while preserving DTO order and admission', async (t) => {
  const f = await threadWorksJoinFixture(t);
  assert.equal((await f.request({ headers: {} })).statusCode, 401);
  assert.equal((await f.request({ headers: { 'x-cat-cafe-user': 'foreign' } })).statusCode, 403);
  assert.equal((await f.request({ url: '/api/threads/missing/artifacts?view=works' })).statusCode, 404);
  assert.equal((await f.request({ url: '/api/threads/T0/artifacts' })).statusCode, 200);
  assert.equal(f.state.titleCalls, 0);
  assert.equal(f.state.workCalls, 0);
  const pending = f.request();
  await f.titleEntered.promise;
  await setImmediate();
  assert.equal(f.state.workCalls, 1, 'independent Work starts before title metadata is released');
  assert.equal(f.state.titleActive, true);
  assert.equal(f.state.lineageCalls, 1, 'only the preceding classic request has reached lineage');
  f.releaseWork.resolve();
  f.releaseTitle.resolve();
  const response = await pending;
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(
    body.artifacts.map((item) => item.ref),
    ['org/repo#7', f.work.reference.contentRef],
  );
  assert.equal(body.artifacts[0].name, 'Original PR title');
  assert.equal(body.artifacts[1].work.ownerRevision, 1);
  assert.equal(body.total, 2);
  assert.equal(body.complete, true);
  assert.equal(f.state.scopes.length, 1);
  assert.equal(f.state.scopes[0].active, false);
  t.diagnostic(JSON.stringify(f.state));
});

test('failed independent Work drains the title reader before HTTP failure and the next request reads fresh', async (t) => {
  const f = await threadWorksJoinFixture(t);
  f.state.failWork = true;
  let responded = false;
  const pending = f.request().then((response) => {
    responded = true;
    return response;
  });
  await f.titleEntered.promise;
  await setImmediate();
  assert.equal(f.state.workCalls, 1, 'failure branch also starts without waiting for PR title metadata');
  f.releaseWork.resolve();
  await setImmediate();
  assert.equal(f.state.scopes[0].active, true, 'Work scope stays active until both admitted reads settle');
  assert.equal(f.state.titleActive, true, 'title reader is still in flight');
  assert.equal(responded, false, 'HTTP failure must wait for both admitted reads to settle');
  assert.equal(f.state.lineageCalls, 0, 'no partial lineage projection on a failed source');
  f.releaseTitle.resolve();
  const failed = await pending;
  assert.equal(failed.statusCode, 500);
  assert.equal(f.state.titleActive, false);
  f.state.failWork = false;
  const added = await f.f.create('later-film', 'T0');
  const next = await f.request();
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(f.state.scopes.length, 2, 'subsequent request gets a new scope');
  assert.ok(next.json().artifacts.some((item) => item.ref === added.reference.contentRef));
  assert.equal(next.json().total, 3);
  t.diagnostic(JSON.stringify(f.state));
});

for (const changed of ['manifest', 'authorization']) {
  test(`thread Works keeps its final ${changed} fence after the blocked title reader`, async (t) => {
    const f = await threadWorksJoinFixture(t);
    const pending = f.request();
    await f.titleEntered.promise;
    f.releaseWork.resolve();
    await f.workReadComplete.promise;
    await setImmediate();
    // Drain a consumer's already-started final scan, without timing assumptions.
    // A correctly encompassing consumer is still waiting for the title barrier.
    if (f.state.scopes[0].consumerFinished) await f.workScopeClosed.promise;
    assert.equal(f.state.titleActive, true, 'owner data has completed while title metadata is blocked');
    assert.equal(f.state.scopes[0].complete, true);
    let added;
    if (changed === 'manifest') {
      added = await f.f.create('saved-during-title', 'T0');
    } else {
      f.f.setAuthorize(async () => {
        throw new MediaOwnerError('access_denied');
      });
    }
    f.releaseTitle.resolve();
    const stale = await pending;
    assert.equal(stale.statusCode, 500, `${changed} changed during titles must reject stale or unauthorized DTOs`);
    assert.equal(stale.json().artifacts, undefined);
    assert.equal(f.state.lineageCalls, 0, 'no lineage or partial DTOs before the final owner fence');
    assert.equal(f.state.scopes[0].active, false);
    f.f.setAuthorize(async ({ principal, scope }) => {
      if (scope) assert.equal(scope.ownerUserId, principal.userId);
    });
    added ??= await f.f.create('saved-after-restoring-access', 'T0');
    const next = await f.request();
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().total, 3);
    assert.ok(next.json().artifacts.some((item) => item.ref === added.reference.contentRef));
    assert.equal(f.state.scopes.length, 2, 'the recovery HTTP opens a new owner scope');
    assert.equal(f.state.scopes[1].active, false);
    t.diagnostic(JSON.stringify({ changed, scopes: f.state.scopes, freshTotal: next.json().total }));
  });
}

test('admitted HTTP preserves the catalogue timing observer through the final request fence', async (t) => {
  const reports = [];
  const f = await threadWorksJoinFixture(t, {
    requireTimingObserver: true,
    onWorkTiming: (report) => reports.push(report),
  });
  const pending = f.request();
  await f.titleEntered.promise;
  f.releaseWork.resolve();
  await f.workReadComplete.promise;
  assert.equal(reports.length, 0, 'a pending title cannot publish a completed Work read report');
  f.releaseTitle.resolve();
  const response = await pending;
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.state.timingObserverProvided, true, 'admitted HTTP must attach its Work timing observer');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'success');
  assert.equal(reports[0].counts.returned, 1);
  assert.ok(Number.isFinite(reports[0].phases.manifestValidation));
  assert.ok(Number.isFinite(reports[0].phases.finalAuthorization));
  assert.equal(f.state.scopes[0].active, false);
});
