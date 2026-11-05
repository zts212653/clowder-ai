import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { readArtifactPrTitles } from '../src/domains/cats/services/agents/routing/thread-artifact-pr-titles.js';

const pr: ThreadArtifactDTO = {
  type: 'pr',
  name: 'PR tracking: owner/repo#7',
  ref: 'owner/repo#7',
  catId: 'codex61-sol',
  createdAt: 17,
  sourceMessageId: null,
};

test('original PR metadata supplies the work title without changing identity, counts or other artifacts', async () => {
  const image: ThreadArtifactDTO = { ...pr, type: 'image', name: 'My image', ref: 'image:1' };
  const calls: string[] = [];
  const result = await readArtifactPrTitles([pr, image, { ...pr }], async (ref) => {
    calls.push(ref);
    return 'Make the waiting list readable';
  });
  assert.deepEqual(calls, ['owner/repo#7']);
  assert.deepEqual(result, [
    { ...pr, name: 'Make the waiting list readable' },
    image,
    { ...pr, name: 'Make the waiting list readable' },
  ]);
  assert.equal(pr.name, 'PR tracking: owner/repo#7');
});

test('missing metadata keeps the exact PR reference and never labels tracking prose as a title', async () => {
  const result = await readArtifactPrTitles([pr], async () => {
    throw new Error('offline');
  });
  assert.equal(result[0]?.name, 'owner/repo#7');
});

test('only formally parsed PR coordinates reach the reader', async () => {
  const calls: string[] = [];
  const malformed = { ...pr, ref: 'owner/repo#7; shell' };
  await readArtifactPrTitles([malformed], async (ref) => {
    calls.push(ref);
    return 'wrong';
  });
  assert.deepEqual(calls, []);
});

test('large catalogues keep every work while bounding title requests', async () => {
  const artifacts = Array.from({ length: 40 }, (_, i) => ({ ...pr, ref: `owner/repo#${i + 1}` }));
  let calls = 0;
  const result = await readArtifactPrTitles(artifacts, async () => {
    calls++;
    return 'Original title';
  });
  assert.equal(calls, 20);
  assert.equal(result.length, 40);
});
