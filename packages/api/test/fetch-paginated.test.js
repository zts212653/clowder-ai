/**
 * #798 + #805 review: fetchPaginated unit tests with mock execFile.
 *
 * Validates: multi-page collection, empty-page break, cursor>0
 * client-side filtering, single-page (< 100 items) termination.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { fetchPaginated } = await import('../dist/infrastructure/github/fetch-paginated.js');

/**
 * Build a mock execFileAsync that returns pre-defined pages.
 * Each page is an array of objects; the mock serializes them as NDJSON
 * (one JSON object per line, matching `--jq '.[]'` output).
 */
function mockExecFile(pages) {
  let callCount = 0;
  const calls = [];
  const fn = async (_file, args, _opts) => {
    calls.push(args);
    const pageData = pages[callCount++] ?? [];
    const stdout = pageData.map((item) => JSON.stringify(item)).join('\n');
    return { stdout: stdout || '' };
  };
  return { fn, calls: () => calls };
}

describe('fetchPaginated', () => {
  it('collects items from multiple pages until empty page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `c${i + 1}` }));
    const page2 = [
      { id: 101, body: 'c101' },
      { id: 102, body: 'c102' },
    ];
    const { fn } = mockExecFile([page1, page2]);

    const items = await fetchPaginated('/repos/o/r/issues/1/comments', { execFileAsync: fn });

    assert.equal(items.length, 102);
    assert.equal(items[0].id, 1);
    assert.equal(items[101].id, 102);
  });

  it('breaks on empty page after a full page (no more data)', async () => {
    // Page 1 has exactly 100 items → could be more → fetch page 2
    // Page 2 is empty → stop
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const { fn, calls } = mockExecFile([page1, []]);

    const items = await fetchPaginated('/repos/o/r/pulls/1/comments', { execFileAsync: fn });

    assert.equal(items.length, 100);
    // Should have made exactly 2 calls: page 1 (100 items) + page 2 (empty)
    assert.equal(calls().length, 2);
  });

  it('breaks when page has fewer than 100 items (last page)', async () => {
    const page1 = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { fn, calls } = mockExecFile([page1]);

    const items = await fetchPaginated('/repos/o/r/pulls/1/reviews', { execFileAsync: fn });

    assert.equal(items.length, 3);
    // Only 1 call — 3 items < 100 means last page
    assert.equal(calls().length, 1);
  });

  it('cursor>0 filters items with id <= sinceId', async () => {
    const page1 = [
      { id: 10, body: 'old' },
      { id: 20, body: 'old' },
      { id: 30, body: 'new' },
      { id: 40, body: 'new' },
    ];
    const { fn } = mockExecFile([page1]);

    const items = await fetchPaginated('/repos/o/r/issues/1/comments', { sinceId: 20, execFileAsync: fn });

    assert.equal(items.length, 2);
    assert.equal(items[0].id, 30);
    assert.equal(items[1].id, 40);
  });

  it('cursor=0 collects all items (no filtering)', async () => {
    const page1 = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { fn } = mockExecFile([page1]);

    const items = await fetchPaginated('/repos/o/r/issues/1/comments', { sinceId: 0, execFileAsync: fn });

    assert.equal(items.length, 3);
  });

  it('sinceId omitted collects all items', async () => {
    const page1 = [{ id: 5 }, { id: 10 }];
    const { fn } = mockExecFile([page1]);

    const items = await fetchPaginated('/repos/o/r/issues/1/comments', { execFileAsync: fn });

    assert.equal(items.length, 2);
  });

  it('passes correct endpoint with page number', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const page2 = [{ id: 101 }];
    const { fn, calls } = mockExecFile([page1, page2]);

    await fetchPaginated('/repos/o/r/issues/1/comments', { execFileAsync: fn });

    assert.ok(calls()[0][1].includes('per_page=100&page=1'));
    assert.ok(calls()[1][1].includes('per_page=100&page=2'));
  });

  it('items without id field treated as id=0 for cursor filtering', async () => {
    const page1 = [{ body: 'no-id' }, { id: 5, body: 'has-id' }];
    const { fn } = mockExecFile([page1]);

    const items = await fetchPaginated('/repos/o/r/issues/1/comments', { sinceId: 3, execFileAsync: fn });

    // { body: 'no-id' } has id=undefined → treated as 0 → 0 > 3 is false → filtered out
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 5);
  });
});
