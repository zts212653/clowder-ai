import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { InMemoryCommunityIssueStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryCommunityIssueStore.js'
);

describe('GuardianAssignment store extension', () => {
  test('newly created issue has guardianAssignment = null', async () => {
    const store = new InMemoryCommunityIssueStore();
    const item = await store.create({
      repo: 'test/repo',
      issueNumber: 1,
      issueType: 'feature',
      title: 'Test issue',
    });
    assert.equal(item.guardianAssignment, null);
  });

  test('update with guardianAssignment persists it', async () => {
    const store = new InMemoryCommunityIssueStore();
    const item = await store.create({
      repo: 'test/repo',
      issueNumber: 2,
      issueType: 'bug',
      title: 'Bug report',
    });
    const assignment = {
      guardianCatId: 'gemini',
      signoffTokenHash: 'abc123hash',
      requestedAt: Date.now(),
      requestedBy: 'opus',
      signedOff: false,
      checklist: [],
    };
    const updated = await store.update(item.id, { guardianAssignment: assignment });
    assert.deepEqual(updated.guardianAssignment, assignment);
  });

  test('get returns stored guardianAssignment', async () => {
    const store = new InMemoryCommunityIssueStore();
    const item = await store.create({
      repo: 'test/repo',
      issueNumber: 3,
      issueType: 'feature',
      title: 'Feature request',
    });
    const assignment = {
      guardianCatId: 'codex',
      signoffTokenHash: 'def456hash',
      requestedAt: Date.now(),
      requestedBy: 'opus',
      signedOff: true,
      signedOffAt: Date.now(),
      approved: true,
      reason: 'All checks passed',
      checklist: [{ id: 'vision-alignment', label: 'Test', required: true, evidence: 'done' }],
    };
    await store.update(item.id, { guardianAssignment: assignment });
    const retrieved = await store.get(item.id);
    assert.deepEqual(retrieved.guardianAssignment, assignment);
  });

  test('update guardianAssignment to null clears it', async () => {
    const store = new InMemoryCommunityIssueStore();
    const item = await store.create({
      repo: 'test/repo',
      issueNumber: 4,
      issueType: 'question',
      title: 'Question',
    });
    await store.update(item.id, {
      guardianAssignment: {
        guardianCatId: 'gemini',
        signoffTokenHash: 'ghi789hash',
        requestedAt: Date.now(),
        requestedBy: 'opus',
        signedOff: false,
        checklist: [],
      },
    });
    const cleared = await store.update(item.id, { guardianAssignment: null });
    assert.equal(cleared.guardianAssignment, null);
  });
});
