import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  createRepoActivityTemplate,
  repoActivityTemplate,
} from '../dist/infrastructure/scheduler/templates/repo-activity.js';

function params(repo = 'owner/repo', deliveryThreadId = 'th-1') {
  return { trigger: { type: 'interval', ms: 3600_000 }, params: { repo }, deliveryThreadId };
}
describe('repoActivityTemplate', () => {
  it('gate returns run:true with thread workItem when repo + deliveryThreadId set', async () => {
    const spec = repoActivityTemplate.createSpec('ra-1', params());
    const result = await spec.admission.gate({ taskId: 'ra-1', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].subjectKey, 'thread-th-1');
  });
  it('gate returns run:false when no repo param', async () => {
    const spec = repoActivityTemplate.createSpec('ra-2', { ...params(), params: {} });
    assert.equal((await spec.admission.gate({ taskId: 'ra-2', lastRunAt: null, tickCount: 1 })).run, false);
  });
  it('gate returns run:false when no deliveryThreadId', async () => {
    const spec = repoActivityTemplate.createSpec('ra-3', params('owner/repo', null));
    assert.equal((await spec.admission.gate({ taskId: 'ra-3', lastRunAt: null, tickCount: 1 })).run, false);
  });
  it('gate passes lastRunAt as temporal cursor in signal', async () => {
    const lastRunAt = Date.now() - 3600_000;
    const spec = repoActivityTemplate.createSpec('ra-4', params());
    const result = await spec.admission.gate({ taskId: 'ra-4', lastRunAt, tickCount: 2 });
    assert.equal(result.workItems[0].signal.since, new Date(lastRunAt).toISOString());
  });
  it('execute reads GitHub through the shared gh transport and delivers formatted issues/PRs', async () => {
    const entries = [
      {
        number: 42,
        title: 'Fix race condition',
        html_url: 'https://github.com/owner/repo/issues/42',
        user: { login: 'alice' },
      },
      {
        number: 43,
        title: 'Add caching layer',
        html_url: 'https://github.com/owner/repo/pull/43',
        pull_request: { url: 'x' },
        user: { login: 'bob' },
      },
    ];
    const execute = mock.fn(async () => ({ stdout: JSON.stringify(entries) }));
    const spec = createRepoActivityTemplate({ execFileAsync: execute }).createSpec('ra-5', params());
    const deliver = mock.fn(async () => 'msg-1');
    await spec.run.execute({ repo: 'owner/repo', since: '2026-03-27T00:00:00Z' }, 'thread-th-1', {
      assignedCatId: 'opus',
      deliver,
    });
    assert.equal(execute.mock.calls.length, 1);
    const [file, args] = execute.mock.calls[0].arguments;
    assert.equal(file, 'gh');
    assert.equal(args[0], 'api');
    assert(args[1].startsWith('/repos/owner/repo/issues?'));
    assert(args[1].includes('since='));
    const delivered = deliver.mock.calls[0].arguments[0];
    assert(delivered.content.includes('Issue #42'));
    assert(delivered.content.includes('Fix race condition'));
    assert(delivered.content.includes('PR #43'));
    assert(delivered.content.includes('Add caching layer'));
    assert.equal(delivered.threadId, 'th-1');
  });
  it('execute uses injected GitHub token resolver without mutating process.env', async () => {
    const previous = process.env.GITHUB_TOKEN;
    let childEnv;
    const spec = createRepoActivityTemplate({
      getGitHubToken: () => 'plugin-config-token',
      execFileAsync: async (_file, _args, options) => {
        childEnv = options.env;
        return { stdout: '[]' };
      },
    }).createSpec('ra-token', params());
    await spec.run.execute({ repo: 'owner/repo', since: null }, 'thread-th-1', {
      assignedCatId: 'opus',
      deliver: async () => 'm',
    });
    assert.equal(childEnv.GITHUB_TOKEN, 'plugin-config-token');
    assert.equal(process.env.GITHUB_TOKEN, previous);
  });
  it('execute delivers no-activity message when GitHub returns empty', async () => {
    const deliver = mock.fn(async () => 'msg-2');
    const spec = createRepoActivityTemplate({ execFileAsync: async () => ({ stdout: '[]' }) }).createSpec(
      'ra-empty',
      params(),
    );
    await spec.run.execute({ repo: 'owner/repo', since: null }, 'thread-th-1', { assignedCatId: 'opus', deliver });
    assert(deliver.mock.calls[0].arguments[0].content.toLowerCase().includes('no new'));
  });
  it('execute throws when deliver is not available', async () => {
    const spec = repoActivityTemplate.createSpec('ra-6', params());
    await assert.rejects(
      spec.run.execute({ repo: 'owner/repo', since: null }, 'thread-th-1', { assignedCatId: null }),
      /deliver not available/,
    );
  });
});
