import assert from 'node:assert/strict';
import { mkdtemp, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventAuditLog } from '../dist/domains/cats/services/orchestration/EventAuditLog.js';

test('diagnostics reflect the writer directory captured at construction, not a later environment edit', async () => {
  const previous = process.env.AUDIT_LOG_DIR;
  const root = await mkdtemp(join(tmpdir(), 'audit-binding-'));
  try {
    process.env.AUDIT_LOG_DIR = join(root, 'original');
    const log = new EventAuditLog();
    process.env.AUDIT_LOG_DIR = join(root, 'changed');
    assert.equal(log.getDirectory(), join(root, 'original'));
    await log.append({ type: 'binding-test', data: {} });
    assert.deepEqual(
      (await log.readByDate(new Date())).map((event) => event.type),
      ['binding-test'],
    );
  } finally {
    if (previous === undefined) delete process.env.AUDIT_LOG_DIR;
    else process.env.AUDIT_LOG_DIR = previous;
  }
});

test('after initialized audit directory disappears, a failed append can recover on the next explicit save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audit-retry-'));
  const path = join(root, 'logs');
  const log = new EventAuditLog({ auditDir: path });
  await log.append({ type: 'before', data: {} });
  await rename(path, join(root, 'retained-logs'));
  // Replace the parent temporarily with a file so this append really fails.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, 'blocked');
  await assert.rejects(log.append({ type: 'failed', data: {} }));
  await rename(path, join(root, 'retained-blocker'));
  await log.append({ type: 'recovered', data: {} });
  assert.deepEqual(
    (await log.readByDate(new Date())).map((event) => event.type),
    ['recovered'],
  );
});
