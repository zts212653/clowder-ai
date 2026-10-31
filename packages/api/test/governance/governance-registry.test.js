import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('lists all 1001 project health results with one fresh registry read', async (t) => {
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      ...makeMeta(index % 2 ? 'old' : 'current'),
      projectPath: `/projects/project-${index}`,
      syncedAt: index,
    }));
    await mkdir(join(tmpDir, '.cat-cafe'));
    await writeFile(join(tmpDir, '.cat-cafe/governance-registry.json'), JSON.stringify({ entries }));
    const read = t.mock.method(registry, 'read');
    const health = await registry.listHealth('current');
    assert.equal(read.mock.callCount(), 1);
    assert.deepEqual(
      health,
      entries.map((entry, index) => ({
        projectPath: entry.projectPath,
        status: index % 2 ? 'stale' : 'healthy',
        packVersion: entry.packVersion,
        lastSyncedAt: entry.syncedAt,
        findings: [],
      })),
    );
  });

  it('refreshes snapshots and single-project checks after registration changes', async () => {
    await registry.register('/a', makeMeta('1.0.0'));
    const first = await registry.listHealth('1.0.0');
    await registry.register('/a', makeMeta('2.0.0'));
    await registry.register('/b', makeMeta('1.0.0'));
    assert.equal((await registry.checkHealth('/a', '1.0.0')).status, 'stale');
    assert.deepEqual(
      (await registry.listHealth('1.0.0')).map((entry) => entry.status),
      ['stale', 'healthy'],
    );
    assert.equal(first[0].status, 'healthy', 'the previous snapshot remains unchanged');
    assert.equal((await registry.checkHealth('/b', '1.0.0')).status, 'healthy');
  });

  it('uses the current governance version when listing health by default', async () => {
    const { GOVERNANCE_PACK_VERSION } = await import('../../dist/config/governance/governance-pack.js');
    await registry.register('/a', makeMeta(GOVERNANCE_PACK_VERSION));
    assert.equal((await registry.listHealth())[0].status, 'healthy');
    assert.deepEqual((await registry.listHealth())[0], await registry.checkHealth('/a'));
  });

  it('keeps first-match health results for legacy duplicate entries', async () => {
    await mkdir(join(tmpDir, '.cat-cafe'));
    await writeFile(
      join(tmpDir, '.cat-cafe/governance-registry.json'),
      JSON.stringify({
        entries: [
          { ...makeMeta('1.0.0'), projectPath: '/a' },
          { ...makeMeta('2.0.0'), projectPath: '/a' },
        ],
      }),
    );
    const health = await registry.listHealth('1.0.0');
    assert.equal(health.length, 2);
    assert.deepEqual(health, [await registry.checkHealth('/a', '1.0.0'), await registry.checkHealth('/a', '1.0.0')]);
  });

  it('retains empty and never-synced results for missing or unreadable registries', async () => {
    assert.deepEqual(await registry.listHealth(), []);
    await mkdir(join(tmpDir, '.cat-cafe'));
    for (const raw of ['malformed json', '{"entries":{}}']) {
      await writeFile(join(tmpDir, '.cat-cafe/governance-registry.json'), raw);
      assert.deepEqual(await registry.listHealth(), []);
      assert.deepEqual(await registry.checkHealth('/unknown'), {
        projectPath: '/unknown',
        status: 'never-synced',
        packVersion: null,
        lastSyncedAt: null,
        findings: [],
      });
    }
  });
});
