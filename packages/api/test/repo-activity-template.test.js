import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  createRepoActivityTemplate,
  repoActivityTemplate,
} from '../dist/infrastructure/scheduler/templates/repo-activity.js';

describe('repoActivityTemplate', () => {
  it('gate returns run:true with thread workItem when repo + deliveryThreadId set', async () => {
    const spec = repoActivityTemplate.createSpec('ra-1', {
      trigger: { type: 'interval', ms: 3600_000 },
      params: { repo: 'anthropics/claude-code' },
      deliveryThreadId: 'th-1',
    });
    const result = await spec.admission.gate({ taskId: 'ra-1', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].subjectKey, 'thread-th-1');
  });

  it('gate returns run:false when no repo param', async () => {
    const spec = repoActivityTemplate.createSpec('ra-2', {
      trigger: { type: 'interval', ms: 3600_000 },
      params: {},
      deliveryThreadId: 'th-1',
    });
    const result = await spec.admission.gate({ taskId: 'ra-2', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('gate returns run:false when no deliveryThreadId', async () => {
    const spec = repoActivityTemplate.createSpec('ra-3', {
      trigger: { type: 'interval', ms: 3600_000 },
      params: { repo: 'owner/repo' },
      deliveryThreadId: null,
    });
    const result = await spec.admission.gate({ taskId: 'ra-3', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('gate passes lastRunAt as temporal cursor in signal', async () => {
    const lastRunAt = Date.now() - 3600_000;
    const spec = repoActivityTemplate.createSpec('ra-4', {
      trigger: { type: 'interval', ms: 3600_000 },
      params: { repo: 'owner/repo' },
      deliveryThreadId: 'th-1',
    });
    const result = await spec.admission.gate({ taskId: 'ra-4', lastRunAt, tickCount: 2 });
    assert.equal(result.run, true);
    assert.ok(result.workItems[0].signal.since);
  });

  it('execute calls GitHub API and delivers formatted issues/PRs', async () => {
    const ghResponse = [
      {
        number: 42,
        title: 'Fix race condition',
        html_url: 'https://github.com/owner/repo/issues/42',
        pull_request: undefined,
        user: { login: 'alice' },
      },
      {
        number: 43,
        title: 'Add caching layer',
        html_url: 'https://github.com/owner/repo/pull/43',
        pull_request: { url: '...' },
        user: { login: 'bob' },
      },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ghResponse,
    }));
    try {
      const deliverMock = mock.fn(async () => 'msg-1');
      const spec = repoActivityTemplate.createSpec('ra-5', {
        trigger: { type: 'interval', ms: 3600_000 },
        params: { repo: 'owner/repo' },
        deliveryThreadId: 'th-1',
      });
      const signal = { repo: 'owner/repo', since: '2026-03-27T00:00:00Z' };
      await spec.run.execute(signal, 'thread-th-1', {
        assignedCatId: 'opus',
        deliver: deliverMock,
      });
      // Must have called GitHub API
      assert.equal(globalThis.fetch.mock.calls.length, 1);
      const fetchUrl = globalThis.fetch.mock.calls[0].arguments[0];
      assert.ok(fetchUrl.includes('api.github.com/repos/owner/repo'));
      assert.ok(fetchUrl.includes('since='));
      // Delivered content must include actual issue/PR data
      const delivered = deliverMock.mock.calls[0].arguments[0];
      assert.ok(delivered.content.includes('#42'));
      assert.ok(delivered.content.includes('Fix race condition'));
      assert.ok(delivered.content.includes('#43'));
      assert.ok(delivered.content.includes('Add caching layer'));
      assert.equal(delivered.threadId, 'th-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('execute uses injected GitHub token resolver without mutating process.env', async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const originalFetch = globalThis.fetch;
    let capturedHeaders;
    globalThis.fetch = mock.fn(async (_url, options) => {
      capturedHeaders = options?.headers;
      return {
        ok: true,
        json: async () => [],
      };
    });
    try {
      const deliverMock = mock.fn(async () => 'msg-token');
      const template = createRepoActivityTemplate({ getGitHubToken: () => 'plugin-config-token' });
      const spec = template.createSpec('ra-token', {
        trigger: { type: 'interval', ms: 3600_000 },
        params: { repo: 'owner/private-repo' },
        deliveryThreadId: 'th-token',
      });

      await spec.run.execute({ repo: 'owner/private-repo', since: null }, 'thread-th-token', {
        assignedCatId: 'opus',
        deliver: deliverMock,
      });

      assert.equal(capturedHeaders?.Authorization, 'Bearer plugin-config-token');
      assert.equal(process.env.GITHUB_TOKEN, undefined, 'resolver must not write into process.env');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('execute delivers no-activity message when GitHub returns empty', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({ ok: true, json: async () => [] }));
    try {
      const deliverMock = mock.fn(async () => 'msg-2');
      const spec = repoActivityTemplate.createSpec('ra-5b', {
        trigger: { type: 'interval', ms: 3600_000 },
        params: { repo: 'owner/repo' },
        deliveryThreadId: 'th-1',
      });
      await spec.run.execute({ repo: 'owner/repo', since: '2026-03-27T00:00:00Z' }, 'thread-th-1', {
        assignedCatId: 'opus',
        deliver: deliverMock,
      });
      const delivered = deliverMock.mock.calls[0].arguments[0];
      assert.ok(delivered.content.toLowerCase().includes('no new'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('execute throws when deliver is not available', async () => {
    const spec = repoActivityTemplate.createSpec('ra-6', {
      trigger: { type: 'interval', ms: 3600_000 },
      params: { repo: 'owner/repo' },
      deliveryThreadId: 'th-1',
    });
    await assert.rejects(
      () => spec.run.execute({ repo: 'owner/repo', since: null }, 'thread-th-1', { assignedCatId: null }),
      /deliver not available/,
    );
  });
});
