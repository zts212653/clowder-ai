/**
 * TriageOrchestrator autoRoute tests (F168 Phase F — F3)
 *
 * When repoConfigStore is wired, recordTriageEntry branches on confidence
 * after WELCOME consensus:
 *   - high confidence → auto-route (assignedCatId from config, threadId from
 *     routeRecommendation, routeAcceptance='pending', routeSource='auto')
 *   - low confidence  → state='pending-decision' (Decision Queue for operator)
 *
 * INV-F0: No repo config = fail-closed (no autoRoute)
 * INV-F5: autoRoute only on verdict=WELCOME + confidence=high
 * INV-F6: autoRoute must set routeAcceptance=pending
 * INV-F7: autoRoute requires existing-thread routeRecommendation
 */

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
  repo: 'zts212653/clowder-ai',
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
  guardianAssignment: null,
  lastActivity: { at: Date.now(), event: 'dispatched' },
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

/** High-confidence entry: WELCOME + all PASS + existing-thread recommendation */
const highConfidenceEntry = (catId) =>
  makeEntry(catId, 'WELCOME', {
    routeRecommendation: { kind: 'existing-thread', threadId: 'thread_target' },
  });

/** Low-confidence entry: WELCOME but a FAIL question */
const lowConfidenceEntry = (catId) =>
  makeEntry(catId, 'WELCOME', {
    questions: [
      { id: 'Q1', result: 'PASS' },
      { id: 'Q2', result: 'FAIL' },
      { id: 'Q3', result: 'PASS' },
      { id: 'Q4', result: 'PASS' },
      { id: 'Q5', result: 'PASS' },
    ],
    routeRecommendation: { kind: 'existing-thread', threadId: 'thread_target' },
  });

