import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { appendAuditEntry, readAuditLog } from '../../../dist/config/capabilities/capability-audit.js';

describe('capability audit log', () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cap-audit-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('appends entry and reads back', async () => {
    await appendAuditEntry(tmpDir, {
      timestamp: '2026-04-16T00:00:00Z',
      userId: 'test-user',
      action: 'install',
      capabilityId: 'test-mcp',
      before: null,
      after: { id: 'test-mcp', type: 'mcp', enabled: true, source: 'external' },
    });
    const entries = await readAuditLog(tmpDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'install');
    assert.equal(entries[0].capabilityId, 'test-mcp');
    assert.equal(entries[0].userId, 'test-user');
  });

  test('appends multiple entries in order', async () => {
    for (let i = 0; i < 5; i++) {
      await appendAuditEntry(tmpDir, {
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        userId: 'user',
        action: 'toggle',
        capabilityId: `mcp-${i}`,
        before: null,
        after: null,
      });
    }
    const entries = await readAuditLog(tmpDir);
    assert.equal(entries.length, 5);
    assert.equal(entries[0].capabilityId, 'mcp-0');
    assert.equal(entries[4].capabilityId, 'mcp-4');
  });

  test('readAuditLog returns empty array when no log exists', async () => {
    const entries = await readAuditLog(tmpDir);
    assert.deepEqual(entries, []);
  });

  test('readAuditLog respects limit (returns last N)', async () => {
    for (let i = 0; i < 10; i++) {
      await appendAuditEntry(tmpDir, {
        timestamp: new Date().toISOString(),
        userId: 'user',
        action: 'install',
        capabilityId: `mcp-${i}`,
        before: null,
        after: null,
      });
    }
    const entries = await readAuditLog(tmpDir, 3);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].capabilityId, 'mcp-7');
  });
});
