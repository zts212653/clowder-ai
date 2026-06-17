import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * F235: CommunityIssueDraftStore tests — in-memory implementation.
 *
 * Tests cover lifecycle: create → getById → getBySourceId → publish/cancel.
 * INV-1 through INV-6 per plan's Stateful Object Gate.
 */

let store;

const validInput = {
  sourceType: 'frustration_issue',
  sourceId: 'fi_test123',
  title: 'Permission prompts too frequent',
  bodyMarkdown: '## Problem\nUser cancelled 4 times in 60s.',
  targetRepo: 'clowder-ai/cat-cafe',
  labels: ['bug', 'user-reported'],
  threadId: 'thread_t1',
  userId: 'usr_u1',
};

describe('F235: InMemoryCommunityIssueDraftStore', () => {
  beforeEach(async () => {
    const { InMemoryCommunityIssueDraftStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryCommunityIssueDraftStore.js'
    );
    store = new InMemoryCommunityIssueDraftStore();
  });

  // ── create ──────────────────────────────────────────────────

  it('create: returns draft with status=draft and cid_ prefix', async () => {
    const draft = await store.create(validInput);
    assert.equal(draft.status, 'draft');
    assert.ok(draft.draftId.startsWith('cid_'));
    assert.equal(draft.sourceType, 'frustration_issue');
    assert.equal(draft.sourceId, 'fi_test123');
    assert.equal(draft.title, 'Permission prompts too frequent');
    assert.equal(draft.targetRepo, 'clowder-ai/cat-cafe');
    assert.ok(draft.createdAt > 0);
  });

  // INV-3: One FrustrationIssue maps to at most one non-cancelled draft
  it('create: rejects duplicate sourceId (INV-3)', async () => {
    await store.create(validInput);
    await assert.rejects(
      () => store.create(validInput),
      (err) => err.message.includes('already has') || err.message.includes('duplicate'),
    );
  });

  it('create: allows new draft after previous was cancelled (INV-3 edge)', async () => {
    const draft1 = await store.create(validInput);
    await store.cancel(draft1.draftId);
    const draft2 = await store.create(validInput);
    assert.ok(draft2.draftId !== draft1.draftId);
    assert.equal(draft2.status, 'draft');
  });

  // ── getById ─────────────────────────────────────────────────

  it('getById: returns draft by ID', async () => {
    const created = await store.create(validInput);
    const fetched = await store.getById(created.draftId);
    assert.ok(fetched);
    assert.equal(fetched.draftId, created.draftId);
  });

  it('getById: returns null for unknown ID', async () => {
    const result = await store.getById('cid_nonexistent');
    assert.equal(result, null);
  });

  // ── getBySourceId ───────────────────────────────────────────

  it('getBySourceId: returns active draft for source', async () => {
    const created = await store.create(validInput);
    const found = await store.getBySourceId('fi_test123');
    assert.ok(found);
    assert.equal(found.draftId, created.draftId);
  });

  it('getBySourceId: returns null after cancel', async () => {
    const created = await store.create(validInput);
    await store.cancel(created.draftId);
    const found = await store.getBySourceId('fi_test123');
    assert.equal(found, null);
  });

  it('getBySourceId: returns null for unknown source', async () => {
    const result = await store.getBySourceId('fi_unknown');
    assert.equal(result, null);
  });

  // ── publish ─────────────────────────────────────────────────

  it('publish: sets status=published with github data (INV-2)', async () => {
    const created = await store.create(validInput);
    const published = await store.publish({
      draftId: created.draftId,
      githubIssueNumber: 347,
      githubIssueUrl: 'https://github.com/clowder-ai/cat-cafe/issues/347',
    });
    assert.equal(published.status, 'published');
    assert.equal(published.githubIssueNumber, 347);
    assert.equal(published.githubIssueUrl, 'https://github.com/clowder-ai/cat-cafe/issues/347');
    assert.ok(published.publishedAt > 0);
  });

  // INV-1: Only draft can transition to published
  it('publish: rejects non-draft status (INV-1)', async () => {
    const created = await store.create(validInput);
    await store.cancel(created.draftId);
    await assert.rejects(
      () =>
        store.publish({
          draftId: created.draftId,
          githubIssueNumber: 1,
          githubIssueUrl: 'https://example.com',
        }),
      (err) => err.message.includes('not draft') || err.message.includes('cannot publish'),
    );
  });

  it('publish: rejects already published (INV-1)', async () => {
    const created = await store.create(validInput);
    await store.publish({
      draftId: created.draftId,
      githubIssueNumber: 1,
      githubIssueUrl: 'https://example.com',
    });
    await assert.rejects(
      () =>
        store.publish({
          draftId: created.draftId,
          githubIssueNumber: 2,
          githubIssueUrl: 'https://example.com/2',
        }),
      (err) => err.message.includes('not draft') || err.message.includes('cannot publish'),
    );
  });

  // ── cancel ──────────────────────────────────────────────────

  it('cancel: sets status=cancelled + cancelledAt', async () => {
    const created = await store.create(validInput);
    const cancelled = await store.cancel(created.draftId);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.cancelledAt > 0);
  });

  // INV-1: Only draft can transition to cancelled
  it('cancel: rejects non-draft status (INV-1)', async () => {
    const created = await store.create(validInput);
    await store.publish({
      draftId: created.draftId,
      githubIssueNumber: 1,
      githubIssueUrl: 'https://example.com',
    });
    await assert.rejects(
      () => store.cancel(created.draftId),
      (err) => err.message.includes('not draft') || err.message.includes('cannot cancel'),
    );
  });

  // ── updateContent ───────────────────────────────────────────

  it('updateContent: updates title and body', async () => {
    const created = await store.create(validInput);
    const updated = await store.updateContent(created.draftId, 'New Title', '## New Body');
    assert.equal(updated.title, 'New Title');
    assert.equal(updated.bodyMarkdown, '## New Body');
    assert.equal(updated.status, 'draft'); // status unchanged
  });

  it('updateContent: rejects non-draft status', async () => {
    const created = await store.create(validInput);
    await store.cancel(created.draftId);
    await assert.rejects(
      () => store.updateContent(created.draftId, 'Title', 'Body'),
      (err) => err.message.includes('not draft') || err.message.includes('cannot update'),
    );
  });

  // ── not found errors ────────────────────────────────────────

  it('publish: throws for unknown draftId', async () => {
    await assert.rejects(
      () =>
        store.publish({
          draftId: 'cid_unknown',
          githubIssueNumber: 1,
          githubIssueUrl: 'https://example.com',
        }),
      (err) => err.message.includes('not found'),
    );
  });

  it('cancel: throws for unknown draftId', async () => {
    await assert.rejects(
      () => store.cancel('cid_unknown'),
      (err) => err.message.includes('not found'),
    );
  });
});
