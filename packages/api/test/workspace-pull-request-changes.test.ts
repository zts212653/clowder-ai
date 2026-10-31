import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseSha,
  comparison,
  file,
  fixture,
  headSha,
  mergeBaseSha,
  metadata,
} from './helpers/workspace-pull-request-changes-fixture.js';

test('requires a direct human identity before root or GitHub reads', async () => {
  const f = await fixture();
  try {
    for (const headers of [{}, { 'x-cat-cafe-user': 'operator', 'x-invocation-id': 'cat' }]) {
      assert.equal((await f.read(headers)).statusCode, 401);
    }
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('reads the precise PR base and frozen comparison, accepting a fork head without substituting local diff', async () => {
  const f = await fixture();
  try {
    const response = await f.read();
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.equal(data.target.repoFullName, 'owner/repo');
    assert.equal(data.target.prNumber, 7);
    assert.deepEqual(data.comparison, { baseSha, headSha, mergeBaseSha });
    assert.equal(data.completeness, 'complete');
    assert.match(data.diff, /\+pull-request/);
    assert.equal(data.changedFiles[0].path, 'src/main.ts');
    assert.equal(f.calls.length, 3);
    assert.ok(
      f.calls.every(({ args }) => !args.some((arg) => ['fetch', 'checkout', 'stash', 'diff', 'status'].includes(arg))),
    );
  } finally {
    await f.close();
  }
});

test('rejects malformed codec/version/number instead of falling back to local Changes', async () => {
  const f = await fixture();
  try {
    for (const key of [
      'bad%',
      encodeURIComponent(JSON.stringify(['github-pr', 2, 'owner/repo', 7, 'registered-root', null])),
      encodeURIComponent(JSON.stringify(['github-pr', 1, 'owner/repo', 0, 'registered-root', null])),
    ]) {
      assert.equal((await f.read(undefined, key)).statusCode, 400);
    }
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('rejects an unregistered root without contacting GitHub', async () => {
  const f = await fixture({ missingRoot: true });
  try {
    assert.equal((await f.read()).statusCode, 404);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('requires the registered root repository and PR base repository to match the exact target', async () => {
  for (const options of [
    { remote: 'https://github.com/another/repo.git' },
    { pull: { ...metadata(), base: { sha: baseSha, repo: { full_name: 'another/repo' } } } },
  ]) {
    const f = await fixture(options);
    try {
      assert.equal((await f.read()).statusCode, 409);
      assert.ok(f.calls.length < 3);
    } finally {
      await f.close();
    }
  }
});

test('does not trust a response for another PR, invalid SHA or comparison base', async () => {
  for (const options of [
    { pull: { ...metadata(), number: 8 } },
    { pull: { ...metadata(), head: { sha: 'HEAD', repo: { full_name: 'fork/repo' } } } },
    { compare: { ...comparison(), base_commit: { sha: headSha } } },
  ]) {
    const f = await fixture(options);
    try {
      assert.equal((await f.read()).statusCode, 503);
    } finally {
      await f.close();
    }
  }
});

test('filters both renamed paths and their hunks with the existing workspace denylist', async () => {
  const files = [
    file(),
    file('safe.txt', {
      status: 'renamed',
      previous_filename: 'secrets/token.txt',
      patch: '@@ -1 +1 @@\n-secret\n+LEAK',
    }),
    file('.env.local', { patch: '@@ -1 +1 @@\n-secret\n+LEAK' }),
    file('secrets/target', { previous_filename: 'old.txt', status: 'renamed' }),
  ];
  const f = await fixture({ pull: { ...metadata(), changed_files: 4 }, compare: comparison(files) });
  try {
    const response = await f.read();
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.deepEqual(
      data.changedFiles.map((item: { path: string }) => item.path),
      ['src/main.ts'],
    );
    assert.doesNotMatch(data.diff, /LEAK|secret|\.env/);
    assert.equal(data.completeness, 'partial');
    assert.ok(data.omissions.includes('filtered_paths'));
  } finally {
    await f.close();
  }
});

test('reports missing binary patches and the first-page file limit honestly', async () => {
  const f = await fixture({
    pull: { ...metadata(), changed_files: 301 },
    compare: comparison([file('asset.png', { patch: undefined })]),
  });
  try {
    const response = await f.read();
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.equal(data.changedFiles.length, 1);
    assert.equal(data.changedFiles[0].patchState, 'unavailable');
    assert.equal(data.diff, '');
    assert.equal(data.completeness, 'partial');
    assert.ok(data.omissions.includes('file_limit'));
    assert.ok(data.omissions.includes('missing_patch'));
  } finally {
    await f.close();
  }
});

test('rejects unsafe paths and unexpected patch structure without exposing their content', async () => {
  for (const item of [
    file('../outside'),
    file('bad\nname'),
    file('safe.ts', { patch: 'diff --git a/.env b/.env\n+LEAK' }),
  ]) {
    const f = await fixture({ compare: comparison([item]) });
    try {
      const response = await f.read();
      assert.equal(response.statusCode, 503);
      assert.doesNotMatch(response.body, /LEAK|outside|bad/);
    } finally {
      await f.close();
    }
  }
});

test('classifies authentication, permission, rate limit, not-found and timeout without local fallback', async () => {
  for (const [stderr, status] of [
    ['gh: Bad credentials (HTTP 401)', 401],
    ['gh: Forbidden (HTTP 403)', 403],
    ['gh: rate limit exceeded (HTTP 429)', 429],
    ['gh: Not Found (HTTP 404)', 404],
    ['timeout', 503],
  ] as const) {
    const f = await fixture({ failure: Object.assign(new Error('process failed'), { stderr, code: 1 }) });
    try {
      assert.equal((await f.read()).statusCode, status);
      assert.equal(f.calls.length, 2);
    } finally {
      await f.close();
    }
  }
});

test('canonicalizes the GitHub base repository case without changing the target identity', async () => {
  const f = await fixture({ pull: { ...metadata(), base: { sha: baseSha, repo: { full_name: 'Owner/Repo' } } } });
  try {
    const response = await f.read();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().target.repoFullName, 'owner/repo');
  } finally {
    await f.close();
  }
});

test('retains a truncated hunk as unavailable patch rather than claiming a complete diff', async () => {
  const f = await fixture({
    compare: comparison([file('src/main.ts', { patch: '@@ -1,2 +1,2 @@\n-only-one\n+only-one' })]),
  });
  try {
    const response = await f.read();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().completeness, 'partial');
    assert.equal(response.json().changedFiles[0].patchState, 'unavailable');
    assert.equal(response.json().diff, '');
  } finally {
    await f.close();
  }
});
