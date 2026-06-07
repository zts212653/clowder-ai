import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/** Helpers */
function createMockReconciliationDedup() {
  const notified = new Set();
  const baselineEstablished = new Set(['owner/repo']);
  return {
    notified,
    baselineEstablished,
    async isNotified(repo, type, number) {
      return notified.has(`${repo}#${type}-${number}`);
    },
    async markNotified(repo, type, number) {
      notified.add(`${repo}#${type}-${number}`);
    },
    async isBaselineEstablished(repo) {
      return baselineEstablished.has(repo);
    },
    async markBaselineEstablished(repo) {
      baselineEstablished.add(repo);
    },
  };
}

function createMockBindingStore(bindings = new Map()) {
  return {
    bindings,
    async getByExternal(connectorId, externalChatId) {
      return bindings.get(`${connectorId}:${externalChatId}`) ?? null;
    },
  };
}

const SAMPLE_PRS = [
  {
    number: 10,
    title: 'Add feature X',
    html_url: 'https://github.com/r/p/pull/10',
    user: 'alice',
    author_association: 'CONTRIBUTOR',
    draft: false,
  },
  {
    number: 11,
    title: 'Draft WIP',
    html_url: 'https://github.com/r/p/pull/11',
    user: 'bob',
    author_association: 'NONE',
    draft: true,
  },
  {
    number: 12,
    title: 'Fix bug Y',
    html_url: 'https://github.com/r/p/pull/12',
    user: 'carol',
    author_association: 'MEMBER',
    draft: false,
  },
];

const SAMPLE_ISSUES = [
  {
    number: 20,
    title: 'Bug report',
    html_url: 'https://github.com/r/p/issues/20',
    user: 'dave',
    author_association: 'NONE',
  },
];

