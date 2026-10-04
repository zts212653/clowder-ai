import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

test('abort kills active native SQL and queued cancellation does not start another scan', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memory-cancel-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  // FTS matches every row; each source body is large enough that this is a real
  // SQLite scan, not an artificial sleep in a mock service.
  const db = store.getDb();
  const insert = db.prepare(
    `INSERT INTO evidence_docs (anchor,kind,status,title,summary,updated_at) VALUES (?,'feature','active','common',?,'2026-01-01')`,
  );
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) insert.run(`F${i}`, 'common filler '.repeat(1000));
  })();
  const controller = new AbortController();
  const events = channel('cat-cafe.memory-process');
  let pid = 0;
  let cancelAt = 0;
  const subscriber = (message) => {
    const event = message;
    if (event.kind !== 'search' || pid) return;
    pid = event.pid;
    setTimeout(() => {
      cancelAt = performance.now();
      controller.abort(new DOMException('client left', 'AbortError'));
    }, 25);
  };
  events.subscribe(subscriber);
  t.after(() => events.unsubscribe(subscriber));
  await assert.rejects(store.search('common', { signal: controller.signal }), { name: 'AbortError' });
  assert.ok(pid > 0);
  assert.ok(performance.now() - cancelAt < 250, 'cancellation waited for native SQL to finish');
  let exited = false;
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      exited = true;
      break;
    }
    await pause(10);
  }
  assert.ok(exited, 'canceled SQLite child must exit, not continue burning CPU');
  const start = performance.now();
  await assert.rejects(store.search('common', { deadlineAt: Date.now() - 1 }), { name: 'TimeoutError' });
  assert.ok(performance.now() - start < 100);
  assert.deepEqual(await store.search('definitely-absent', { deadlineAt: Date.now() + 10_000 }), []);
});
