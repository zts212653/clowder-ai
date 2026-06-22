/**
 * F167 R2 P1#2 — Reconciliation path (RepoScanTaskSpec) must self-heal
 * the gate-keeping marker before delivery, so pre-rollout inbox threads
 * whose only activity is reconciliation aren't silently bypassed by the
 * trigger-time guard.
 *
 * @gpt52 R1 review P1#2: ensureInboxThread stamping only lived on the
 * webhook path (GitHubRepoWebhookHandler), but RepoScanTaskSpec delivers
 * directly from bindingStore.getByExternal → binding.threadId. Without
 * self-heal here, a repo whose inbox only receives reconciliation events
 * (e.g. quiet repo + late-arriving webhook reconciler) keeps threadKind
 * undefined forever and guard does nothing.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const SIGNAL = {
  eventType: 'pull_request.opened',
  subjectType: 'pr',
  number: 42,
  repoFullName: 'owner/repo',
  url: 'https://github.com/owner/repo/pull/42',
  title: 'PR via reconciliation',
  authorLogin: 'alice',
  authorAssociation: 'CONTRIBUTOR',
  action: 'opened',
  deliveryId: 'recon-1',
};

function createMockReconciliationDedup() {
  const notified = new Set();
  return {
    async isNotified(repo, type, number) {
      return notified.has(`${repo}#${type}-${number}`);
    },
    async markNotified(repo, type, number) {
      notified.add(`${repo}#${type}-${number}`);
    },
    async isBaselineEstablished() {
      return true;
    },
    async markBaselineEstablished() {},
  };
}

function createMockBindingStore(threadId) {
  return {
    async getByExternal(connectorId, repo) {
      if (connectorId === 'github-repo-event' && repo === 'owner/repo') {
        return { threadId, userId: 'user-maintainer', createdAt: Date.now() };
      }
      return null;
    },
  };
}

/**
 * Mock threadStore that records updateThreadKind calls so tests can assert
 * "stamped exactly once on first reconciliation, no-op when already stamped".
 */
function createMockThreadStore(initialThreadKind) {
  const calls = [];
  const thread = { id: 'thread-inbox-1', threadKind: initialThreadKind };
  return {
    calls,
    thread,
    async get(threadId) {
      return threadId === thread.id ? thread : null;
    },
    async updateThreadKind(threadId, kind) {
      calls.push({ threadId, kind });
      if (threadId === thread.id) {
        if (kind === null) {
          delete thread.threadKind;
        } else {
          thread.threadKind = kind;
        }
      }
    },
  };
}

describe('F167 R2 P1#2: RepoScanTaskSpec self-heals gate-keeping marker', () => {
  let createRepoScanTaskSpec;

  beforeEach(async () => {
    const mod = await import('../dist/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js');
    createRepoScanTaskSpec = mod.createRepoScanTaskSpec;
  });

  function commonOpts(threadStore) {
    return {
      repoAllowlist: ['owner/repo'],
      inboxCatId: 'cat-maine-coon',
      defaultUserId: 'user-maintainer',
      reconciliationDedup: createMockReconciliationDedup(),
      bindingStore: createMockBindingStore('thread-inbox-1'),
      threadStore,
      deliverFn: async (_d, input) => ({ messageId: 'msg-1', content: input.content }),
      deliveryDeps: {},
      invokeTrigger: { trigger() {} },
      fetchOpenPRs: async () => [],
      fetchOpenIssues: async () => [],
      log: { info() {}, warn() {} },
    };
  }

  it('stamps gate-keeping marker on pre-rollout inbox thread during reconciliation delivery', async () => {
    const threadStore = createMockThreadStore(undefined); // pre-rollout: kind missing
    const spec = createRepoScanTaskSpec(commonOpts(threadStore));

    await spec.run.execute(SIGNAL, 'pr:owner/repo#42', { assignedCatId: null });

    assert.equal(threadStore.thread.threadKind, 'gate-keeping', 'self-heal must stamp marker');
    assert.equal(threadStore.calls.length, 1, 'exactly one updateThreadKind call (self-heal)');
    assert.equal(threadStore.calls[0].kind, 'gate-keeping');
  });

  it('is idempotent: thread already gate-keeping → no updateThreadKind call', async () => {
    const threadStore = createMockThreadStore('gate-keeping'); // already stamped
    const spec = createRepoScanTaskSpec(commonOpts(threadStore));

    await spec.run.execute(SIGNAL, 'pr:owner/repo#42', { assignedCatId: null });

    assert.equal(threadStore.thread.threadKind, 'gate-keeping');
    assert.equal(threadStore.calls.length, 0, 'no redundant updateThreadKind call');
  });

  it('falls back gracefully when threadStore not wired (backward compat)', async () => {
    // No threadStore — reconciliation must still deliver, just with a warn log.
    const warns = [];
    const opts = commonOpts(undefined);
    opts.threadStore = undefined;
    opts.log = { info() {}, warn: (msg) => warns.push(msg) };

    const spec = createRepoScanTaskSpec(opts);
    await spec.run.execute(SIGNAL, 'pr:owner/repo#42', { assignedCatId: null });

    assert.ok(
      warns.some((w) => /threadStore not wired/.test(w)),
      `expected warn about threadStore not wired, got: ${warns.join(' | ')}`,
    );
  });

  it('fails open: threadStore.get throws → delivery still proceeds', async () => {
    let delivered = false;
    const opts = commonOpts({
      get: async () => {
        throw new Error('redis down');
      },
      updateThreadKind: async () => {},
    });
    opts.deliverFn = async () => {
      delivered = true;
      return { messageId: 'msg-1', content: 'x' };
    };

    const spec = createRepoScanTaskSpec(opts);
    await spec.run.execute(SIGNAL, 'pr:owner/repo#42', { assignedCatId: null });

    assert.equal(delivered, true, 'delivery must NOT be blocked by self-heal failure');
  });
});
