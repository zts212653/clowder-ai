import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GovernanceRegistry } from '../../dist/config/governance/governance-registry.js';

describe('GovernanceRegistry', () => {
  let tmpDir;
  let registry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gov-registry-'));
    registry = new GovernanceRegistry(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const makeMeta = (version = '1.0.0') => ({
    packVersion: version,
    checksum: 'abc123def456',
    syncedAt: Date.now(),
    confirmedByUser: true,
  });

  it('registers a new project', async () => {
    await registry.register('/path/to/project', makeMeta());
    const entry = await registry.get('/path/to/project');
    assert.ok(entry);
    assert.strictEqual(entry.packVersion, '1.0.0');
    assert.strictEqual(entry.confirmedByUser, true);
  });

  it('returns undefined for unknown project', async () => {
    const entry = await registry.get('/nonexistent');
    assert.strictEqual(entry, undefined);
  });

  it('updates existing project on re-register', async () => {
    await registry.register('/a', makeMeta('1.0.0'));
    await registry.register('/a', makeMeta('2.0.0'));
    const entry = await registry.get('/a');
    assert.strictEqual(entry.packVersion, '2.0.0');
    const all = await registry.listAll();
    assert.strictEqual(all.length, 1);
  });

  it('lists all registered projects', async () => {
    await registry.register('/a', makeMeta());
    await registry.register('/b', makeMeta());
    await registry.register('/c', makeMeta());
    const all = await registry.listAll();
    assert.strictEqual(all.length, 3);
  });

  it('checkHealth returns never-synced for unknown project', async () => {
    const health = await registry.checkHealth('/unknown');
    assert.strictEqual(health.status, 'never-synced');
    assert.strictEqual(health.packVersion, null);
  });

  it('checkHealth returns healthy for matching version', async () => {
    await registry.register('/a', makeMeta('1.0.0'));
    const health = await registry.checkHealth('/a', '1.0.0');
    assert.strictEqual(health.status, 'healthy');
  });

  it('checkHealth returns stale for version mismatch', async () => {
    await registry.register('/a', makeMeta('0.9.0'));
    const health = await registry.checkHealth('/a', '1.0.0');
    assert.strictEqual(health.status, 'stale');
  });

  it('empty registry returns empty list', async () => {
    const all = await registry.listAll();
    assert.strictEqual(all.length, 0);
  });

  it('lookup works with Windows-style backslash paths', async () => {
    await registry.register('C:\\Users\\Dev\\project', makeMeta('1.0.0'));
    const entry = await registry.get('C:\\Users\\Dev\\project');
    assert.ok(entry, 'should find entry with backslash path');
    assert.strictEqual(entry.packVersion, '1.0.0');
    // Case-insensitive matching is tested in project-path.test.js via pathsEqual(a, b, 'win32')
  });

  it('re-register with same path updates entry instead of duplicating', async () => {
    await registry.register('/projects/alpha', makeMeta('1.0.0'));
    await registry.register('/projects/alpha', makeMeta('2.0.0'));
    const all = await registry.listAll();
    const matches = all.filter((e) => e.projectPath === '/projects/alpha');
    assert.strictEqual(matches.length, 1, 'should have exactly 1 entry, not duplicate');
    assert.strictEqual(matches[0].packVersion, '2.0.0');
  });
});
