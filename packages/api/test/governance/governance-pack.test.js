import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computePackChecksum,
  GOVERNANCE_PACK_VERSION,
  getGovernanceManagedBlock,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
} from '../../dist/config/governance/governance-pack.js';

describe('governance-pack', () => {
  it('managed block has start/end markers', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes(MANAGED_BLOCK_START));
    assert.ok(block.includes(MANAGED_BLOCK_END));
  });

  it('managed block includes hard constraints', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('3003'));
    assert.ok(block.includes('6399'));
    assert.ok(block.includes('self-review'));
    assert.ok(block.includes('Identity is constant'));
  });

  it('managed block includes methodology intro', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('frontmatter'));
    assert.ok(block.includes('Feature lifecycle'));
    assert.ok(block.includes('SOP'));
  });

  it('includes pack version', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes(GOVERNANCE_PACK_VERSION));
  });

  it('includes provider name', () => {
    assert.ok(getGovernanceManagedBlock('claude').includes('claude'));
    assert.ok(getGovernanceManagedBlock('codex').includes('codex'));
    assert.ok(getGovernanceManagedBlock('gemini').includes('gemini'));
  });

  it('pack version is semver', () => {
    assert.match(GOVERNANCE_PACK_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('checksum is stable for same content', () => {
    const a = computePackChecksum();
    const b = computePackChecksum();
    assert.strictEqual(a, b);
  });

  it('checksum is a 12-char hex string', () => {
    const checksum = computePackChecksum();
    assert.match(checksum, /^[0-9a-f]{12}$/);
  });

  it('collaboration standards reference shared-rules and skills', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('shared-rules.md'));
    assert.ok(block.includes('cat-cafe-skills'));
  });

  it('pack version is 1.2.0', () => {
    assert.equal(GOVERNANCE_PACK_VERSION, '1.2.0');
  });
});
