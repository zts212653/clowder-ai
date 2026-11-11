import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleLibraryList, handleLibraryRebuild } from '../dist/tools/library-lifecycle-tools.js';

// Create and dry-run moved to the owner library page on 2026-11-10; the remaining cat-side calls keep the local user.
test('each remaining library call carries the configured local user', async () => {
  const previousFetch = globalThis.fetch;
  const previousUser = process.env.CAT_CAFE_USER_ID;
  const requests = [];
  process.env.CAT_CAFE_USER_ID = ' owner ';
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ manifest: { id: 'domain:notes', status: 'archived' }, blocked: false }));
  };
  try {
    await handleLibraryList({});
    await handleLibraryRebuild({ collectionId: 'domain:notes' });
    assert.equal(requests.length, 2);
    for (const { init } of requests) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('x-cat-cafe-user'), 'owner');
      assert.equal(headers.has('origin'), false);
      assert.equal(headers.has('content-type'), init.body !== undefined, 'empty requests must not claim a JSON body');
    }
    delete process.env.CAT_CAFE_USER_ID;
    requests.length = 0;
    await handleLibraryRebuild({ collectionId: 'domain:notes' });
    assert.equal(new Headers(requests[0].init.headers).get('x-cat-cafe-user'), 'default-user');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUser === undefined) delete process.env.CAT_CAFE_USER_ID;
    else process.env.CAT_CAFE_USER_ID = previousUser;
  }
});
