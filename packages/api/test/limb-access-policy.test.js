import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LimbAccessPolicy } from '../dist/domains/limb/LimbAccessPolicy.js';

describe('LimbAccessPolicy', () => {
  it('getEffectiveAuth returns capability default when no policy set', () => {
    const policy = new LimbAccessPolicy();
    const cap = { cap: 'camera', commands: ['camera.snap'], authLevel: 'leased' };
    assert.equal(policy.getEffectiveAuth('opus', 'iphone-1', cap), 'leased');
  });

  it('getEffectiveAuth returns overridden authLevel from policy', () => {
    const policy = new LimbAccessPolicy();
    policy.setPolicy({ catId: 'opus', nodeId: 'iphone-1', capability: 'camera', authLevel: 'free' });
    const cap = { cap: 'camera', commands: ['camera.snap'], authLevel: 'leased' };
    assert.equal(policy.getEffectiveAuth('opus', 'iphone-1', cap), 'free');
  });

  it('check returns null when no policy set', () => {
    const policy = new LimbAccessPolicy();
    assert.equal(policy.check('opus', 'iphone-1', 'camera'), null);
  });

  it('check returns authLevel when policy set', () => {
    const policy = new LimbAccessPolicy();
    policy.setPolicy({ catId: 'opus', nodeId: 'iphone-1', capability: 'camera', authLevel: 'gated' });
    assert.equal(policy.check('opus', 'iphone-1', 'camera'), 'gated');
  });

  it('setPolicy overrides existing policy', () => {
    const policy = new LimbAccessPolicy();
    policy.setPolicy({ catId: 'opus', nodeId: 'iphone-1', capability: 'camera', authLevel: 'free' });
    assert.equal(policy.check('opus', 'iphone-1', 'camera'), 'free');

    policy.setPolicy({ catId: 'opus', nodeId: 'iphone-1', capability: 'camera', authLevel: 'gated' });
    assert.equal(policy.check('opus', 'iphone-1', 'camera'), 'gated');
  });

  it('different cats have independent policies', () => {
    const policy = new LimbAccessPolicy();
    policy.setPolicy({ catId: 'opus', nodeId: 'iphone-1', capability: 'camera', authLevel: 'free' });
    policy.setPolicy({ catId: 'codex', nodeId: 'iphone-1', capability: 'camera', authLevel: 'gated' });

    assert.equal(policy.check('opus', 'iphone-1', 'camera'), 'free');
    assert.equal(policy.check('codex', 'iphone-1', 'camera'), 'gated');
  });
});
