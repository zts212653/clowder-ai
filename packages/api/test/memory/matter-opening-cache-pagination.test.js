import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actor, failCatalog, fixture, items, read } from '../helpers/matter-opening-cache-fixture.js';

const directory = (text) => JSON.parse(text.split('\n').find((line) => line.startsWith('{')));

for (const removed of ['first', 'last']) {
  test(`cache fallback keeps a usable continuation after revoking ${removed} cached entries`, async (t) => {
    const f = await fixture(t);
    const pages = [];
    for (let i = 0; i < 13; i++) pages.push(await f.create(`page ${i}`, 'summary'));
    const warm = directory(await read(f.service));
    const visible = warm.groups.flatMap((group) => group.items);
    assert.equal(visible.length, 12);
    assert.ok(warm.nextCursor);
    const visibleIds = new Set(visible.map((item) => item.matterId));
    const next = pages.find((page) => !visibleIds.has(page.matterId));
    // Choose from the actual snapshot, never from creation order or millisecond timestamps.
    const revokedIds = [visible[removed === 'first' ? 0 : 11].matterId];
    for (const page of pages) {
      if (revokedIds.includes(page.matterId)) page.message.recall = { recalledAt: Date.now() };
    }
    const catalog = f.service.catalog.bind(f.service);
    failCatalog(t, f.service);
    const text = await read(f.service);
    const stale = directory(text);
    assert.equal(items(text).length, 11);
    for (const id of revokedIds) assert.ok(!text.includes(id), 'never expose a revoked coordinate');
    assert.ok(stale.nextCursor, 'a known later page must remain reachable');
    const key = JSON.parse(Buffer.from(stale.nextCursor, 'base64url').toString()).after;
    assert.equal(key.matterId, items(text).at(-1).matterId);
    const continued = await catalog(actor, { threadId: 'here', cursor: stale.nextCursor });
    assert.ok(continued.items.some((item) => item.matterId === next.matterId));
    assert.ok(continued.items.every((item) => !revokedIds.includes(item.matterId)));
  });
}

for (const [count, change] of [
  [3, 'edit'],
  [14, 'edit'],
  [13, 'recall'],
]) {
  test(`${count} pages with every cached entry ${change}ed cannot masquerade as a successful empty directory`, async (t) => {
    const f = await fixture(t);
    const pages = [];
    for (let i = 0; i < count; i++) pages.push(await f.create(`page ${i}`, 'old summary'));
    const warm = items(await read(f.service));
    assert.equal(warm.length, Math.min(12, count));
    const cachedIds = new Set(warm.map((item) => item.matterId));
    for (const page of pages.filter((page) => cachedIds.has(page.matterId))) {
      if (change === 'recall') page.message.recall = { recalledAt: Date.now() };
      else {
        await f.service.write(actor, {
          operation: 'edit',
          requestId: `edit-${page.matterId}`,
          matterId: page.matterId,
          expectedRevision: 1,
          title: 'updated title',
          description: 'new summary',
        });
        assert.equal((await f.service.read(actor, page.matterId)).matter.status, 'active');
      }
    }
    if (change === 'edit')
      assert.equal((await f.service.catalog(actor, { threadId: 'here', limit: 30 })).items.length, count);
    failCatalog(t, f.service);
    const text = await read(f.service);
    assert.match(text, /当前目录不可用/);
    assert.doesNotMatch(text, /缓存目录/);
    for (const id of cachedIds) assert.ok(!text.includes(id));
  });
}
