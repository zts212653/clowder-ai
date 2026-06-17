import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * F222: FrustrationIssueStore tests — in-memory implementation.
 *
 * Tests cover CRUD lifecycle: create → getById → confirm/skip → list*.
 */

let store;

const validInput = {
  threadId: 'thread_t1',
  userId: 'user_u1',
  catId: 'cat-test',
  signalType: 'cli_error',
  signalDetail: { reasonCode: 'auth_failed', publicSummary: 'Auth failed' },
  context: {
    recentMessages: [{ role: 'user', content: 'help', timestamp: 1000 }],
    errorLogs: 'Error: 401',
  },
};

describe('F222: InMemoryFrustrationIssueStore', () => {
  beforeEach(async () => {
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    store = new InMemoryFrustrationIssueStore();
  });

  // ── create ─────────────────────────────────────────────────

  it('create: returns issue with status=draft and fi_ prefix', async () => {
    const issue = await store.create(validInput);
    assert.equal(issue.status, 'draft');
    assert.ok(issue.issueId.startsWith('fi_'));
    assert.equal(issue.threadId, 'thread_t1');
    assert.equal(issue.signalType, 'cli_error');
    assert.ok(issue.createdAt > 0);
  });

  // ── getById ────────────────────────────────────────────────

  it('getById: returns issue by ID', async () => {
    const created = await store.create(validInput);
    const fetched = await store.getById(created.issueId);
    assert.ok(fetched);
    assert.equal(fetched.issueId, created.issueId);
    assert.equal(fetched.status, 'draft');
  });

  it('getById: returns null for unknown ID', async () => {
    const result = await store.getById('fi_nonexistent');
    assert.equal(result, null);
  });

  it('getById: returns immutable copy (no shared reference)', async () => {
    const created = await store.create(validInput);
    const fetched1 = await store.getById(created.issueId);
    const fetched2 = await store.getById(created.issueId);
    assert.notEqual(fetched1, fetched2, 'should be different object references');
    assert.deepEqual(fetched1, fetched2, 'should have same content');
  });

  // ── confirm ────────────────────────────────────────────────

  it('confirm: transitions draft → confirmed', async () => {
    const created = await store.create(validInput);
    const confirmed = await store.confirm({ issueId: created.issueId });
    assert.ok(confirmed);
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmedAt > 0);
  });

  it('confirm: sets userDescription when provided', async () => {
    const created = await store.create(validInput);
    const confirmed = await store.confirm({
      issueId: created.issueId,
      userDescription: 'The auth keeps failing',
    });
    assert.ok(confirmed);
    assert.equal(confirmed.userDescription, 'The auth keeps failing');
  });

  it('confirm: returns null for non-draft issue', async () => {
    const created = await store.create(validInput);
    await store.confirm({ issueId: created.issueId });
    // Try to confirm again — should fail
    const result = await store.confirm({ issueId: created.issueId });
    assert.equal(result, null);
  });

  it('confirm: returns null for unknown ID', async () => {
    const result = await store.confirm({ issueId: 'fi_nope' });
    assert.equal(result, null);
  });

  // ── skip ───────────────────────────────────────────────────

  it('skip: transitions draft → skipped', async () => {
    const created = await store.create(validInput);
    const skipped = await store.skip(created.issueId);
    assert.ok(skipped);
    assert.equal(skipped.status, 'skipped');
    assert.ok(skipped.skippedAt > 0);
  });

  it('skip: returns null for already-confirmed issue', async () => {
    const created = await store.create(validInput);
    await store.confirm({ issueId: created.issueId });
    const result = await store.skip(created.issueId);
    assert.equal(result, null);
  });

  it('skip: returns null for unknown ID', async () => {
    const result = await store.skip('fi_nope');
    assert.equal(result, null);
  });

  // ── setCardMessageId ───────────────────────────────────────

  it('setCardMessageId: updates the visibility marker', async () => {
    const created = await store.create(validInput);
    await store.setCardMessageId(created.issueId, 'msg_card123');
    const fetched = await store.getById(created.issueId);
    assert.ok(fetched);
    assert.equal(fetched.cardMessageId, 'msg_card123');
  });

  // ── setCommunityIssueDraftId ────────────────────────────

  it('setCommunityIssueDraftId: links draft and survives round-trip', async () => {
    const created = await store.create(validInput);
    await store.setCommunityIssueDraftId(created.issueId, 'cid_draft456');
    const fetched = await store.getById(created.issueId);
    assert.ok(fetched);
    assert.equal(fetched.communityIssueDraftId, 'cid_draft456');
  });

  // ── listByThread ───────────────────────────────────────────

  it('listByThread: returns issues sorted by createdAt desc', async () => {
    // Create a fresh store to avoid interference
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    const freshStore = new InMemoryFrustrationIssueStore();

    const i1 = await freshStore.create({ ...validInput, threadId: 'thread_list' });
    // Small delay to ensure different createdAt
    await new Promise((r) => setTimeout(r, 5));
    const i2 = await freshStore.create({ ...validInput, threadId: 'thread_list' });
    await freshStore.create({ ...validInput, threadId: 'thread_other' });

    const list = await freshStore.listByThread('thread_list');
    assert.equal(list.length, 2);
    assert.equal(list[0].issueId, i2.issueId, 'most recent first');
    assert.equal(list[1].issueId, i1.issueId);
  });

  // ── listConfirmed ──────────────────────────────────────────

  it('listConfirmed: returns only confirmed issues for user', async () => {
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    const freshStore = new InMemoryFrustrationIssueStore();

    const i1 = await freshStore.create({ ...validInput, userId: 'user_eval' });
    const i2 = await freshStore.create({ ...validInput, userId: 'user_eval' });
    await freshStore.create({ ...validInput, userId: 'user_eval' });

    await freshStore.confirm({ issueId: i1.issueId });
    await freshStore.confirm({ issueId: i2.issueId });
    // i3 stays draft

    const confirmed = await freshStore.listConfirmed('user_eval');
    assert.equal(confirmed.length, 2);
    assert.ok(confirmed.every((i) => i.status === 'confirmed'));
  });

  // ── listDraft ──────────────────────────────────────────────

  it('listDraft: returns only draft issues for user', async () => {
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    const freshStore = new InMemoryFrustrationIssueStore();

    await freshStore.create({ ...validInput, userId: 'user_draft' });
    const i2 = await freshStore.create({ ...validInput, userId: 'user_draft' });
    await freshStore.create({ ...validInput, userId: 'user_draft' });

    await freshStore.confirm({ issueId: i2.issueId });

    const drafts = await freshStore.listDraft('user_draft');
    assert.equal(drafts.length, 2);
    assert.ok(drafts.every((i) => i.status === 'draft'));
  });
});
