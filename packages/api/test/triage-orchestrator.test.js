import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

const { TriageOrchestrator } = await import('../dist/domains/community/TriageOrchestrator.js');

const fivePass = [
  { id: 'Q1', result: 'PASS' },
  { id: 'Q2', result: 'PASS' },
  { id: 'Q3', result: 'PASS' },
  { id: 'Q4', result: 'PASS' },
  { id: 'Q5', result: 'PASS' },
];

const makeEntry = (catId, verdict, extra = {}) => ({
  catId,
  verdict,
  questions: fivePass,
  timestamp: Date.now(),
  ...extra,
});

const baseIssue = () => ({
  id: 'ci_1',
  repo: 'org/repo',
  issueNumber: 42,
  issueType: 'feature',
  title: 'Add SSO',
  state: 'discussing',
  replyState: 'unreplied',
  assignedThreadId: null,
  assignedCatId: null,
  linkedPrNumbers: [],
  directionCard: null,
  ownerDecision: null,
  relatedFeature: null,
  lastActivity: { at: Date.now(), event: 'dispatched' },
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('TriageOrchestrator', () => {
  let orchestrator;
  let issueStore;
  let messageStore;
  let threadStore;

  beforeEach(() => {
    issueStore = {
      get: mock.fn(async () => baseIssue()),
      update: mock.fn(async (_id, patch) => ({ ...baseIssue(), ...patch })),
    };
    messageStore = {
      append: mock.fn(async (input) => ({ id: 'msg_1', ...input })),
    };
    threadStore = {
      list: mock.fn(async () => []),
      create: mock.fn(async (_userId, title) => ({
        id: 'thread_new',
        title,
        createdAt: Date.now(),
      })),
      updatePreferredCats: mock.fn(async () => {}),
    };
    orchestrator = new TriageOrchestrator({
      communityIssueStore: issueStore,
      messageStore,
      threadStore,
    });
  });

  test('recordTriageEntry stores first entry, returns await-second-cat', async () => {
    const result = await orchestrator.recordTriageEntry('ci_1', makeEntry('opus', 'WELCOME'));
    assert.equal(result.action, 'await-second-cat');
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.directionCard.entries.length, 1);
    assert.equal(patch.directionCard.entries[0].catId, 'opus');
  });

  test('recordTriageEntry for bugfix skips second cat, resolves immediately', async () => {
    issueStore.get = mock.fn(async () => ({ ...baseIssue(), issueType: 'bug' }));
    const result = await orchestrator.recordTriageEntry('ci_1', makeEntry('opus', 'WELCOME'));
    assert.equal(result.action, 'resolved');
    assert.equal(result.consensus.needsOwner, false);
    assert.equal(result.consensus.verdict, 'WELCOME');
  });

  test('second entry resolves consensus', async () => {
    issueStore.get = mock.fn(async () => ({
      ...baseIssue(),
      directionCard: { entries: [makeEntry('opus', 'WELCOME')] },
    }));
    const result = await orchestrator.recordTriageEntry('ci_1', makeEntry('codex', 'WELCOME'));
    assert.equal(result.action, 'resolved');
    assert.equal(result.consensus.verdict, 'WELCOME');
    assert.equal(result.consensus.needsOwner, false);
  });

  test('disagreement sets state to pending-decision', async () => {
    issueStore.get = mock.fn(async () => ({
      ...baseIssue(),
      directionCard: { entries: [makeEntry('opus', 'WELCOME')] },
    }));
    const result = await orchestrator.recordTriageEntry(
      'ci_1',
      makeEntry('codex', 'POLITELY-DECLINE', { reasonCode: 'STACK_MISFIT' }),
    );
    assert.equal(result.consensus.needsOwner, true);
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'pending-decision');
    assert.equal(patch.consensusState, 'discussing');
  });

  test('both WELCOME sets state to accepted', async () => {
    issueStore.get = mock.fn(async () => ({
      ...baseIssue(),
      directionCard: { entries: [makeEntry('opus', 'WELCOME')] },
    }));
    await orchestrator.recordTriageEntry('ci_1', makeEntry('codex', 'WELCOME'));
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'accepted');
    assert.equal(patch.consensusState, 'consensus-reached');
  });

  test('both POLITELY-DECLINE sets state to declined', async () => {
    issueStore.get = mock.fn(async () => ({
      ...baseIssue(),
      directionCard: { entries: [makeEntry('opus', 'POLITELY-DECLINE', { reasonCode: 'OUT_OF_SCOPE' })] },
    }));
    await orchestrator.recordTriageEntry(
      'ci_1',
      makeEntry('codex', 'POLITELY-DECLINE', { reasonCode: 'OUT_OF_SCOPE' }),
    );
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'declined');
  });

  test('rejects duplicate catId on second entry', async () => {
    issueStore.get = mock.fn(async () => ({
      ...baseIssue(),
      directionCard: { entries: [makeEntry('opus', 'WELCOME')] },
    }));
    const result = await orchestrator.recordTriageEntry('ci_1', makeEntry('opus', 'NEEDS-DISCUSSION'));
    assert.equal(result.action, 'error');
    assert.ok(result.reason.includes('duplicate'));
    assert.equal(issueStore.update.mock.callCount(), 0);
  });

  test('issue not found returns error', async () => {
    issueStore.get = mock.fn(async () => null);
    const result = await orchestrator.recordTriageEntry('ci_99', makeEntry('opus', 'WELCOME'));
    assert.equal(result.action, 'error');
  });

  test('routeAccepted without relatedFeature creates new thread', async () => {
    await orchestrator.routeAccepted('ci_1', null, 'user_1');
    assert.equal(threadStore.create.mock.callCount(), 1);
    assert.equal(threadStore.create.mock.calls[0].arguments[0], 'user_1');
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'accepted');
    assert.equal(patch.assignedThreadId, 'thread_new');
  });

  test('routeAccepted with relatedFeature and threadId sets assignedThreadId', async () => {
    await orchestrator.routeAccepted('ci_1', 'F056', 'user_1', 'thread_f056');
    assert.equal(threadStore.create.mock.callCount(), 0);
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'accepted');
    assert.equal(patch.relatedFeature, 'F056');
    assert.equal(patch.assignedThreadId, 'thread_f056');
  });

  test('routeAccepted with relatedFeature without threadId omits assignedThreadId', async () => {
    await orchestrator.routeAccepted('ci_1', 'F056', 'user_1');
    assert.equal(threadStore.create.mock.callCount(), 0);
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'accepted');
    assert.equal(patch.relatedFeature, 'F056');
    assert.equal(patch.assignedThreadId, undefined);
  });

  test('routeDeclined updates state', async () => {
    await orchestrator.routeDeclined('ci_1');
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'declined');
  });

  test('preserves existing relatedFeature if entry has none', async () => {
    issueStore.get = mock.fn(async () => ({
      ...baseIssue(),
      issueType: 'bug',
      relatedFeature: 'F042',
    }));
    await orchestrator.recordTriageEntry('ci_1', makeEntry('opus', 'WELCOME'));
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.relatedFeature, 'F042');
  });
});
