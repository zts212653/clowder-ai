import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeResolver } from '../../dist/domains/memory/KnowledgeResolver.js';
import { matterPreparationFixture } from '../helpers/work-preparation-matter-fixture.js';

test('preparation consumes one owned page at projection and one fresh page at final validation', async (t) => {
  const f = await matterPreparationFixture(t);
  const response = await f.prepare();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().pointers.length, 1);
  assert.equal(f.state.pageReads, 2, 'do not repeat the owner read inside the W3 converter');
  assert.equal(f.state.messageReads, 26, 'both full passes must retain all thirteen supporting conditions');
  assert.deepEqual(f.state.logs, [], 'successful preparation must not emit diagnostic snapshots');
});

test('page bodies stay out of candidate, catalog, preparation API and preparation metadata', async (t) => {
  const f = await matterPreparationFixture(t);
  const source = f.matters.discoverySource(f.actor, { query: 'w3allconditions', threadId: f.auth.threadId });
  const found = await KnowledgeResolver.discover('w3allconditions', { sources: [source], limit: 2 });
  assert.equal(found.items.length, 1);
  const catalog = await f.matters.catalog(f.actor, { query: 'w3allconditions', threadId: f.auth.threadId });
  const response = await f.prepare();
  const metadata = ['memory_cue_preparation_opportunities', 'memory_cue_events'].map((table) =>
    f.db.prepare(`SELECT * FROM ${table}`).all(),
  );
  for (const body of [found, catalog, response.json(), metadata]) {
    assert.equal(JSON.stringify(body).includes('PRIVATE_CANONICAL_CONDITION_'), false);
    assert.equal(JSON.stringify(body).includes('"quote"'), false);
  }
});

for (const change of ['correction', 'revocation'])
  test(`fresh final owner projection rejects ${change} after initial page admission`, async (t) => {
    const f = await matterPreparationFixture(t);
    f.state.beforeFinal = () => {
      if (change === 'correction') f.messages.get('source-0').content = 'Corrected source';
      else f.history.createdBy = 'another-owner';
    };
    const response = await f.prepare();
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().pointers, []);
    assert.equal(f.state.pageReads, 2, 'the owner must actually perform a fresh final read');
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_cue_events').get().n, 0);
  });

test('the internal page handoff cannot be forged, borrowed by another binding, or reused after its lifetime', async (t) => {
  const f = await matterPreparationFixture(t);
  const caller = new AbortController();
  const source = f.matters.discoverySource(f.actor, { query: 'w3allconditions', threadId: f.auth.threadId });
  let batch;
  let cursor;
  do {
    batch = await source.read({ query: 'w3allconditions', cursor, limit: 20, signal: caller.signal });
    cursor = batch.nextCursor;
  } while (!batch.candidates.length && cursor);
  assert.ok(batch.candidates.length);
  const row = await source.project(batch.candidates[0]);
  assert.equal(source.admittedPage(row, f.actor).entries.length, 13);
  assert.equal(source.admittedPage({ ...row }, f.actor), null);
  const foreignActor = { userId: 'foreign-owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
  assert.equal(source.admittedPage(row, foreignActor), null, 'even the original binding requires its exact reader');
  assert.equal(source.admittedPage(row, { ...f.actor, publicReply: true }), null);
  const foreign = f.matters.discoverySource(foreignActor);
  assert.equal(foreign.admittedPage(row, foreignActor), null);
  caller.abort();
  assert.throws(() => source.admittedPage(row, f.actor), { name: 'AbortError' });
  const next = new AbortController();
  await source.read({ query: 'w3allconditions', limit: 20, signal: next.signal });
  assert.equal(source.admittedPage(row, f.actor), null, 'old admitted pages cannot cross a new read lifetime');
  const fresh = await source.project(batch.candidates[0]);
  assert.notEqual(fresh, row);
  assert.equal(source.admittedPage(fresh, f.actor).entries.length, 13);
});

test('an owner-management unavailable placeholder never hands off a private page', async (t) => {
  const f = await matterPreparationFixture(t);
  f.history.createdBy = 'another-owner';
  const actor = { userId: f.actor.userId, viewer: { type: 'user', userId: f.actor.userId } };
  const source = f.matters.discoverySource(actor, { management: true });
  const batch = await source.read({ query: '', limit: 20, signal: new AbortController().signal });
  const row = await source.project(batch.candidates[0]);
  assert.equal(row.item.unavailable, true);
  assert.equal(source.admittedPage(row, actor), null);
  assert.equal(JSON.stringify(row).includes('PRIVATE_CANONICAL_CONDITION_'), false);
});
