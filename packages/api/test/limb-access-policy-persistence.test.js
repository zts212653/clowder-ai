import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { SqliteLimbPersistence } = await import('../dist/domains/limb/SqliteLimbPersistence.js');
const { LimbAccessPolicy } = await import('../dist/domains/limb/LimbAccessPolicy.js');

describe('LimbAccessPolicy with persistence', () => {
  let tempDir;
  let dbPath;
  let persistence;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'limb-policy-'));
    dbPath = join(tempDir, 'limb.sqlite');
    persistence = new SqliteLimbPersistence(dbPath);
    persistence.initialize();
  });

  afterEach(() => {
    persistence.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('round-trips access policy across instances', () => {
    const policy1 = new LimbAccessPolicy(persistence);
    policy1.setPolicy({ catId: 'cat-1', nodeId: 'node-1', capability: 'shell', authLevel: 'leased' });

    const policy2 = new LimbAccessPolicy(persistence);
    policy2.initialize();
    assert.equal(policy2.check('cat-1', 'node-1', 'shell'), 'leased');
  });

  it('works without persistence (backward compat)', () => {
    const policy = new LimbAccessPolicy();
    policy.setPolicy({ catId: 'cat-2', nodeId: 'node-2', capability: 'fs', authLevel: 'gated' });
    assert.equal(policy.check('cat-2', 'node-2', 'fs'), 'gated');
  });
});
