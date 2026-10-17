import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neutralFixture } from './helpers/neutral-host-fixture.js';

for (const [service, method] of [
  ['deployment', 'getCatalog'],
  ['frustration', 'getSource'],
  ['frustration', 'linkDraft'],
]) {
  test(`production module exposes Host ${service}.${method} through authenticated owner forwarding`, async (t) => {
    const f = await neutralFixture(t);
    const value =
      method === 'getSource'
        ? f.draft.issueId
        : method === 'linkDraft'
          ? {
              issueId: f.draft.issueId,
              sourceRevision: 'not-current',
              expectedDraftId: null,
              draftId: 'D1',
            }
          : undefined;
    const response = await f.http(service, method, value);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().available, true, `Host ${service}.${method} is unavailable`);
    if (method === 'getCatalog') assert.equal(response.json().result.defaultCatId, 'cat');
    if (method === 'getSource') assert.equal(response.json().result.issueId, f.draft.issueId);
    if (method === 'linkDraft') assert.deepEqual(response.json().result, { outcome: 'stale_source' });
  });
}

async function source(f) {
  const response = await f.http('frustration', 'getSource', f.draft.issueId);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().result;
}
function link(value, draftId = 'D1', expectedDraftId = null) {
  return { issueId: value.issueId, sourceRevision: value.sourceRevision, expectedDraftId, draftId };
}
async function revoke(f, capability) {
  const snapshot = await f.runtime.inventoryStore.snapshot();
  const grant = snapshot.grants.find((g) => g.pluginInstanceId === f.installed.pluginInstanceId);
  await f.runtime.inventory.revokeGrant({
    pluginInstanceId: f.installed.pluginInstanceId,
    capability,
    expectedGrantRevision: grant.grantRevision,
  });
}

test('catalog and source project only the contracted fields and freeze background catalog snapshots', async (t) => {
  const f = await neutralFixture(t);
  const catalog = await f.host().deployment.getCatalog();
  assert.deepEqual(catalog, {
    roster: { cat: { family: 'maine-coon', available: true, lead: true } },
    defaultCatId: 'cat',
    policy: f.policy,
  });
  assert.equal(Object.isFrozen(catalog.roster.cat), true);
  f.roster.cat.available = false;
  assert.equal(catalog.roster.cat.available, true);
  assert.equal((await f.host().deployment.getCatalog()).roster.cat.available, false);
  const value = await source(f);
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'issueId',
      'status',
      'threadId',
      'userId',
      'signalType',
      'signalDetail',
      'userDescription',
      'recentMessageCount',
      'communityIssueDraftId',
      'sourceRevision',
    ].sort(),
  );
  assert.deepEqual(value.signalDetail, { reasonCode: 'error', publicSummary: 'public' });
  assert.equal(value.recentMessageCount, 1);
  assert.equal(JSON.stringify(value).includes('private'), false);
  await assert.rejects(() => f.host().frustration.getSource(f.draft.issueId), /current owner request or native/);
});

test('missing services are unavailable, while an actually absent source is null/missing', async (t) => {
  const absent = await neutralFixture(t, { unavailable: true });
  await assert.rejects(() => absent.host().deployment.getCatalog(), /services unavailable/);
  await assert.rejects(() => absent.native('frustration', 'getSource', 'missing'), /services unavailable/);
  const f = await neutralFixture(t);
  assert.equal((await f.native('frustration', 'getSource', 'missing')).result, null);
  assert.deepEqual(
    (
      await f.native('frustration', 'linkDraft', {
        issueId: 'missing',
        sourceRevision: 'x',
        expectedDraftId: null,
        draftId: 'D',
      })
    ).result,
    { outcome: 'missing' },
  );
});

test('source links persist exact receipts, replay idempotently and permit owner-only expected-link replacement', async (t) => {
  const f = await neutralFixture(t);
  const value = await source(f);
  const input = link(value);
  const receipt = { outcome: 'linked', draftId: 'D1', sourceRevision: value.sourceRevision };
  assert.deepEqual((await f.native('frustration', 'linkDraft', input)).result, receipt);
  assert.deepEqual((await f.native('frustration', 'linkDraft', input)).result, {
    ...receipt,
    outcome: 'already_linked',
  });
  assert.equal((await source(f)).sourceRevision, value.sourceRevision);
  assert.deepEqual((await f.native('frustration', 'linkDraft', link(value, 'D2', 'D1'))).result, {
    outcome: 'conflict',
  });
  assert.deepEqual((await f.http('frustration', 'linkDraft', link(value, 'D2', 'wrong'))).json().result, {
    outcome: 'conflict',
  });
  assert.deepEqual((await f.http('frustration', 'linkDraft', link(value, 'D2', 'D1'))).json().result, {
    ...receipt,
    draftId: 'D2',
  });
  assert.equal((await f.store.getById(value.issueId)).communityIssueDraftId, 'D2');
  assert.equal((await f.store.getById(value.issueId)).context.errorLogs, 'private log');
});

test('owner GET cannot write, and no caller can smuggle owner or replacement authority', async (t) => {
  const f = await neutralFixture(t);
  const value = await source(f);
  assert.notEqual((await f.httpGet('frustration', 'linkDraft', link(value))).statusCode, 200);
  for (const extra of [
    { userId: f.owner },
    { allowReplace: true },
    { principal: { userId: f.owner } },
    { cancelled: true },
  ])
    await assert.rejects(() => f.native('frustration', 'linkDraft', { ...link(value), ...extra }));
  assert.equal((await f.store.getById(value.issueId)).communityIssueDraftId, undefined);
});

