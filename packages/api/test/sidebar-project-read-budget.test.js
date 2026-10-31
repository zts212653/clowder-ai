import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createThreadProjectPathResolver, mapThreadList } from '../dist/routes/thread-list-project-migration.js';

test('sidebar canonicalizes each distinct root once per request while preserving fresh next-request truth', async () => {
  let calls = 0;
  let path = '/canonical-a';
  const resolver = async () => {
    calls++;
    return path;
  };
  const resolve = createThreadProjectPathResolver(resolver);
  const threads = Array.from({ length: 10000 }, (_, i) => ({ id: `${i}`, projectPath: `/project-${i % 3}` }));
  const first = await mapThreadList(threads, (t) => resolve(t.projectPath));
  assert.equal(calls, 3);
  assert.equal(first.length, 10000);
  assert(first.every((v) => v === '/canonical-a'));
  path = '/canonical-b';
  assert.equal(await createThreadProjectPathResolver(resolver)('/project-0'), '/canonical-b');
  assert.equal(calls, 4);
});
