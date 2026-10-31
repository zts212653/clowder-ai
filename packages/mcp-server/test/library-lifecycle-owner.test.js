import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleLibraryArchive,
  handleLibraryCreate,
  handleLibraryDryRun,
  handleLibraryRebuild,
} from '../dist/tools/library-lifecycle-tools.js';

test('each library writer carries the configured local user, including the post-create rebuild', async () => {
  const previousFetch = globalThis.fetch;
  const previousUser = process.env.CAT_CAFE_USER_ID;
  const requests = [];
  process.env.CAT_CAFE_USER_ID = ' owner ';
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ manifest: { id: 'domain:notes', status: 'archived' }, blocked: false }));
  };
  try {
    await handleLibraryDryRun({ root: '/isolated/docs' });
    await handleLibraryCreate({ kind: 'domain', name: 'notes', displayName: 'Notes' });
    await handleLibraryRebuild({ collectionId: 'domain:notes' });
    await handleLibraryArchive({ collectionId: 'domain:notes' });
    assert.equal(requests.length, 5);
    for (const { init } of requests) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('x-cat-cafe-user'), 'owner');
      assert.equal(headers.has('origin'), false);
      assert.equal(headers.has('content-type'), init.body !== undefined, 'empty requests must not claim a JSON body');
    }
    delete process.env.CAT_CAFE_USER_ID;
    requests.length = 0;
    await handleLibraryArchive({ collectionId: 'domain:notes' });
    assert.equal(new Headers(requests[0].init.headers).get('x-cat-cafe-user'), 'default-user');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUser === undefined) delete process.env.CAT_CAFE_USER_ID;
    else process.env.CAT_CAFE_USER_ID = previousUser;
  }
});
