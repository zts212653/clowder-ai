import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryFrustrationIssueStore } from '../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js';

async function fixture({ confirmed = true } = {}) {
  const store = new InMemoryFrustrationIssueStore();
  const issue = await store.create({
    threadId: 'thread-source',
    userId: 'owner',
    catId: 'cat-test',
    signalType: 'cli_error',
    signalDetail: { reasonCode: 'failed', publicSummary: 'A failure' },
    context: { recentMessages: [{ role: 'user', content: 'private body', timestamp: 1 }], errorLogs: 'private log' },
  });
  if (confirmed) await store.confirm({ issueId: issue.issueId, userDescription: 'confirmed description' });
  const source = await store.getById(issue.issueId);
  const link = (overrides = {}) => {
    assert.equal(
      typeof store.compareAndSetCommunityIssueDraft,
      'function',
      'atomic frustration source link port missing',
    );
    return store.compareAndSetCommunityIssueDraft({
      issueId: issue.issueId,
      expectedSource: source,
      expectedDraftId: null,
      draftId: 'draft-1',
      allowReplace: false,
      ...overrides,
    });
  };
  return { store, source, link };
}

test('legacy frustration source fixture remains a real confirmed record', async () => {
  const { source } = await fixture();
  assert.equal(source.status, 'confirmed');
  assert.equal(source.userId, 'owner');
});

test('atomic source link does not create a missing source', async () => {
  const f = await fixture();
  assert.deepEqual(await f.link({ issueId: 'missing', expectedSource: { ...f.source, issueId: 'missing' } }), {
    outcome: 'missing',
  });
  assert.equal(await f.store.getById('missing'), null);
});

test('atomic source link rejects an unconfirmed source', async () => {
  const f = await fixture({ confirmed: false });
  assert.deepEqual(await f.link(), { outcome: 'not_confirmed' });
  assert.equal((await f.store.getById(f.source.issueId)).communityIssueDraftId, undefined);
});

test('initial exact source link and same-link replay are idempotent', async () => {
  const f = await fixture();
  assert.deepEqual(await f.link(), { outcome: 'linked' });
  assert.deepEqual(await f.link(), { outcome: 'already_linked' });
  assert.equal((await f.store.getById(f.source.issueId)).communityIssueDraftId, 'draft-1');
});

test('different current link conflicts without overwriting the winner', async () => {
  const f = await fixture();
  await f.store.setCommunityIssueDraftId(f.source.issueId, 'other-draft');
  assert.deepEqual(await f.link(), { outcome: 'conflict' });
  assert.equal((await f.store.getById(f.source.issueId)).communityIssueDraftId, 'other-draft');
});

test('owner-authorized replacement requires exact previous link', async () => {
  const f = await fixture();
  await f.store.setCommunityIssueDraftId(f.source.issueId, 'draft-1');
  assert.deepEqual(await f.link({ draftId: 'draft-2', expectedDraftId: 'wrong', allowReplace: true }), {
    outcome: 'conflict',
  });
  assert.deepEqual(await f.link({ draftId: 'draft-2', expectedDraftId: 'draft-1', allowReplace: true }), {
    outcome: 'linked',
  });
  assert.equal((await f.store.getById(f.source.issueId)).communityIssueDraftId, 'draft-2');
});

test('native replacement permission cannot be inferred from knowing the current link', async () => {
  const f = await fixture();
  await f.store.setCommunityIssueDraftId(f.source.issueId, 'draft-1');
  assert.deepEqual(await f.link({ draftId: 'draft-2', expectedDraftId: 'draft-1' }), { outcome: 'conflict' });
  assert.equal((await f.store.getById(f.source.issueId)).communityIssueDraftId, 'draft-1');
});

test('same-link replay still rejects a stale material snapshot', async () => {
  const f = await fixture();
  await f.store.setCommunityIssueDraftId(f.source.issueId, 'draft-1');
  assert.deepEqual(await f.link({ expectedSource: { ...f.source, userDescription: 'stale' } }), {
    outcome: 'stale_source',
  });
});

test('owner and thread snapshot mismatches never write a link', async () => {
  const f = await fixture();
  for (const mismatch of [{ userId: 'other-owner' }, { threadId: 'other-thread' }]) {
    assert.deepEqual(await f.link({ expectedSource: { ...f.source, ...mismatch } }), { outcome: 'stale_source' });
  }
  assert.equal((await f.store.getById(f.source.issueId)).communityIssueDraftId, undefined);
});

test('concurrent different links admit one winner and retain source history', async () => {
  const f = await fixture();
  const results = await Promise.all([f.link(), f.link({ draftId: 'draft-2' })]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ['conflict', 'linked']);
  const saved = await f.store.getById(f.source.issueId);
  assert.ok(['draft-1', 'draft-2'].includes(saved.communityIssueDraftId));
  assert.deepEqual(saved.context, f.source.context);
  assert.equal(saved.userDescription, f.source.userDescription);
});

test('card visibility metadata does not invalidate a material source snapshot', async () => {
  const f = await fixture();
  await f.store.setCardMessageId(f.source.issueId, 'card-1');
  assert.deepEqual(await f.link(), { outcome: 'linked' });
  assert.equal((await f.store.getById(f.source.issueId)).cardMessageId, 'card-1');
});
