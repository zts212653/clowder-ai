/**
 * RepoScanTaskSpec community event emission tests (F168 Phase A — Task 7b)
 *
 * Verifies that the scan reconciliation path appends events to the eventLog
 * with sourceEventId = scan:{repo}:{number}:{kind}, and that webhook-deduped
 * items produce no-op events (idempotent by sourceEventId).
 *
 * Uses in-memory stubs — the real Redis-backed dedup/log behaviour is tested
 * in dedicated Redis tests.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// In-memory stubs
// ---------------------------------------------------------------------------

function makeInMemoryEventLog() {
  const events = [];
  const seen = new Set();
  return {
    events,
    /** Simulates Redis Lua idempotent append */
    append: async (event) => {
      if (seen.has(event.sourceEventId)) return { appended: false, sequence: -1 };
      seen.add(event.sourceEventId);
      events.push(event);
      return { appended: true, sequence: events.length - 1 };
    },
    read: async (subjectKey) => events.filter((e) => e.subjectKey === subjectKey),
    listSubjects: async () => [...new Set(events.map((e) => e.subjectKey))],
  };
}

function makeInMemoryProjector() {
  const applied = [];
  return {
    applied,
    apply: async (event) => {
      applied.push(event);
    },
    rebuild: async () => {},
    rebuildAll: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Helper: build a minimal RepoScanTaskSpec with in-memory stubs
// ---------------------------------------------------------------------------

async function buildScanSpec(extraOpts = {}) {
  const mod = await import('../dist/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js');
  const { createRepoScanTaskSpec } = mod;

  const notified = new Set();
  const baselined = new Set();

  const spec = createRepoScanTaskSpec({
    repoAllowlist: ['owner/repo'],
    inboxCatId: 'codex',
    defaultUserId: 'user-1',
    reconciliationDedup: {
      isNotified: async (_repo, type, number) => notified.has(`${type}:${number}`),
      markNotified: async (_repo, type, number) => {
        notified.add(`${type}:${number}`);
      },
      isBaselineEstablished: async () => true,
      markBaselineEstablished: async () => {},
    },
    bindingStore: {
      getByExternal: async () => ({
        threadId: 'thread-inbox',
        connectorId: 'github-repo-event',
        externalId: 'owner/repo',
      }),
    },
    deliverFn: async () => ({ messageId: 'msg-1', threadId: 'thread-inbox' }),
    deliveryDeps: {},
    invokeTrigger: { trigger: () => {} },
    fetchOpenPRs: async () => [
      {
        number: 10,
        title: 'PR 10',
        html_url: 'https://example.com/pr/10',
        user: 'dev',
        author_association: 'CONTRIBUTOR',
        draft: false,
      },
    ],
    fetchOpenIssues: async () => [
      {
        number: 20,
        title: 'Issue 20',
        html_url: 'https://example.com/issues/20',
        user: 'dev',
        author_association: 'CONTRIBUTOR',
      },
    ],
    log: { info: () => {}, warn: () => {} },
    skipHistoricalOnFirstRun: false,
    ...extraOpts,
  });

  return { spec, notified, baselined };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Task 7b — RepoScan emits community events', () => {
  let createRepoScanTaskSpec;

  before(async () => {
    const mod = await import('../dist/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js');
    createRepoScanTaskSpec = mod.createRepoScanTaskSpec;
  });

  it('scan discovers a PR → appends pr.opened event with scan sourceEventId', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();

    const { spec } = await buildScanSpec({ eventLog, projector });

    // Run gate to get work items
    const gateResult = await spec.admission.gate({});
    assert.ok(gateResult.run, 'scan should find work items');
    assert.ok(gateResult.workItems.length > 0);

    // Execute the PR work item
    const prItem = gateResult.workItems.find((w) => w.signal.subjectType === 'pr');
    assert.ok(prItem, 'should have a PR work item');
    await spec.run.execute(prItem.signal, prItem.subjectKey, {});

    // Verify event was appended
    const prEvents = eventLog.events.filter((e) => e.subjectKey === 'pr:owner/repo#10');
    assert.ok(prEvents.length >= 1, 'at least one pr event expected');
    const ev = prEvents[0];
    assert.strictEqual(ev.kind, 'pr.opened');
    assert.strictEqual(ev.sourceEventId, 'scan:owner/repo:10:pr.opened');
    assert.ok(ev.subjectKey.includes('owner/repo#10'));

    assert.ok(
      projector.applied.some((e) => e.kind === 'pr.opened'),
      'projector must be called',
    );
  });

  it('scan discovers an issue → appends issue.opened event with scan sourceEventId', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();

    const { spec } = await buildScanSpec({ eventLog, projector });

    const gateResult = await spec.admission.gate({});
    assert.ok(gateResult.run);

    const issueItem = gateResult.workItems.find((w) => w.signal.subjectType === 'issue');
    assert.ok(issueItem, 'should have an issue work item');
    await spec.run.execute(issueItem.signal, issueItem.subjectKey, {});

    const issueEvents = eventLog.events.filter((e) => e.subjectKey === 'issue:owner/repo#20');
    assert.ok(issueEvents.length >= 1, 'at least one issue event expected');
    const ev = issueEvents[0];
    assert.strictEqual(ev.kind, 'issue.opened');
    assert.strictEqual(ev.sourceEventId, 'scan:owner/repo:20:issue.opened');
  });

  it('scan without eventLog still processes normally (backward compat)', async () => {
    const { spec } = await buildScanSpec(); // no eventLog

    const gateResult = await spec.admission.gate({});
    assert.ok(gateResult.run);

    // Should not throw
    for (const item of gateResult.workItems) {
      await spec.run.execute(item.signal, item.subjectKey, {});
    }
    // No assertion on events — just verifies no crash
  });

  // P1-1 factory wiring: GitHubScheduleDeps must thread eventLog through to spec
  it('P1-1: repoScanFactory passes eventLog through GitHubScheduleDeps to the spec', async () => {
    const mod = await import('../dist/domains/plugin/github-schedule-factories.js');
    const { githubScheduleFactories } = mod;

    const repoScanFactory = githubScheduleFactories.find((f) => f.factoryId === 'github.repo-scan');
    assert.ok(repoScanFactory, 'repoScanFactory must be registered');

    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();

    // Build minimum valid GitHubScheduleDeps for repo-scan
    const notified = new Set();
    const deps = /** @type {any} */ ({
      taskStore: { listByKind: async () => [] },
      cicdRouter: {},
      conflictRouter: {},
      reviewFeedbackRouter: {},
      invokeTrigger: { trigger: () => {} },
      checkMergeable: async () => ({ mergeState: 'clean', headSha: 'abc' }),
      autoExecutor: {},
      fetchPrMetadata: async () => null,
      fetchComments: async () => [],
      fetchReviews: async () => [],
      isEchoComment: () => false,
      isEchoReview: () => false,
      isNoiseComment: () => false,
      repoAllowlist: ['owner/repo'],
      inboxCatId: 'codex',
      defaultUserId: 'user-1',
      reconciliationDedup: {
        isNotified: async () => false,
        markNotified: async (_r, type, num) => {
          notified.add(`${type}:${num}`);
        },
        isBaselineEstablished: async () => true,
        markBaselineEstablished: async () => {},
      },
      bindingStore: {
        getByExternal: async () => ({
          threadId: 'thread-1',
          connectorId: 'github-repo-event',
          externalId: 'owner/repo',
        }),
      },
      deliverFn: async () => ({ messageId: 'msg-1', threadId: 'thread-1' }),
      deliveryDeps: {},
      fetchOpenPRs: async () => [
        {
          number: 77,
          title: 'PR 77',
          html_url: 'https://example.com/pr/77',
          user: 'dev',
          author_association: 'CONTRIBUTOR',
          draft: false,
        },
      ],
      fetchOpenIssues: async () => [],
      log: { info: () => {}, warn: () => {} },
      // P1-1: eventLog and projector in deps
      eventLog,
      projector,
    });

    const spec = repoScanFactory.createTaskSpec('test-instance', deps);
    const gateResult = await spec.admission.gate({});
    assert.ok(gateResult.run, 'gate should allow run');

    for (const item of gateResult.workItems ?? []) {
      await spec.run.execute(item.signal, item.subjectKey, {});
    }

    // P1-1 fix: eventLog must have received events from the factory-created spec
    assert.ok(eventLog.events.length > 0, 'P1-1: factory-created spec must emit community events via eventLog');
  });

  it('scan: webhook already emitted event → dedup → no-op on second append', async () => {
    const eventLog = makeInMemoryEventLog();
    const projector = makeInMemoryProjector();

    // Pre-seed eventLog as if webhook already appended a pr.opened event
    await eventLog.append({
      sourceEventId: 'scan:owner/repo:10:pr.opened',
      subjectKey: 'pr:owner/repo#10',
      kind: 'pr.opened',
      classification: 'state-changing',
      payload: { title: 'pre-seeded' },
      at: Date.now(),
    });
    assert.strictEqual(eventLog.events.length, 1);

    const { spec } = await buildScanSpec({ eventLog, projector });
    const gateResult = await spec.admission.gate({});
    const prItem = gateResult.workItems?.find((w) => w.signal.subjectType === 'pr');
    if (prItem) {
      await spec.run.execute(prItem.signal, prItem.subjectKey, {});
    }

    // Should still be 1 event (dedup no-op)
    assert.strictEqual(eventLog.events.length, 1, 'dedup must prevent duplicate event');
  });
});
