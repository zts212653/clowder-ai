/**
 * F167 R2 P2 — admission.gate must self-heal gate-keeping marker even when
 * `run.execute` would not fire (e.g. quiet repo with no unnotified items).
 *
 * Cloud finding on `9d997e559` (RepoScanTaskSpec.ts:235):
 *   "Because this self-heal only runs inside run.execute, it is skipped
 *    whenever admission.gate finds no unnotified PR/issue and returns
 *    run:false. In deployments with pre-rollout repo-inbox bindings, a quiet
 *    repo or an already-delivered inbox thread can keep threadKind undefined
 *    indefinitely, so cats continuing in that existing guard thread can still
 *    call register_pr_tracking/hold_ball before the next webhook or
 *    reconciliation signal touches the binding."
 *
 * Fix: invoke selfHealInboxThreadKind for every bound repo at admission.gate
 * tick, independent of whether run.execute fires.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

function createMockReconciliationDedup({ notifiedAll = false } = {}) {
  const notified = new Set();
  return {
    notified,
    async isNotified() {
      return notifiedAll;
    },
    async markNotified(repo, type, number) {
      notified.add(`${repo}#${type}-${number}`);
    },
    async isBaselineEstablished() {
      return true; // skip baseline path
    },
    async markBaselineEstablished() {},
  };
}

function createMockBindingStore(threadId) {
  const bindings = new Map();
  bindings.set(`github-repo-event:owner/repo`, { threadId, userId: 'u1', createdAt: Date.now() });
  return {
    bindings,
    async getByExternal(connectorId, repo) {
      return bindings.get(`${connectorId}:${repo}`) ?? null;
    },
  };
}

function createMockThreadStore(initialThreadKind) {
  const calls = [];
  const thread = { id: 'thread-inbox-1', threadKind: initialThreadKind };
  return {
    calls,
    thread,
    async get(id) {
      return id === thread.id ? thread : null;
    },
    async updateThreadKind(id, kind) {
      calls.push({ id, kind });
      if (id === thread.id) {
        if (kind === null) delete thread.threadKind;
        else thread.threadKind = kind;
      }
    },
  };
}

describe('F167 R2 P2: RepoScanTaskSpec.admission.gate self-heals quiet-repo bindings', () => {
  let createRepoScanTaskSpec;

  beforeEach(async () => {
    const mod = await import('../dist/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js');
    createRepoScanTaskSpec = mod.createRepoScanTaskSpec;
  });

  function commonOpts(threadStore, { notifiedAll = false } = {}) {
    return {
      repoAllowlist: ['owner/repo'],
      inboxCatId: 'cat-maine-coon',
      defaultUserId: 'user-maintainer',
      reconciliationDedup: createMockReconciliationDedup({ notifiedAll }),
      bindingStore: createMockBindingStore('thread-inbox-1'),
      threadStore,
      deliverFn: async () => ({ messageId: 'msg-1', content: 'x' }),
      deliveryDeps: {},
      invokeTrigger: { trigger() {} },
      fetchOpenPRs: async () => [],
      fetchOpenIssues: async () => [],
      log: { info() {}, warn() {} },
    };
  }

  function gateCtx() {
    return { taskId: 'repo-scan', lastRunAt: Date.now() - 300_000, tickCount: 2 };
  }

  it('stamps gate-keeping marker on quiet repo during admission.gate, even when run:false', async () => {
    // Quiet repo: nothing to deliver, so admission.gate returns run:false; but
    // the binding still needs marker self-heal.
    const threadStore = createMockThreadStore(undefined);
    const spec = createRepoScanTaskSpec(commonOpts(threadStore, { notifiedAll: true }));

    const result = await spec.admission.gate(gateCtx());

    // Sanity: gate did not fire run (quiet repo path).
    assert.equal(result.run, false);

    // Critical: marker stamped despite no delivery.
    assert.equal(
      threadStore.thread.threadKind,
      'gate-keeping',
      'admission.gate must self-heal binding marker even when run:false',
    );
    assert.equal(threadStore.calls.length, 1, 'exactly one updateThreadKind call (self-heal)');
  });

  it('is idempotent: already-stamped quiet repo binding → no extra call', async () => {
    const threadStore = createMockThreadStore('gate-keeping');
    const spec = createRepoScanTaskSpec(commonOpts(threadStore, { notifiedAll: true }));

    await spec.admission.gate(gateCtx());

    assert.equal(threadStore.calls.length, 0, 'no redundant updateThreadKind when already gate-keeping');
  });

  it('fails open: threadStore.get throws → admission.gate still returns a verdict', async () => {
    const opts = commonOpts(
      {
        get: async () => {
          throw new Error('redis down');
        },
        updateThreadKind: async () => {},
      },
      { notifiedAll: true },
    );

    const spec = createRepoScanTaskSpec(opts);
    const result = await spec.admission.gate(gateCtx());

    // Gate must still complete; either run:false or run:true — just not throw.
    assert.ok(result && typeof result.run === 'boolean', 'gate must return a verdict despite threadStore failure');
  });

  it('non-CONNECTOR_ID bindings not touched (no cross-connector leak)', async () => {
    const threadStore = createMockThreadStore(undefined);
    const opts = commonOpts(threadStore, { notifiedAll: true });
    // Inject a binding for a different connector to verify scope is github-repo-event only
    opts.bindingStore.bindings.set('feishu:other/repo', {
      threadId: 'thread-feishu-1',
      userId: 'u1',
      createdAt: Date.now(),
    });

    const spec = createRepoScanTaskSpec(opts);
    await spec.admission.gate(gateCtx());

    // Only github-repo-event binding's thread should be self-heal touched.
    const feishuCalls = threadStore.calls.filter((c) => c.id === 'thread-feishu-1');
    assert.equal(feishuCalls.length, 0, 'must not touch non-github-repo-event bindings');
  });

  // F167 R4 P2 — codex cloud finding on fc2c3895d (RepoScanTaskSpec.ts:148):
  //   "Keep marker self-heal from aborting scans. In admission.gate, this new
  //    binding lookup is part of the optional gate-keeping marker repair, but
  //    it sits outside the inner best-effort try. If bindingStore.getByExternal
  //    has a transient Redis/read failure, control goes to the per-repo catch
  //    and skips fetchOpenPRs/fetchOpenIssues for that repo, so reconciliation
  //    notifications can be delayed or missed for that poll even though the
  //    self-heal comment says failures must not block the gate."
  //
  // Fix: wrap bindingStore.getByExternal + selfHealInboxThreadKind in one
  // combined best-effort try so marker repair cannot abort the scan loop.
  it('fails open: bindingStore.getByExternal throws during marker repair → fetchOpenPRs still runs', async () => {
    const threadStore = createMockThreadStore(undefined);
    const opts = commonOpts(threadStore);

    // Track that the actual reconciliation work fires despite marker-repair throw.
    let fetchPRsCalls = 0;
    let fetchIssuesCalls = 0;
    opts.fetchOpenPRs = async (_repo) => {
      fetchPRsCalls += 1;
      return [
        {
          number: 42,
          draft: false,
          author_association: 'CONTRIBUTOR',
          title: 'reconciliation PR',
          html_url: 'https://example/pr/42',
          user: 'octocat',
        },
      ];
    };
    opts.fetchOpenIssues = async (_repo) => {
      fetchIssuesCalls += 1;
      return [];
    };

    // Simulate transient Redis read failure during marker-repair lookup.
    opts.bindingStore.getByExternal = async () => {
      throw new Error('redis read failed (transient)');
    };

    const spec = createRepoScanTaskSpec(opts);
    const result = await spec.admission.gate(gateCtx());

    // INV-G7 fail-open: marker repair failure MUST NOT abort the scan loop.
    assert.equal(fetchPRsCalls, 1, 'fetchOpenPRs must run despite getByExternal throwing during marker repair');
    assert.equal(fetchIssuesCalls, 1, 'fetchOpenIssues must run despite getByExternal throwing during marker repair');

    // Unnotified PR → gate must report run:true with workItems (verifies
    // reconciliation notifications are not silently delayed).
    assert.equal(result.run, true, 'gate must surface the unnotified PR despite marker-repair lookup failure');
    assert.ok(
      result.workItems && result.workItems.length === 1,
      'workItems must include the unnotified PR (not lost to marker-repair fault)',
    );
    assert.equal(result.workItems[0].signal.number, 42);
    assert.equal(result.workItems[0].signal.subjectType, 'pr');
  });
});