test('source read checks native thread, source owner and thread owner independently', async (t) => {
  const f = await neutralFixture(t);
  await assert.rejects(() => f.native('frustration', 'getSource', f.draft.issueId, { threadId: 'other' }), /caller/);
  await assert.rejects(() => f.native('frustration', 'getSource', f.draft.issueId, { userId: 'other' }));
  const get = f.store.getById.bind(f.store);
  f.store.getById = async (id) => ({ ...(await get(id)), userId: 'other' });
  assert.notEqual((await f.http('frustration', 'getSource', f.draft.issueId)).statusCode, 200);
  f.store.getById = get;
  const threadGet = f.threads.get.bind(f.threads);
  f.threads.get = async (id) => ({ ...(await threadGet(id)), createdBy: 'other' });
  assert.notEqual((await f.http('frustration', 'getSource', f.draft.issueId)).statusCode, 200);
});

test('missing grants deny each port independently and link requires read too', async (t) => {
  for (const [grants, service, method, value] of [
    [[], 'deployment', 'getCatalog', undefined],
    [['deployment.read'], 'frustration', 'getSource', 'missing'],
    [
      ['frustration.link'],
      'frustration',
      'linkDraft',
      { issueId: 'missing', sourceRevision: 'x', expectedDraftId: null, draftId: 'D' },
    ],
  ]) {
    const f = await neutralFixture(t, { grants, independentNative: true });
    await assert.rejects(() => f.native(service, method, value), /capability/);
  }
});

test('read rechecks grants after source IO and never exposes a revoked response', async (t) => {
  const f = await neutralFixture(t);
  const get = f.store.getById.bind(f.store);
  f.store.getById = async (id) => {
    const result = await get(id);
    await revoke(f, 'frustration.read');
    return result;
  };
  assert.notEqual((await f.http('frustration', 'getSource', f.draft.issueId)).statusCode, 200);
});

test('stop and restart permanently expire the old background surface', async (t) => {
  const f = await neutralFixture(t);
  const old = f.host();
  await f.runtime.supervisor.stop(f.installed.pluginInstanceId, 'test_stop');
  await f.runtime.supervisor.start(f.installed.pluginInstanceId);
  await assert.rejects(() => old.deployment.getCatalog(), /no longer current/);
  assert.equal((await f.host().deployment.getCatalog()).defaultCatId, 'cat');
});

test('malformed stored public fields fail validation rather than coercing or leaking', async (t) => {
  const f = await neutralFixture(t);
  f.roster.cat.family = { secret: 'private' };
  await assert.rejects(() => f.host().deployment.getCatalog());
  const get = f.store.getById.bind(f.store);
  f.store.getById = async (id) => ({ ...(await get(id)), signalDetail: { publicSummary: { secret: 'private' } } });
  assert.notEqual((await f.http('frustration', 'getSource', f.draft.issueId)).statusCode, 200);
});

test('source mutation between read and CAS is stale; same-link replay does not mask changed content', async (t) => {
  const f = await neutralFixture(t);
  const value = await source(f);
  await f.native('frustration', 'linkDraft', link(value));
  const get = f.store.getById.bind(f.store);
  f.store.getById = async (id) => ({ ...(await get(id)), userDescription: 'new content' });
  assert.deepEqual((await f.native('frustration', 'linkDraft', link(value))).result, { outcome: 'stale_source' });
  f.store.getById = get;
  const cas = f.store.compareAndSetCommunityIssueDraft.bind(f.store);
  f.store.compareAndSetCommunityIssueDraft = (input, guard) =>
    cas({ ...input, expectedSource: { ...input.expectedSource, userDescription: 'stale' } }, guard);
  assert.deepEqual((await f.http('frustration', 'linkDraft', link(value, 'D2', 'D1'))).json().result, {
    outcome: 'stale_source',
  });
  assert.equal((await get(value.issueId)).communityIssueDraftId, 'D1');
});

test('source CAS rechecks a timed-out owner request before its atomic write', async (t) => {
  const f = await neutralFixture(t, { timeoutMs: 20 });
  const value = await source(f);
  let release, settled;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const done = new Promise((resolve) => {
    settled = resolve;
  });
  const cas = f.store.compareAndSetCommunityIssueDraft.bind(f.store);
  f.store.compareAndSetCommunityIssueDraft = async (...args) => {
    await gate;
    try {
      return await cas(...args);
    } finally {
      settled();
    }
  };
  const response = await f.http('frustration', 'linkDraft', link(value));
  assert.equal(response.statusCode, 504, response.body);
  release();
  await done;
  assert.equal((await f.store.getById(value.issueId)).communityIssueDraftId, undefined);
});

test('production module has no temporary Task artifact publication surface', async (t) => {
  const f = await neutralFixture(t);
  assert.equal(f.host().taskArtifacts, undefined);
  const value = { text: 'not a Task publication', mediaType: 'text/plain' };
  const http = await f.http('taskArtifacts', 'publishText', value);
  assert.equal(http.statusCode, 200);
  assert.deepEqual(http.json(), { available: false, result: null });
  assert.deepEqual(await f.native('taskArtifacts', 'publishText', value), { available: false, result: null });
});