describe('RepoScanTaskSpec', () => {
  let createRepoScanTaskSpec;

  beforeEach(async () => {
    const mod = await import('../dist/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js');
    createRepoScanTaskSpec = mod.createRepoScanTaskSpec;
  });

  function createOpts(overrides = {}) {
    const deliveredMessages = [];
    const markCalls = [];
    const triggerCalls = [];
    const reconciliationDedup = createMockReconciliationDedup();
    const bindings = new Map();
    bindings.set('github-repo-event:owner/repo', { threadId: 'thread-inbox-1', userId: 'user-1' });

    const opts = {
      repoAllowlist: ['owner/repo'],
      inboxCatId: 'cat-maine-coon',
      defaultUserId: 'user-maintainer',
      reconciliationDedup,
      bindingStore: createMockBindingStore(bindings),
      deliverFn: async (_deps, input) => {
        deliveredMessages.push(input);
        return { messageId: `msg-${deliveredMessages.length}`, content: input.content };
      },
      deliveryDeps: {},
      invokeTrigger: {
        trigger(...args) {
          triggerCalls.push(args);
        },
      },
      fetchOpenPRs: async () => [...SAMPLE_PRS],
      fetchOpenIssues: async () => [...SAMPLE_ISSUES],
      log: { info() {}, warn() {} },
      ...overrides,
    };
    return { opts, deliveredMessages, markCalls, triggerCalls, reconciliationDedup, bindings };
  }

  function gateCtx(overrides = {}) {
    return { taskId: 'repo-scan', lastRunAt: Date.now() - 300_000, tickCount: 2, ...overrides };
  }

  // ── Gate tests ──

  describe('gate', () => {
    it('returns workItems for unnotified open PRs and Issues', async () => {
      const { opts } = createOpts();
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      assert.equal(result.run, true);
      // 2 non-draft PRs + 1 issue = 3 workItems
      assert.equal(result.workItems.length, 3);
      assert.equal(result.workItems[0].signal.subjectType, 'pr');
      assert.equal(result.workItems[0].signal.number, 10);
      assert.equal(result.workItems[1].signal.subjectType, 'pr');
      assert.equal(result.workItems[1].signal.number, 12);
      assert.equal(result.workItems[2].signal.subjectType, 'issue');
      assert.equal(result.workItems[2].signal.number, 20);
    });

    it('filters out draft PRs', async () => {
      const { opts } = createOpts({
        fetchOpenPRs: async () => [SAMPLE_PRS[1]], // only draft
        fetchOpenIssues: async () => [],
      });
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      assert.equal(result.run, false);
    });

    it('filters out already-notified items', async () => {
      const { opts, reconciliationDedup } = createOpts();
      await reconciliationDedup.markNotified('owner/repo', 'pr', 10);
      await reconciliationDedup.markNotified('owner/repo', 'pr', 12);
      await reconciliationDedup.markNotified('owner/repo', 'issue', 20);

      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      assert.equal(result.run, false);
      assert.ok(result.reason.includes('no unnotified'));
    });

    it('returns run=false when no repos in allowlist', async () => {
      const { opts } = createOpts({ repoAllowlist: [] });
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      assert.equal(result.run, false);
      assert.ok(result.reason.includes('no repos'));
    });

    it('handles gh api failure gracefully (fail-open per repo)', async () => {
      const { opts } = createOpts({
        repoAllowlist: ['owner/repo', 'owner/broken'],
        fetchOpenPRs: async (repo) => {
          if (repo === 'owner/broken') throw new Error('API timeout');
          return [...SAMPLE_PRS];
        },
        fetchOpenIssues: async (repo) => {
          if (repo === 'owner/broken') throw new Error('API timeout');
          return [...SAMPLE_ISSUES];
        },
      });
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      // Should still return items from owner/repo
      assert.equal(result.run, true);
      assert.equal(result.workItems.length, 3);
    });

    it('uses correct subjectKey format', async () => {
      const { opts } = createOpts();
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      assert.equal(result.workItems[0].subjectKey, 'repo-owner/repo#pr-10');
      assert.equal(result.workItems[2].subjectKey, 'repo-owner/repo#issue-20');
    });

    it('baselines existing open items before the persistent repo baseline is established', async () => {
      const { opts, reconciliationDedup } = createOpts();
      reconciliationDedup.baselineEstablished.clear();
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      assert.equal(result.run, false);
      assert.ok(result.reason.includes('baseline established'));
      assert.equal(await reconciliationDedup.isNotified('owner/repo', 'pr', 10), true);
      assert.equal(await reconciliationDedup.isNotified('owner/repo', 'pr', 12), true);
      assert.equal(await reconciliationDedup.isNotified('owner/repo', 'issue', 20), true);
      assert.equal(await reconciliationDedup.isBaselineEstablished('owner/repo'), true);
    });

    it('does not re-baseline on scheduler restart after the persistent repo baseline exists', async () => {
      const { opts } = createOpts();
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx({ lastRunAt: null, tickCount: 1 }));

      assert.equal(result.run, true);
      assert.equal(result.workItems.length, 3);
    });

    it('caps work items per scan to avoid waking the cat once per backlog item', async () => {
      const { opts } = createOpts({
        maxWorkItemsPerRun: 2,
      });
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      assert.equal(result.run, true);
      assert.equal(result.workItems.length, 2);
      assert.deepEqual(
        result.workItems.map((item) => `${item.signal.subjectType}-${item.signal.number}`),
        ['pr-10', 'pr-12'],
      );
    });

    it('rotates capped work items across scans so a bad prefix cannot starve later items', async () => {
      const prs = Array.from({ length: 5 }, (_, idx) => ({
        number: idx + 1,
        title: `PR ${idx + 1}`,
        html_url: `https://github.com/r/p/pull/${idx + 1}`,
        user: 'alice',
        author_association: 'CONTRIBUTOR',
        draft: false,
      }));
      const { opts } = createOpts({
        maxWorkItemsPerRun: 2,
        fetchOpenPRs: async () => prs,
        fetchOpenIssues: async () => [],
      });
      const spec = createRepoScanTaskSpec(opts);

      const first = await spec.admission.gate(gateCtx());
      const second = await spec.admission.gate(gateCtx());
      const third = await spec.admission.gate(gateCtx());

      assert.deepEqual(
        first.workItems.map((item) => item.signal.number),
        [1, 2],
      );
      assert.deepEqual(
        second.workItems.map((item) => item.signal.number),
        [3, 4],
      );
      assert.deepEqual(
        third.workItems.map((item) => item.signal.number),
        [5, 1],
      );
    });

    it('filters out OWNER PRs and issues — repo owner actions should not trigger community intake', async () => {
      const ownerPr = {
        number: 50,
        title: 'sync: cat-cafe → clowder-ai',
        html_url: 'https://github.com/r/p/pull/50',
        user: 'repoowner',
        author_association: 'OWNER',
        draft: false,
      };
      const ownerIssue = {
        number: 60,
        title: 'internal tracking issue',
        html_url: 'https://github.com/r/p/issues/60',
        user: 'repoowner',
        author_association: 'OWNER',
      };
      const communityPr = {
        number: 51,
        title: 'feat: community contribution',
        html_url: 'https://github.com/r/p/pull/51',
        user: 'contributor',
        author_association: 'CONTRIBUTOR',
        draft: false,
      };
      const { opts } = createOpts({
        fetchOpenPRs: async () => [ownerPr, communityPr],
        fetchOpenIssues: async () => [ownerIssue],
      });
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      // Only community PR should come through; OWNER PR and issue should be silently skipped
      assert.equal(result.run, true);
      assert.equal(result.workItems.length, 1);
      assert.equal(result.workItems[0].signal.number, 51);
      assert.equal(result.workItems[0].signal.authorAssociation, 'CONTRIBUTOR');
    });

    it('returns run=false when all items are from OWNER', async () => {
      const { opts } = createOpts({
        fetchOpenPRs: async () => [
          {
            number: 70,
            title: 'Owner PR',
            html_url: 'https://github.com/r/p/pull/70',
            user: 'owner',
            author_association: 'OWNER',
            draft: false,
          },
        ],
        fetchOpenIssues: async () => [
          {
            number: 80,
            title: 'Owner issue',
            html_url: 'https://github.com/r/p/issues/80',
            user: 'owner',
            author_association: 'OWNER',
          },
        ],
      });
      const spec = createRepoScanTaskSpec(opts);
      const result = await spec.admission.gate(gateCtx());

      assert.equal(result.run, false);
      assert.ok(result.reason.includes('no unnotified'));
    });
  });

  // ── Execute tests ──

  describe('execute', () => {
    it('delivers message to correct inbox thread', async () => {
      const { opts, deliveredMessages } = createOpts();
      const spec = createRepoScanTaskSpec(opts);
      const gateResult = await spec.admission.gate(gateCtx());
      const workItem = gateResult.workItems[0];

      await spec.run.execute(workItem.signal, workItem.subjectKey, { assignedCatId: null });

      assert.equal(deliveredMessages.length, 1);
      assert.equal(deliveredMessages[0].threadId, 'thread-inbox-1');
      assert.equal(deliveredMessages[0].catId, 'cat-maine-coon');
      assert.ok(deliveredMessages[0].content.includes('#10'));
    });

    it('marks item as notified after delivery', async () => {
      const { opts, reconciliationDedup } = createOpts();
      const spec = createRepoScanTaskSpec(opts);
      const gateResult = await spec.admission.gate(gateCtx());
      const workItem = gateResult.workItems[0];

      await spec.run.execute(workItem.signal, workItem.subjectKey, { assignedCatId: null });

      assert.equal(await reconciliationDedup.isNotified('owner/repo', 'pr', 10), true);
    });

    it('triggers cat after delivery', async () => {
      const { opts, triggerCalls } = createOpts();
      const spec = createRepoScanTaskSpec(opts);
      const gateResult = await spec.admission.gate(gateCtx());
      const workItem = gateResult.workItems[0];

      await spec.run.execute(workItem.signal, workItem.subjectKey, { assignedCatId: null });

      assert.equal(triggerCalls.length, 1);
      assert.equal(triggerCalls[0][0], 'thread-inbox-1'); // threadId
      assert.equal(triggerCalls[0][1], 'cat-maine-coon'); // catId
    });

    it('skips delivery if no inbox thread exists for repo', async () => {
      const { opts, deliveredMessages } = createOpts();
      opts.bindingStore = createMockBindingStore(new Map()); // empty
      const spec = createRepoScanTaskSpec(opts);

      const signal = {
        eventType: 'pull_request.opened',
        repoFullName: 'owner/repo',
        subjectType: 'pr',
        number: 99,
        title: 'Orphan PR',
        url: 'https://github.com/owner/repo/pull/99',
        authorLogin: 'ghost',
        authorAssociation: 'NONE',
        deliveryId: 'reconciliation-pr-owner/repo#99',
        action: 'opened',
      };

      await spec.run.execute(signal, 'repo-owner/repo#pr-99', { assignedCatId: null });

      assert.equal(deliveredMessages.length, 0);
    });
  });

  // ── Static properties ──

  it('has correct TaskSpec_P1 metadata', () => {
    const { opts } = createOpts();
    const spec = createRepoScanTaskSpec(opts);

    assert.equal(spec.id, 'repo-scan');
    assert.equal(spec.profile, 'poller');
    assert.deepEqual(spec.trigger, { type: 'interval', ms: 300_000 });
    assert.equal(spec.run.overlap, 'skip');
    assert.deepEqual(spec.state, { runLedger: 'sqlite' });
    assert.deepEqual(spec.outcome, { whenNoSignal: 'record' });
    assert.deepEqual(spec.actor, { role: 'repo-watcher', costTier: 'cheap' });
  });
});