describe('TriageOrchestrator autoRoute (Phase F)', () => {
  let issueStore;
  let repoConfigStore;
  let orchestrator;

  beforeEach(() => {
    issueStore = {
      get: mock.fn(async () => ({
        ...baseIssue(),
        directionCard: { entries: [highConfidenceEntry('opus')] },
      })),
      update: mock.fn(async (_id, patch) => ({ ...baseIssue(), ...patch })),
    };

    repoConfigStore = {
      getByRepo: mock.fn(async (repo) => {
        if (repo === 'zts212653/clowder-ai') {
          return {
            repo: 'zts212653/clowder-ai',
            guardThreadId: 'thread_guard',
            guardCatId: 'codex',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        }
        return null;
      }),
    };

    orchestrator = new TriageOrchestrator({
      communityIssueStore: issueStore,
      repoConfigStore,
    });
  });

  // ─── INV-F5: autoRoute only on WELCOME + high confidence ────────────────

  test('WELCOME + high confidence + repo config → action=auto-routed', async () => {
    const result = await orchestrator.recordTriageEntry('ci_1', highConfidenceEntry('codex'));
    assert.equal(result.action, 'auto-routed');
    assert.equal(result.targetCatId, 'codex');
    assert.equal(result.threadId, 'thread_target');
  });

  test('WELCOME + low confidence → action=resolved + state=pending-decision', async () => {
    const result = await orchestrator.recordTriageEntry('ci_1', lowConfidenceEntry('codex'));
    assert.equal(result.action, 'resolved');
    assert.equal(result.consensus.verdict, 'WELCOME');

    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'pending-decision');
  });

  // ─── INV-F0: No repo config = fail-closed ───────────────────────────────

  test('WELCOME + high confidence + no repo config → fallback to pending-decision (INV-F0)', async () => {
    repoConfigStore.getByRepo = mock.fn(async () => null);

    const result = await orchestrator.recordTriageEntry('ci_1', highConfidenceEntry('codex'));
    // Without config, cannot auto-route → falls back
    assert.equal(result.action, 'resolved');
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'pending-decision');
  });

  // ─── INV-F6: autoRoute must set routeAcceptance=pending ─────────────────

  test('autoRoute sets routeAcceptance=pending and routeSource=auto (INV-F6)', async () => {
    await orchestrator.recordTriageEntry('ci_1', highConfidenceEntry('codex'));

    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.routeAcceptance, 'pending');
    assert.equal(patch.routeSource, 'auto');
    assert.equal(patch.assignedCatId, 'codex');
    assert.equal(patch.assignedThreadId, 'thread_target');
  });

  // ─── Existing behavior preserved ────────────────────────────────────────

  test('NEEDS-DISCUSSION → pending-decision (unchanged)', async () => {
    issueStore.get = mock.fn(async () => ({
      ...baseIssue(),
      directionCard: { entries: [makeEntry('opus', 'WELCOME')] },
    }));

    const result = await orchestrator.recordTriageEntry('ci_1', makeEntry('codex', 'NEEDS-DISCUSSION'));
    assert.equal(result.consensus.needsOwner, true);
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'pending-decision');
  });

  test('POLITELY-DECLINE → declined (unchanged)', async () => {
    issueStore.get = mock.fn(async () => ({
      ...baseIssue(),
      directionCard: {
        entries: [makeEntry('opus', 'POLITELY-DECLINE', { reasonCode: 'OUT_OF_SCOPE' })],
      },
    }));

    const result = await orchestrator.recordTriageEntry(
      'ci_1',
      makeEntry('codex', 'POLITELY-DECLINE', { reasonCode: 'OUT_OF_SCOPE' }),
    );
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'declined');
  });

  // ─── P2-R3-1: auto-route must validate threadId against threadStore ─────

  test('auto-route falls back to pending-decision when thread ID is stale/deleted (P2-R3-1)', async () => {
    const threadStore = {
      create: async () => ({ id: 'thread_new', title: 'mock', createdAt: Date.now() }),
      get: async (id) => {
        // thread_target is known; anything else is "stale/deleted"
        if (id === 'thread_target') return { id, title: 'mock', createdAt: Date.now() };
        return null;
      },
    };

    const orchWithThreadStore = new TriageOrchestrator({
      communityIssueStore: issueStore,
      repoConfigStore,
      threadStore,
    });

    // Entry references a stale thread
    const staleEntry = makeEntry('codex', 'WELCOME', {
      routeRecommendation: { kind: 'existing-thread', threadId: 'thread_deleted_xyz' },
    });

    const result = await orchWithThreadStore.recordTriageEntry('ci_1', staleEntry);
    // Should NOT auto-route — fall back to pending-decision
    assert.equal(result.action, 'resolved');
    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'pending-decision');
  });

  test('auto-route proceeds when thread ID is valid (P2-R3-1)', async () => {
    const threadStore = {
      create: async () => ({ id: 'thread_new', title: 'mock', createdAt: Date.now() }),
      get: async (id) => {
        if (id === 'thread_target') return { id, title: 'mock', createdAt: Date.now() };
        return null;
      },
    };

    const orchWithThreadStore = new TriageOrchestrator({
      communityIssueStore: issueStore,
      repoConfigStore,
      threadStore,
    });

    const result = await orchWithThreadStore.recordTriageEntry('ci_1', highConfidenceEntry('codex'));
    assert.equal(result.action, 'auto-routed');
    assert.equal(result.threadId, 'thread_target');
  });

  // ─── Backward compat: no repoConfigStore → existing WELCOME behavior ───

  test('without repoConfigStore, WELCOME → state=accepted (backward compat)', async () => {
    const noConfigOrch = new TriageOrchestrator({
      communityIssueStore: issueStore,
      // no repoConfigStore
    });

    const result = await noConfigOrch.recordTriageEntry('ci_1', highConfidenceEntry('codex'));
    assert.equal(result.action, 'resolved');
    assert.equal(result.consensus.verdict, 'WELCOME');

    const patch = issueStore.update.mock.calls[0].arguments[1];
    assert.equal(patch.state, 'accepted');
  });
});
