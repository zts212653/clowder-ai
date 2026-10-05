import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerGitHubScheduleFactories } from '../../dist/domains/plugin/github-schedule-factories.js';
import { ScheduleFactoryRegistry } from '../../dist/domains/plugin/ScheduleFactoryRegistry.js';

const log = { info() {}, warn() {}, error() {} };
for (const kind of ['repo-scan', 'repo-comment-poll'])
  test(`${kind} factory keeps cancellation and cursor ownership through repo fan-out`, async () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const controller = new AbortController();
    const calls = [];
    const writes = [];
    let cancelled = false;
    const fetched = async (repo, signal) => {
      calls.push({ repo, signal });
      if (!cancelled) {
        cancelled = true;
        controller.abort(new Error('stop repository poll'));
      }
      return [];
    };
    const deps = {
      log,
      repoAllowlist: ['owner/first', 'owner/second'],
      inboxCatId: 'codex-astra',
      defaultUserId: 'u',
      bindingStore: {
        async getByExternal() {
          return null;
        },
      },
      deliveryDeps: {},
      deliverFn: async () => {},
      invokeTrigger: { trigger() {} },
      reconciliationDedup: {
        async isNotified() {
          return false;
        },
        async isBaselineEstablished() {
          return true;
        },
        async markNotified() {
          writes.push('notified');
        },
        async markBaselineEstablished() {
          writes.push('baseline');
        },
      },
      fetchOpenPRs: (repo, signal) => fetched(repo, signal),
      fetchOpenIssues: (repo, signal) => fetched(repo, signal),
      eventLog: {
        async append() {
          writes.push('event');
          return { appended: true };
        },
      },
      projector: { async apply() {} },
      fetchRepoComments: (repo, _since, signal) => fetched(repo, signal),
      readRepoCommentCursor: async () => '2026-10-01T00:00:00Z',
      writeRepoCommentCursor: async () => {
        writes.push('cursor');
      },
    };
    const spec = registry.get(`github.${kind}`).createTaskSpec(`test-${kind}`, deps);
    await assert.rejects(
      spec.admission.gate({
        taskId: spec.id,
        tickCount: 1,
        lastRunAt: null,
        signal: controller.signal,
        deadlineMs: Date.now() + 30_000,
      }),
      /stop repository poll/,
    );
    assert.equal(calls.length, 1);
    assert(calls[0].signal?.aborted);
    assert.deepEqual(writes, []);
    await spec.admission.gate({
      taskId: spec.id,
      tickCount: 2,
      lastRunAt: null,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 30_000,
    });
    assert.equal(calls[1].repo, 'owner/second');
  });
