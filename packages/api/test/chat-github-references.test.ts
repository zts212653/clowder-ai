import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createChatGitHubReader } from '../src/domains/workspace/chat-github-references.js';

it('projects only actual PR counts, author, time and confirmed checks; an empty rollup is not success', async () => {
  let rollup: unknown[] = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const reader = () =>
    createChatGitHubReader(async (_command, args) => ({
      stdout: JSON.stringify(
        args[0] === 'api'
          ? {
              number: 12,
              html_url: 'https://github.com/owner/repo/pull/12',
              title: 'Real title',
              state: 'closed',
              merged_at: '2026-10-23T00:00:00Z',
              additions: 148,
              deletions: 96,
              changed_files: 10,
              user: { login: 'author' },
              updated_at: '2026-10-23T09:21:00Z',
              head: { sha: 'a'.repeat(40) },
            }
          : { headRefOid: 'a'.repeat(40), statusCheckRollup: rollup },
      ),
    }));
  const value = await reader()('https://github.com/owner/repo/pull/12');
  assert.equal(value?.additions, 148);
  assert.equal(value?.deletions, 96);
  assert.equal(value?.changedFiles, 10);
  assert.equal(value?.author, 'author');
  assert.equal(value?.updatedAt, '2026-10-23T09:21:00Z');
  assert.equal(value?.checks, 'checksPassed');
  rollup = [];
  assert.equal((await reader()('https://github.com/owner/repo/pull/12'))?.checks, undefined);
  rollup = [{ status: 'IN_PROGRESS' }];
  assert.equal((await reader()('https://github.com/owner/repo/pull/12'))?.checks, 'checksPending');
  rollup = [{ state: 'FAILURE' }];
  assert.equal((await reader()('https://github.com/owner/repo/pull/12'))?.checks, 'checksFailed');
});

it('reads exact GitHub objects with gh, shares in-flight work, caches current status and expires it', async () => {
  let calls = 0,
    time = 0;
  const read = createChatGitHubReader(
    async (command, args) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['api', 'repos/owner/repo/pulls/12']);
      calls++;
      return {
        stdout: JSON.stringify({
          number: 12,
          html_url: 'https://github.com/owner/repo/pull/12',
          title: 'Real title',
          state: 'closed',
          merged_at: '2026-10-23T00:00:00Z',
        }),
      };
    },
    () => time,
  );
  const [one, two] = await Promise.all([
    read('https://github.com/owner/repo/pull/12'),
    read('https://github.com/owner/repo/pull/12'),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(one, two);
  assert.equal(one?.state, 'merged');
  time = 60001;
  await read('https://github.com/owner/repo/pull/12');
  assert.equal(calls, 2);
});
it('keeps number only when GitHub cannot confirm title and state, without scraping other sites', async () => {
  let calls = 0;
  const read = createChatGitHubReader(async () => {
    calls++;
    throw new Error('offline');
  });
  assert.equal(await read('https://example.org/private'), null);
  assert.equal(await read('https://github.com.evil.test/owner/repo/pull/12'), null);
  const value = await read('https://github.com/owner/repo/issues/12');
  assert.equal(value?.number, 12);
  assert.equal(value?.state, undefined);
  assert.equal(value?.title, undefined);
  await read('https://github.com/owner/repo/issues/12');
  assert.equal(calls, 1);
});
it('bounds concurrent gh processes across batches', async () => {
  let active = 0,
    peak = 0;
  const read = createChatGitHubReader(async (_command, args) => {
    active++;
    peak = Math.max(active, peak);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const n = Number(args.at(-1)?.split('/').at(-1));
    return {
      stdout: JSON.stringify({
        number: n,
        html_url: `https://github.com/owner/repo/issues/${n}`,
        title: 'Issue',
        state: 'open',
      }),
    };
  });
  await Promise.all(Array.from({ length: 20 }, (_, i) => read(`https://github.com/owner/repo/issues/${i + 1}`)));
  assert.equal(peak, 4);
});
